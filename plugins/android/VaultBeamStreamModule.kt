package com.vaultchat.app.vaultbeam

import android.content.Context
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.IOException
import java.io.FileInputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.security.MessageDigest
import java.util.Collections
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * VaultBeamStream — the load-bearing native byte pipeline for VaultBeam Tier-3
 * (Cloudflare R2 relay). It is the reason 12 GB works where the JS-heap path OOMs
 * at ~2 GB: JS never holds a file byte. JS holds only {blockIndex, presigned url};
 * this module does the positional file I/O, the per-chunk AES-256-GCM, and the
 * HTTP PUT/GET, all off the JS thread.
 *
 * The relay never sees plaintext: every 512 KiB chunk is AES-256-GCM sealed here
 * before it leaves the device, and verified here on the way in. Wire + geometry
 * are byte-identical to lib/vaultbeamRelay.ts and routes/vaultbeam.js so a chunk
 * sealed on any tier opens on any tier:
 *
 *   BLOCK  = the R2 object (default 4 MiB = 8 chunks); one presigned URL per block.
 *   CHUNK  = 512 KiB logical unit (AES-GCM + resume granularity). The last block
 *            may hold fewer than 8 chunks; the last chunk may be < 512 KiB.
 *   nonce  = 4B(transferId UTF-8 prefix) ‖ u64_be(globalChunkIndex)
 *   aad    = "transferId|fileId|globalChunkIndex" (UTF-8)
 *   wire   = ciphertext ‖ 16B GCM tag  (Java's doFinal appends the tag)
 *
 * All geometry is recomputed from (blockIndex, chunkBytes, blockBytes, chunkCount,
 * totalBytes) on both sides, so the split on download mirrors the pack on upload
 * exactly — no per-chunk length metadata rides the wire.
 */
class VaultBeamStreamModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    // Bounded I/O pool: file + network work never touches the JS/main thread
    // (networking on the main thread throws NetworkOnMainThreadException anyway).
    private val io = Executors.newFixedThreadPool(4)

    override fun getName() = "VaultBeamStream"

    // Strip a file:// URI down to a filesystem path (RandomAccessFile needs a path,
    // not a URI). Callers pass app-owned cache/file paths, never content:// URIs.

    /**
     * Positional reader over the transfer SOURCE, which may be a local path or
     * a `content://` URI.
     *
     * WHY THIS EXISTS
     * ---------------
     * DocumentPicker used copyToCacheDirectory=true, so a picked file was
     * DUPLICATED into app cache before the transfer began. For a 12 GB send
     * that means 12 GB of free space on top of the original and a long silent
     * copy — which is why the nominal 12 GB ceiling was unreachable in
     * practice, and why Android could evict the copy mid-transfer.
     *
     * Reading the picked URI directly removes the duplicate entirely. A
     * content:// URI cannot be opened by RandomAccessFile, so it goes through
     * ContentResolver.openFileDescriptor and a FileChannel instead.
     *
     * Positional reads (`FileChannel.read(buf, position)`) rather than
     * seek+read: they do not move the channel position, so concurrent chunk
     * reads on the IO pool cannot interleave into each other's offsets. That
     * matters here because the upload pool reads several blocks at once.
     */
    private class SrcReader(ctx: Context, spec: String) : java.io.Closeable {
        private val pfd: ParcelFileDescriptor?
        private val raf: RandomAccessFile?
        private val fis: FileInputStream?
        private val ch: FileChannel

        init {
            if (spec.startsWith("content://")) {
                pfd = ctx.contentResolver.openFileDescriptor(Uri.parse(spec), "r")
                    ?: throw IOException("cannot open $spec")
                fis = FileInputStream(pfd.fileDescriptor)
                raf = null
                ch = fis.channel
            } else {
                pfd = null
                fis = null
                raf = RandomAccessFile(if (spec.startsWith("file://")) spec.substring(7) else spec, "r")
                ch = raf.channel
            }
        }

        fun size(): Long = ch.size()

        /** Fill dst[0..len) from `position`. Throws if the source ends early. */
        fun readAt(position: Long, dst: ByteArray, len: Int) {
            val buf = ByteBuffer.wrap(dst, 0, len)
            var pos = position
            while (buf.hasRemaining()) {
                val n = ch.read(buf, pos)
                if (n <= 0) throw IOException("short read at $pos")
                pos += n.toLong()
            }
        }

        override fun close() {
            try { ch.close() } catch (_: Throwable) {}
            try { fis?.close() } catch (_: Throwable) {}
            try { raf?.close() } catch (_: Throwable) {}
            try { pfd?.close() } catch (_: Throwable) {}
        }
    }

    private fun fsPath(p: String) = if (p.startsWith("file://")) p.substring(7) else p

    // nonce = 4B transferId prefix ‖ u64 big-endian globalChunkIndex (matches JS).
    private fun chunkNonce(transferId: String, globalChunk: Long): ByteArray {
        val n = ByteArray(12)
        val tb = transferId.toByteArray(Charsets.UTF_8)
        System.arraycopy(tb, 0, n, 0, minOf(4, tb.size))
        val hi = (globalChunk ushr 32).toInt()
        val lo = globalChunk.toInt()
        n[4] = (hi ushr 24).toByte(); n[5] = (hi ushr 16).toByte(); n[6] = (hi ushr 8).toByte(); n[7] = hi.toByte()
        n[8] = (lo ushr 24).toByte(); n[9] = (lo ushr 16).toByte(); n[10] = (lo ushr 8).toByte(); n[11] = lo.toByte()
        return n
    }

    // Chunk-identity scheme — MUST match services/vaultbeam/rust/src/chunk.rs IdScheme
    // and the golden vectors. "canonical" (vbm3) makes a chunk's id its GLOBAL LOGICAL
    // INDEX on every transport, which is what lets one resume bitmap span LAN, P2P and
    // the relay. The other two only read data written by older clients during the
    // one-release dual-read window.
    private fun schemeOf(opts: ReadableMap): String {
        val explicit = if (opts.hasKey("idScheme")) opts.getString("idScheme") else null
        if (explicit != null) return explicit
        return if (opts.hasKey("blockPlainOffset")) "legacyOffset" else "uniform"
    }

    // Optional `runs` ([{start,count}, …]) selects WHICH chunks stream, for resume.
    // Absent ⇒ the whole file, byte-identical to the pre-resume behaviour. The LAN
    // frame format is unchanged — each frame already carries its index, so a
    // subset needs no new framing.
    private fun runIndices(opts: ReadableMap, chunkCount: Int): LongArray {
        if (!opts.hasKey("runs")) return LongArray(chunkCount) { it.toLong() }
        val arr = opts.getArray("runs") ?: return LongArray(chunkCount) { it.toLong() }
        val out = ArrayList<Long>()
        for (i in 0 until arr.size()) {
            val r = arr.getMap(i) ?: continue
            val start = r.getDouble("start").toLong()
            val count = r.getDouble("count").toLong()
            var g = start
            while (g < start + count) {
                if (g in 0 until chunkCount) out.add(g)
                g++
            }
        }
        return out.toLongArray()
    }

    private fun chunkIdFor(scheme: String, firstChunk: Long, i: Int, plainOffset: Long, chunkBytes: Int): Long =
        when (scheme) {
            "canonical" -> plainOffset / chunkBytes
            "legacyOffset" -> plainOffset
            else -> firstChunk + i
        }

    private fun gcm(mode: Int, keyBytes: ByteArray, nonce: ByteArray, aad: ByteArray): Cipher {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(mode, SecretKeySpec(keyBytes, "AES"), GCMParameterSpec(128, nonce))
        c.updateAAD(aad)
        return c
    }

    // Preallocate the destination shell so out-of-order positional block writes
    // (and resume across restarts) land at the right offsets.
    @ReactMethod
    fun prealloc(path: String, totalBytes: Double, promise: Promise) {
        io.execute {
            try {
                val f = File(fsPath(path)); f.parentFile?.mkdirs()
                RandomAccessFile(f, "rw").use { it.setLength(totalBytes.toLong()) }
                promise.resolve(true)
            } catch (e: Throwable) { promise.reject("prealloc", e) }
        }
    }

    /**
     * SENDER: read this block's 512 KiB chunks from srcPath @ their offsets, seal
     * each with AES-256-GCM, and stream the concatenated ciphertext to the block's
     * presigned R2 PUT URL. Resolves the uploaded byte length.
     *
     * opts: url, srcPath, keyB64, transferId, fileId, blockIndex, chunkBytes,
     *       blockBytes, chunkCount, totalBytes
     */
    @ReactMethod
    fun uploadBlock(opts: ReadableMap, promise: Promise) {
        io.execute {
            try {
                val url = opts.getString("url")!!
                val srcPath = fsPath(opts.getString("srcPath")!!)
                val keyBytes = Base64.decode(opts.getString("keyB64"), Base64.DEFAULT)
                val transferId = opts.getString("transferId")!!
                val fileId = opts.getString("fileId")!!
                val blockIndex = opts.getInt("blockIndex")
                val chunkBytes = opts.getInt("chunkBytes")
                val blockBytes = opts.getInt("blockBytes")
                val chunkCount = opts.getInt("chunkCount")
                val totalBytes = opts.getDouble("totalBytes").toLong()
                val chunksPerBlock = blockBytes / chunkBytes
                val firstChunk = blockIndex.toLong() * chunksPerBlock
                // Segmented geometry (R4): when blockPlainOffset is supplied the chunk
                // IDENTITY (AAD + nonce) is its PLAINTEXT BYTE OFFSET — stable even when
                // per-segment chunk sizes differ. Absent → legacy uniform path, which is
                // byte-identical to before (offset = blockIndex*blockBytes, id = g).
                val offsetScheme = opts.hasKey("blockPlainOffset")
                val scheme = schemeOf(opts)
                val blockPlainOffset = if (offsetScheme) opts.getDouble("blockPlainOffset").toLong()
                                       else blockIndex.toLong() * blockBytes

                // Seal each chunk into memory (≤ block + 8·16B overhead). Bounded —
                // never the whole file — which is the entire point of the native path.
                val parts = ArrayList<ByteArray>(chunksPerBlock)
                SrcReader(reactApplicationContext, srcPath).use { src ->
                    var i = 0
                    while (i < chunksPerBlock) {
                        val plainOffset = blockPlainOffset + i.toLong() * chunkBytes
                        if (plainOffset >= totalBytes) break
                        val id = chunkIdFor(scheme, firstChunk, i, plainOffset, chunkBytes)
                        val plainLen = minOf(chunkBytes.toLong(), totalBytes - plainOffset).toInt()
                        val plain = ByteArray(plainLen)
                        src.readAt(plainOffset, plain, plainLen)
                        val aad = "$transferId|$fileId|$id".toByteArray(Charsets.UTF_8)
                        parts.add(gcm(Cipher.ENCRYPT_MODE, keyBytes, chunkNonce(transferId, id), aad).doFinal(plain))
                        i++
                    }
                }

                val bodyLen = parts.sumOf { it.size }
                val conn = URL(url).openConnection() as HttpURLConnection
                try {
                    conn.requestMethod = "PUT"
                    conn.doOutput = true
                    conn.setRequestProperty("Content-Type", "application/octet-stream") // must match the presigned ContentType
                    conn.setFixedLengthStreamingMode(bodyLen)                            // stream, don't buffer the block
                    conn.connectTimeout = 30_000; conn.readTimeout = 120_000
                    conn.outputStream.use { os -> for (p in parts) os.write(p) }
                    val code = conn.responseCode
                    if (code in 200..299) promise.resolve(bodyLen.toDouble())
                    else promise.reject("upload_http_$code", "PUT block $blockIndex failed: $code")
                } finally { conn.disconnect() }
            } catch (e: Throwable) { promise.reject("upload", e) }
        }
    }

    /**
     * RECIPIENT: GET the block's presigned R2 URL, split the body back into its
     * per-chunk ciphertexts by recomputing the same geometry, AES-256-GCM verify +
     * open each, and write the plaintext to dstPath @ its offset. A tampered or
     * truncated block throws (AEADBadTag / short-body) and the block is not marked.
     * Resolves the number of chunks written.
     */
    @ReactMethod
    fun downloadBlock(opts: ReadableMap, promise: Promise) {
        io.execute {
            try {
                val url = opts.getString("url")!!
                val dstPath = fsPath(opts.getString("dstPath")!!)
                val keyBytes = Base64.decode(opts.getString("keyB64"), Base64.DEFAULT)
                val transferId = opts.getString("transferId")!!
                val fileId = opts.getString("fileId")!!
                val blockIndex = opts.getInt("blockIndex")
                val chunkBytes = opts.getInt("chunkBytes")
                val blockBytes = opts.getInt("blockBytes")
                val chunkCount = opts.getInt("chunkCount")
                val totalBytes = opts.getDouble("totalBytes").toLong()
                val chunksPerBlock = blockBytes / chunkBytes
                val firstChunk = blockIndex.toLong() * chunksPerBlock
                // Segmented geometry (R4) — mirror uploadBlock exactly, or the AAD/nonce
                // won't match and every chunk fails to open.
                val offsetScheme = opts.hasKey("blockPlainOffset")
                val scheme = schemeOf(opts)
                val blockPlainOffset = if (offsetScheme) opts.getDouble("blockPlainOffset").toLong()
                                       else blockIndex.toLong() * blockBytes

                val conn = URL(url).openConnection() as HttpURLConnection
                val body: ByteArray
                try {
                    conn.requestMethod = "GET"
                    conn.connectTimeout = 30_000; conn.readTimeout = 120_000
                    val code = conn.responseCode
                    if (code !in 200..299) { promise.reject("download_http_$code", "GET block $blockIndex failed: $code"); return@execute }
                    body = BufferedInputStream(conn.inputStream).use { it.readBytes() }
                } finally { conn.disconnect() }

                RandomAccessFile(dstPath, "rw").use { raf ->
                    var off = 0; var i = 0; var written = 0
                    while (i < chunksPerBlock) {
                        val plainOffset = blockPlainOffset + i.toLong() * chunkBytes
                        if (plainOffset >= totalBytes) break
                        val id = chunkIdFor(scheme, firstChunk, i, plainOffset, chunkBytes)
                        val plainLen = minOf(chunkBytes.toLong(), totalBytes - plainOffset).toInt()
                        val ctLen = plainLen + 16 // + GCM tag
                        if (off + ctLen > body.size) throw IllegalStateException("short block body for block $blockIndex")
                        val ct = body.copyOfRange(off, off + ctLen)
                        val aad = "$transferId|$fileId|$id".toByteArray(Charsets.UTF_8)
                        val plain = gcm(Cipher.DECRYPT_MODE, keyBytes, chunkNonce(transferId, id), aad).doFinal(ct)
                        raf.seek(plainOffset); raf.write(plain)
                        off += ctLen; written++; i++
                    }
                    promise.resolve(written.toDouble())
                }
            } catch (e: Throwable) { promise.reject("download", e) }
        }
    }

    // Whole-file SHA-256 (hex) for the recipient's post-assembly integrity check
    // against the expected hash delivered over E2EE. Streamed — no full read.
    @ReactMethod
    fun sha256(path: String, promise: Promise) {
        io.execute {
            try {
                val md = MessageDigest.getInstance("SHA-256")
                // Streamed in 1 MiB windows, never whole-file: this hashes the
                // SOURCE, which for a 12 GB send is the picked content:// URI.
                SrcReader(reactApplicationContext, path).use { src ->
                    val total = src.size()
                    val buf = ByteArray(1 shl 20)
                    var pos = 0L
                    while (pos < total) {
                        val n = minOf(buf.size.toLong(), total - pos).toInt()
                        src.readAt(pos, buf, n)
                        md.update(buf, 0, n)
                        pos += n.toLong()
                    }
                }
                promise.resolve(md.digest().joinToString("") { "%02x".format(it) })
            } catch (e: Throwable) { promise.reject("sha256", e) }
        }
    }

    @ReactMethod
    fun deleteFile(path: String, promise: Promise) {
        io.execute {
            try { promise.resolve(File(fsPath(path)).delete()) } catch (e: Throwable) { promise.reject("delete", e) }
        }
    }

    // ── Event emitter (native-driven LAN progress) ──────────────────
    private fun emitEvent(name: String, params: WritableMap) {
        try {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(name, params)
        } catch (_: Throwable) {}
    }
    // NativeEventEmitter requires these to exist (no-ops for the classic bridge).
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}

    // ── P2 (WebRTC) — per-chunk cipher primitives ───────────────────
    // The datachannel is a JS API, so JS shuttles ONE chunk's ciphertext at a
    // time (≤512 KiB) between native and the wire — never the whole file. Crypto
    // stays native (single source of truth); the wire format is identical to the
    // R2 block path, so a chunk sealed for any tier opens on any tier.

    // Seal chunk[chunkIndex] from srcPath → base64 ciphertext for JS to fragment
    // over the datachannel.
    @ReactMethod
    fun readCipherChunk(opts: ReadableMap, promise: Promise) {
        io.execute {
            try {
                val srcPath = fsPath(opts.getString("srcPath")!!)
                val keyBytes = Base64.decode(opts.getString("keyB64"), Base64.DEFAULT)
                val transferId = opts.getString("transferId")!!
                val fileId = opts.getString("fileId")!!
                val g = opts.getDouble("chunkIndex").toLong()
                val chunkBytes = opts.getInt("chunkBytes")
                val chunkCount = opts.getInt("chunkCount")
                val totalBytes = opts.getDouble("totalBytes").toLong()
                if (g < 0 || g >= chunkCount) { promise.reject("range", "chunk $g out of range"); return@execute }
                val plainOffset = g * chunkBytes.toLong()
                val plainLen = minOf(chunkBytes.toLong(), totalBytes - plainOffset).toInt()
                val plain = ByteArray(plainLen)
                SrcReader(reactApplicationContext, srcPath).use { it.readAt(plainOffset, plain, plainLen) }
                val aad = "$transferId|$fileId|$g".toByteArray(Charsets.UTF_8)
                val ct = gcm(Cipher.ENCRYPT_MODE, keyBytes, chunkNonce(transferId, g), aad).doFinal(plain)
                promise.resolve(Base64.encodeToString(ct, Base64.NO_WRAP))
            } catch (e: Throwable) { promise.reject("readCipherChunk", e) }
        }
    }

    // Verify+open a base64 ciphertext chunk and write plaintext @ its offset.
    @ReactMethod
    fun writeCipherChunk(opts: ReadableMap, promise: Promise) {
        io.execute {
            try {
                val dstPath = fsPath(opts.getString("dstPath")!!)
                val keyBytes = Base64.decode(opts.getString("keyB64"), Base64.DEFAULT)
                val transferId = opts.getString("transferId")!!
                val fileId = opts.getString("fileId")!!
                val g = opts.getDouble("chunkIndex").toLong()
                val chunkBytes = opts.getInt("chunkBytes")
                val chunkCount = opts.getInt("chunkCount")
                val ct = Base64.decode(opts.getString("ctB64"), Base64.DEFAULT)
                if (g < 0 || g >= chunkCount) { promise.reject("range", "chunk $g out of range"); return@execute }
                val plainOffset = g * chunkBytes.toLong()
                val aad = "$transferId|$fileId|$g".toByteArray(Charsets.UTF_8)
                val plain = gcm(Cipher.DECRYPT_MODE, keyBytes, chunkNonce(transferId, g), aad).doFinal(ct)
                RandomAccessFile(dstPath, "rw").use { it.seek(plainOffset); it.write(plain) }
                promise.resolve(plain.size.toDouble())
            } catch (e: Throwable) { promise.reject("writeCipherChunk", e) }
        }
    }

    // ── P3 (LAN) — direct TCP transport (native owns socket + file) ──
    // Same-LAN peers skip the cloud entirely. The sender binds a server, the
    // receiver connects, they authenticate with a shared token (delivered inside
    // the E2EE manifest — an outsider on the LAN can't guess it), and the sender
    // streams AES-256-GCM chunks straight from disk to socket. Zero JS heap;
    // progress is emitted as vbLanProgress events.
    //
    // Wire: receiver → [16B token]; sender → repeated [i32 index][i32 ctLen][ct].

    // The device's site-local IPv4 (advertised to the peer via signaling).
    @ReactMethod
    fun lanIp(promise: Promise) {
        try {
            var result: String? = null
            for (nif in Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nif.isUp || nif.isLoopback) continue
                for (addr in Collections.list(nif.inetAddresses)) {
                    if (addr is Inet4Address && addr.isSiteLocalAddress) { result = addr.hostAddress; break }
                }
                if (result != null) break
            }
            promise.resolve(result)
        } catch (e: Throwable) { promise.reject("lanIp", e) }
    }

    // SENDER: bind a TCP server (emit vbLanBound with the port so JS can advertise
    // it), accept the peer, verify the token, then stream every chunk. Resolves
    // with the chunk count on success.
    @ReactMethod
    fun lanServe(opts: ReadableMap, promise: Promise) {
        io.execute {
            var server: ServerSocket? = null
            var sock: Socket? = null
            try {
                val srcPath = fsPath(opts.getString("srcPath")!!)
                val keyBytes = Base64.decode(opts.getString("keyB64"), Base64.DEFAULT)
                val transferId = opts.getString("transferId")!!
                val fileId = opts.getString("fileId")!!
                val token = Base64.decode(opts.getString("token"), Base64.DEFAULT)
                val chunkBytes = opts.getInt("chunkBytes")
                val chunkCount = opts.getInt("chunkCount")
                val totalBytes = opts.getDouble("totalBytes").toLong()

                server = ServerSocket(if (opts.hasKey("port")) opts.getInt("port") else 0)
                server.soTimeout = 45_000 // wait up to 45s for the peer to dial in
                val bound = Arguments.createMap()
                bound.putString("transferId", transferId); bound.putInt("port", server.localPort)
                emitEvent("vbLanBound", bound)

                sock = server.accept()
                sock.tcpNoDelay = true
                sock.soTimeout = 60_000 // guards the token + ack reads
                val ins = DataInputStream(BufferedInputStream(sock.getInputStream()))
                val out = DataOutputStream(BufferedOutputStream(sock.getOutputStream()))

                val recvTok = ByteArray(token.size); ins.readFully(recvTok)
                if (!recvTok.contentEquals(token)) { promise.reject("lan_auth", "bad token"); return@execute }

                val indices = runIndices(opts, chunkCount)
                val expected = indices.size
                SrcReader(reactApplicationContext, srcPath).use { src ->
                    for (n in indices.indices) {
                        val g = indices[n]
                        val plainOffset = g * chunkBytes.toLong()
                        val plainLen = minOf(chunkBytes.toLong(), totalBytes - plainOffset).toInt()
                        val plain = ByteArray(plainLen)
                        src.readAt(plainOffset, plain, plainLen)
                        val aad = "$transferId|$fileId|$g".toByteArray(Charsets.UTF_8)
                        val ct = gcm(Cipher.ENCRYPT_MODE, keyBytes, chunkNonce(transferId, g), aad).doFinal(plain)
                        out.writeInt(g.toInt()); out.writeInt(ct.size); out.write(ct)
                        if ((n % 16) == 0) {
                            out.flush()
                            val p = Arguments.createMap()
                            p.putString("transferId", transferId); p.putInt("done", n + 1); p.putInt("total", expected)
                            emitEvent("vbLanProgress", p)
                        }
                    }
                    out.flush()
                }
                // Wait for the receiver's 1-byte delivery ack — written only after
                // it has decrypted + persisted EVERY chunk — before declaring the
                // transfer delivered. Without this the sender could report success
                // while the receiver's last write failed.
                val ack = ins.read()
                if (ack == 1) promise.resolve(expected.toDouble())
                else promise.reject("lan_noack", "receiver did not confirm delivery")
            } catch (e: Throwable) { promise.reject("lanServe", e) }
            finally { try { sock?.close() } catch (_: Throwable) {}; try { server?.close() } catch (_: Throwable) {} }
        }
    }

    // RECEIVER: connect to the sender, send the token, then verify+write every
    // streamed chunk to dstPath @ its offset. Resolves with the chunk count.
    @ReactMethod
    fun lanConnect(opts: ReadableMap, promise: Promise) {
        io.execute {
            var sock: Socket? = null
            try {
                val host = opts.getString("host")!!
                val port = opts.getInt("port")
                val dstPath = fsPath(opts.getString("dstPath")!!)
                val keyBytes = Base64.decode(opts.getString("keyB64"), Base64.DEFAULT)
                val transferId = opts.getString("transferId")!!
                val fileId = opts.getString("fileId")!!
                val token = Base64.decode(opts.getString("token"), Base64.DEFAULT)
                val chunkBytes = opts.getInt("chunkBytes")
                val chunkCount = opts.getInt("chunkCount")

                sock = Socket()
                sock.connect(InetSocketAddress(host, port), 5_000) // 5s → fails fast when not same-LAN
                sock.soTimeout = 60_000
                sock.tcpNoDelay = true
                val ins = DataInputStream(BufferedInputStream(sock.getInputStream()))
                val out = DataOutputStream(sock.getOutputStream())
                out.write(token); out.flush()

                val expected = runIndices(opts, chunkCount).size
                RandomAccessFile(dstPath, "rw").use { raf ->
                    var received = 0
                    while (received < expected) {
                        val idx = ins.readInt().toLong()
                        val ctLen = ins.readInt()
                        if (ctLen < 16 || ctLen > chunkBytes + 64) throw IOException("bad frame len $ctLen")
                        val ct = ByteArray(ctLen); ins.readFully(ct)
                        val plainOffset = idx * chunkBytes.toLong()
                        val aad = "$transferId|$fileId|$idx".toByteArray(Charsets.UTF_8)
                        val plain = gcm(Cipher.DECRYPT_MODE, keyBytes, chunkNonce(transferId, idx), aad).doFinal(ct)
                        raf.seek(plainOffset); raf.write(plain)
                        received++
                        if ((received % 16) == 0) {
                            val p = Arguments.createMap()
                            p.putString("transferId", transferId); p.putInt("done", received); p.putInt("total", expected)
                            emitEvent("vbLanProgress", p)
                        }
                    }
                }
                // Every chunk is decrypted + on disk (the RandomAccessFile is closed)
                // → send the 1-byte delivery ack so the sender can declare success.
                out.write(1); out.flush()
                promise.resolve(expected.toDouble())
            } catch (e: Throwable) { promise.reject("lanConnect", e) }
            finally { try { sock?.close() } catch (_: Throwable) {} }
        }
    }

    // ── BACKGROUND EXECUTION ────────────────────────────────────────
    // Thin passthrough to VaultBeamForegroundService. No transfer logic lives
    // here or in the service: JS owns transfer state and simply says "keep me
    // alive, and show this text". See VaultBeamForegroundService.kt.

    @ReactMethod
    fun startTransferService(title: String?, text: String?, promise: Promise) {
        try {
            VaultBeamForegroundService.onCancelRequested = {
                // Same-process hop back into JS; VaultBeam owns what cancelling
                // actually means (AbortSignal + persisted state).
                try {
                    reactApplicationContext
                        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                        .emit("vbServiceCancel", Arguments.createMap())
                } catch (_: Throwable) {}
            }
            VaultBeamForegroundService.start(
                reactApplicationContext,
                title ?: "VaultBeam",
                text ?: "Transferring…",
            )
            promise.resolve(true)
        } catch (e: Throwable) { promise.reject("startTransferService", e) }
    }

    @ReactMethod
    fun updateTransferService(title: String?, text: String?, promise: Promise) {
        try {
            VaultBeamForegroundService.update(
                reactApplicationContext,
                title ?: "VaultBeam",
                text ?: "Transferring…",
            )
            promise.resolve(true)
        } catch (e: Throwable) { promise.reject("updateTransferService", e) }
    }

    @ReactMethod
    fun stopTransferService(promise: Promise) {
        try {
            VaultBeamForegroundService.onCancelRequested = null
            VaultBeamForegroundService.stop(reactApplicationContext)
            promise.resolve(true)
        } catch (e: Throwable) { promise.reject("stopTransferService", e) }
    }
}
