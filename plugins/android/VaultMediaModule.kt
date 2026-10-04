package com.vaultchat.app.vaultview

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * VaultView / VaultCheck pixel work — Android.
 *
 * Two jobs that both need raw pixels, which RN cannot reach from JS:
 *
 *  1. embedTrackingId / extractTrackingId — the steganographic recipient ID.
 *  2. sampleVideoChannels — per-frame skin-region colour means for VaultCheck's
 *     rPPG heartbeat analysis.
 *
 * ── How the watermark actually works, and what it survives ──
 *
 * Pair-wise block-mean luminance modulation. The image is cut into 16×16 blocks
 * in raster order; blocks are taken two at a time, and each pair carries one
 * payload bit as the SIGN of (meanA − meanB), forced apart by DELTA. The 64-bit
 * payload repeats across every pair in the image, and extraction majority-votes
 * per bit position.
 *
 * Self-referencing (a pair is compared against itself, not an absolute value) is
 * what makes it hold up: global brightness, contrast, gamma and JPEG re-encode
 * shift both blocks of a pair together and cancel out.
 *
 * SURVIVES:  JPEG re-encode (q≥60), brightness/contrast/gamma, moderate noise,
 *            and cropping — because the payload repeats, any surviving region
 *            with ~128 blocks still decodes.
 * DOES NOT:  rescaling, rotation, or heavy blur — all of which move or destroy
 *            the 16-px block grid, so the pairs no longer line up. A rescaled
 *            leak will report `found: false`, NOT a wrong ID: the CRC gate below
 *            makes a false positive vanishingly unlikely, which is the property
 *            that matters when the output would accuse a specific person.
 *
 * That limitation is real and must not be papered over in the product copy. This
 * traces the common case (screenshot → forward → re-upload) and does not claim
 * to be an adversarial-grade forensic watermark.
 */
class VaultMediaModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "VaultViewMedia"

    private val block = 16          // px per block edge
    private val delta = 3           // luminance separation forced per pair (0-255)
    private val payloadBits = 64    // 48-bit id + 16-bit CRC

    // ── payload helpers ──────────────────────────────────────

    /** CRC-16/CCITT-FALSE over the 6 id bytes. */
    private fun crc16(data: ByteArray): Int {
        var crc = 0xFFFF
        for (b in data) {
            crc = crc xor ((b.toInt() and 0xFF) shl 8)
            repeat(8) {
                crc = if (crc and 0x8000 != 0) ((crc shl 1) xor 0x1021) and 0xFFFF
                      else (crc shl 1) and 0xFFFF
            }
        }
        return crc and 0xFFFF
    }

    /** 12 hex chars (48-bit id) → 64 payload bits with CRC appended. */
    private fun bitsFromHex(idHex: String): BooleanArray? {
        val clean = idHex.trim().lowercase()
        if (clean.length != 12 || !clean.all { it.isDigit() || it in 'a'..'f' }) return null
        val id = ByteArray(6)
        for (i in 0 until 6) id[i] = clean.substring(i * 2, i * 2 + 2).toInt(16).toByte()
        val crc = crc16(id)
        val bits = BooleanArray(payloadBits)
        for (i in 0 until 48) {
            val byte = id[i / 8].toInt() and 0xFF
            bits[i] = (byte shr (7 - (i % 8))) and 1 == 1
        }
        for (i in 0 until 16) bits[48 + i] = (crc shr (15 - i)) and 1 == 1
        return bits
    }

    /** Inverse of bitsFromHex; null when the CRC does not check out. */
    private fun hexFromBits(bits: BooleanArray): String? {
        val id = ByteArray(6)
        for (i in 0 until 48) if (bits[i]) {
            id[i / 8] = (id[i / 8].toInt() or (1 shl (7 - (i % 8)))).toByte()
        }
        var crc = 0
        for (i in 0 until 16) if (bits[48 + i]) crc = crc or (1 shl (15 - i))
        if (crc != crc16(id)) return null
        return id.joinToString("") { "%02x".format(it) }
    }

    private fun luma(p: Int): Int {
        val r = (p shr 16) and 0xFF; val g = (p shr 8) and 0xFF; val b = p and 0xFF
        return (r * 299 + g * 587 + b * 114) / 1000
    }

    // ── embed ────────────────────────────────────────────────

    @ReactMethod
    fun embedTrackingId(srcPath: String, dstPath: String, idHex: String, quality: Int, promise: Promise) {
        try {
            val bits = bitsFromHex(idHex)
                ?: run { promise.reject("bad_id", "idHex must be 12 hex chars (48-bit id)"); return }

            val src = BitmapFactory.decodeFile(srcPath.removePrefix("file://"))
                ?: run { promise.reject("decode_failed", "could not decode $srcPath"); return }
            val w = src.width; val h = src.height
            val bx = w / block; val by = h / block
            if (bx * by < 128) {
                // Fewer than one full payload repetition — embedding would produce
                // something that cannot be decoded. Fail loudly instead.
                src.recycle()
                promise.reject("too_small", "image must be at least 128 blocks (${block}px) to carry the id")
                return
            }

            val px = IntArray(w * h)
            src.getPixels(px, 0, w, 0, 0, w, h)
            src.recycle()

            val pairs = (bx * by) / 2
            for (k in 0 until pairs) {
                val bit = bits[k % payloadBits]
                val ia = 2 * k; val ib = 2 * k + 1
                val ma = blockMean(px, w, ia, bx)
                val mb = blockMean(px, w, ib, bx)
                val diff = ma - mb
                val want = if (bit) delta else -delta
                // Already separated the right way with margin → leave it alone,
                // which keeps the image closer to the original.
                if ((bit && diff >= want) || (!bit && diff <= want)) continue
                val shift = (want - diff) / 2
                shiftBlock(px, w, h, ia, bx, shift)
                shiftBlock(px, w, h, ib, bx, -shift)
            }

            val out = Bitmap.createBitmap(px, w, h, Bitmap.Config.ARGB_8888)
            val dst = File(dstPath.removePrefix("file://"))
            dst.parentFile?.mkdirs()
            FileOutputStream(dst).use { fos ->
                out.compress(Bitmap.CompressFormat.JPEG, if (quality in 1..100) quality else 92, fos)
            }
            out.recycle()
            promise.resolve(true)
        } catch (e: Throwable) {
            promise.reject("embed_failed", e.message, e)
        }
    }

    private fun blockMean(px: IntArray, w: Int, blockIndex: Int, bx: Int): Int {
        val col = blockIndex % bx; val row = blockIndex / bx
        var sum = 0
        for (y in 0 until block) {
            val base = (row * block + y) * w + col * block
            for (x in 0 until block) sum += luma(px[base + x])
        }
        return sum / (block * block)
    }

    private fun shiftBlock(px: IntArray, w: Int, h: Int, blockIndex: Int, bx: Int, shift: Int) {
        if (shift == 0) return
        val col = blockIndex % bx; val row = blockIndex / bx
        for (y in 0 until block) {
            val yy = row * block + y
            if (yy >= h) return
            val base = yy * w + col * block
            for (x in 0 until block) {
                val i = base + x
                val p = px[i]
                val a = p and -0x1000000
                val r = ((p shr 16) and 0xFF).plus(shift).coerceIn(0, 255)
                val g = ((p shr 8) and 0xFF).plus(shift).coerceIn(0, 255)
                val b = (p and 0xFF).plus(shift).coerceIn(0, 255)
                px[i] = a or (r shl 16) or (g shl 8) or b
            }
        }
    }

    // ── extract ──────────────────────────────────────────────

    @ReactMethod
    fun extractTrackingId(srcPath: String, promise: Promise) {
        try {
            val src = BitmapFactory.decodeFile(srcPath.removePrefix("file://"))
                ?: run { promise.reject("decode_failed", "could not decode $srcPath"); return }
            val w = src.width; val h = src.height
            val bx = w / block; val by = h / block
            val result = Arguments.createMap()
            if (bx * by < 128) {
                src.recycle()
                result.putBoolean("found", false)
                result.putString("reason", "too_small")
                promise.resolve(result); return
            }
            val px = IntArray(w * h)
            src.getPixels(px, 0, w, 0, 0, w, h)
            src.recycle()

            val votes = IntArray(payloadBits)
            val pairs = (bx * by) / 2
            for (k in 0 until pairs) {
                val diff = blockMean(px, w, 2 * k, bx) - blockMean(px, w, 2 * k + 1, bx)
                votes[k % payloadBits] += if (diff > 0) 1 else if (diff < 0) -1 else 0
            }
            val bits = BooleanArray(payloadBits) { votes[it] > 0 }
            val hex = hexFromBits(bits)

            if (hex == null) {
                // CRC failed → say so. Never return a best-guess id: the output of
                // this function names a person.
                result.putBoolean("found", false)
                result.putString("reason", "crc_mismatch")
                promise.resolve(result); return
            }
            // Confidence = mean vote margin normalised by repetitions, so a
            // heavily-degraded image that still passes CRC reports as weak.
            val reps = pairs / payloadBits.toDouble()
            val margin = votes.map { kotlin.math.abs(it) }.average() / kotlin.math.max(1.0, reps)
            result.putBoolean("found", true)
            result.putString("id", hex)
            result.putDouble("confidence", margin.coerceIn(0.0, 1.0))
            promise.resolve(result)
        } catch (e: Throwable) {
            promise.reject("extract_failed", e.message, e)
        }
    }

    // ── rPPG frame sampling ──────────────────────────────────

    /**
     * Sample per-frame mean R/G/B over a normalised region of interest.
     *
     * rPPG needs an evenly-spaced time series across a face region; the pulse
     * band is 0.7–3 Hz, so JS should ask for ≥8 fps to stay clear of Nyquist.
     * Returns [{ tMs, r, g, b }]. Frames the decoder cannot produce are skipped
     * rather than interpolated — JS must check the spacing it actually got.
     */
    // Sampling runs on its own thread: every @ReactMethod of every module shares
    // one native-modules thread, so a cancelSampling() queued behind a running
    // sample would only arrive after it finished. Single thread = samples still
    // run one at a time, as before.
    private val sampler = Executors.newSingleThreadExecutor()
    // Bumped by cancelSampling(). A sample captures it when JS calls, so a
    // cancel stops the running sample and any queued behind it, and never
    // touches a sample requested afterwards.
    private val sampleGen = AtomicInteger(0)

    /** Stop sampleVideoChannels between frames; it rejects with "cancelled". */
    @ReactMethod
    fun cancelSampling() {
        sampleGen.incrementAndGet()
    }

    @ReactMethod
    fun sampleVideoChannels(
        path: String, startMs: Double, endMs: Double, frames: Int,
        roiX: Double, roiY: Double, roiW: Double, roiH: Double,
        promise: Promise,
    ) {
        val gen = sampleGen.get()
        try {
            sampler.execute { sampleVideoChannelsOn(gen, path, startMs, endMs, frames, roiX, roiY, roiW, roiH, promise) }
        } catch (e: Throwable) {
            promise.reject("sample_failed", e.message, e)   // executor shut down (module invalidated)
        }
    }

    private fun sampleVideoChannelsOn(
        gen: Int, path: String, startMs: Double, endMs: Double, frames: Int,
        roiX: Double, roiY: Double, roiW: Double, roiH: Double,
        promise: Promise,
    ) {
        if (sampleGen.get() != gen) { promise.reject("cancelled", "cancelled"); return }
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(path.removePrefix("file://"))
            val out = Arguments.createArray()
            val n = frames.coerceIn(2, 300)
            val step = (endMs - startMs) / (n - 1)
            for (i in 0 until n) {
                if (sampleGen.get() != gen) { promise.reject("cancelled", "cancelled"); return }
                val tMs = startMs + step * i
                val frame = retriever.getFrameAtTime(
                    (tMs * 1000).toLong(), MediaMetadataRetriever.OPTION_CLOSEST,
                ) ?: continue
                val w = frame.width; val h = frame.height
                val x0 = (roiX * w).toInt().coerceIn(0, w - 1)
                val y0 = (roiY * h).toInt().coerceIn(0, h - 1)
                val rw = (roiW * w).toInt().coerceIn(1, w - x0)
                val rh = (roiH * h).toInt().coerceIn(1, h - y0)
                val buf = IntArray(rw * rh)
                frame.getPixels(buf, 0, rw, x0, y0, rw, rh)
                frame.recycle()
                var sr = 0L; var sg = 0L; var sb = 0L
                for (p in buf) {
                    sr += (p shr 16) and 0xFF; sg += (p shr 8) and 0xFF; sb += p and 0xFF
                }
                val count = buf.size.toDouble()
                out.pushMap(Arguments.createMap().apply {
                    putDouble("tMs", tMs)
                    putDouble("r", sr / count)
                    putDouble("g", sg / count)
                    putDouble("b", sb / count)
                })
            }
            promise.resolve(out)
        } catch (e: Throwable) {
            promise.reject("sample_failed", e.message, e)
        } finally {
            try { retriever.release() } catch (_: Throwable) {}
        }
    }

    override fun invalidate() {
        sampleGen.incrementAndGet()
        sampler.shutdown()
        super.invalidate()
    }
}
