package com.vaultchat.app.vaultpdf

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.FileOutputStream

/**
 * Native PDF rendering — Android.
 *
 * ── WHY THIS REPLACES pdf.js ──
 *
 * The previous renderer was Mozilla's pdf.js inside a WebView loaded from
 * `file:///android_asset/pdfjs/viewer.html`. pdf.js does its parsing and
 * rasterising in a Web Worker, and **Chrome refuses to start a Worker from a
 * `file://` origin**. pdf.js does not fail loudly when that happens: it falls
 * back to its "fake worker", which runs the identical work ON THE MAIN THREAD.
 *
 * So every PDF was parsed and rasterised on the UI thread. A small one merely
 * felt slow; a large one froze the app until Android killed it. That is the
 * reported bug — "takes too much time", "app closes when I try to stop it", and
 * no thumbnail — all three being one ANR, confirmed in dropbox as data_app_anr
 * with libwebviewchromium.so on the blocked main thread. It predated the pdf.js
 * 3→4 upgrade; the upgrade neither caused nor fixed it.
 *
 * android.graphics.pdf.PdfRenderer is the platform's own pdfium, present since
 * API 21. It renders straight to a Bitmap in native code. Using it removes, in
 * one step: the WebView, the worker that could never start, the `file://` origin
 * problem, the `allowFileAccess*` flags, ~2.6 MB of vendored JavaScript, and the
 * CVE-2024-4367 exposure that came with shipping our own PDF parser.
 *
 * ── THREADING ──
 *
 * Every method here is @ReactMethod with a Promise, so React Native already runs
 * it on its native module executor — never the JS thread and never the UI
 * thread. That is the actual fix for the ANR: the work is off the main thread by
 * construction rather than by hoping a Worker starts.
 *
 * ── MEMORY ──
 *
 * One page is held as a Bitmap at a time and recycled before the next. A page is
 * rendered at the width the caller asks for, so the caller bounds the allocation
 * (width × width·aspect × 4 bytes) instead of the document doing it. Pages are
 * written to disk as JPEG/PNG and handed back as file paths — never as base64
 * across the bridge, which would cost ~1.33× the bitmap in a JS string on top of
 * the bitmap itself.
 *
 * PdfRenderer is NOT thread-safe and allows only one open document per instance;
 * every method below opens, uses and closes within its own call, guarded by a
 * lock so two concurrent opens cannot interleave.
 */
class VaultPdfModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "VaultPdf"

    /** PdfRenderer is single-document and not thread-safe — serialise all use. */
    private val lock = Any()

    private fun openDescriptor(path: String): ParcelFileDescriptor {
        val clean = path.removePrefix("file://")
        val f = File(clean)
        if (!f.exists()) throw IllegalArgumentException("no such file")
        if (f.length() == 0L) throw IllegalArgumentException("file is empty")
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY)
    }

    /**
     * Page count plus the first page's aspect ratio, without rendering anything.
     *
     * This is what the document CARD needs: a real page count (the old viewer
     * discarded the one pdf.js reported) and enough geometry to reserve the right
     * space before any pixels exist.
     *
     * It is also the cheapest possible validity check — a truncated or corrupt
     * PDF fails here, in microseconds, instead of after a 30-second render
     * timeout. `reason` distinguishes the cases the UI must not conflate:
     * PASSWORD_REQUIRED is recoverable by asking, CORRUPT is not.
     */
    @ReactMethod
    fun info(path: String, promise: Promise) {
        synchronized(lock) {
            var fd: ParcelFileDescriptor? = null
            var renderer: PdfRenderer? = null
            try {
                fd = openDescriptor(path)
                renderer = PdfRenderer(fd)
                val out = Arguments.createMap()
                out.putInt("pageCount", renderer.pageCount)
                if (renderer.pageCount > 0) {
                    renderer.openPage(0).use { p ->
                        out.putInt("width", p.width)
                        out.putInt("height", p.height)
                    }
                }
                promise.resolve(out)
            } catch (e: SecurityException) {
                // PdfRenderer throws SecurityException for an encrypted document
                // it cannot open. It is NOT corrupt, and telling the user "this
                // PDF has no text layer (it may be a scan)" — which is what the
                // old fallback said — was simply the wrong diagnosis.
                promise.reject("PASSWORD_REQUIRED", "This PDF is password protected.", e)
            } catch (e: Exception) {
                promise.reject("CORRUPT", e.message ?: "This PDF could not be opened.", e)
            } finally {
                try { renderer?.close() } catch (_: Exception) {}
                try { fd?.close() } catch (_: Exception) {}
            }
        }
    }

    /**
     * Render one page to an image file and return its path.
     *
     * `targetWidth` is in PIXELS and is the caller's memory budget: height
     * follows from the page's own aspect ratio, so the document can never decide
     * how much memory to take. Clamped to something sane at both ends — 0 would
     * throw inside createBitmap, and an unbounded value is how a "zoom to 10×"
     * turns into an OutOfMemoryError.
     *
     * RGB_565 is deliberate for thumbnails: half the bytes of ARGB_8888, and a
     * PDF page composited onto opaque white has no alpha to preserve anyway.
     */
    @ReactMethod
    fun renderPage(path: String, pageIndex: Int, targetWidth: Int, outPath: String, promise: Promise) {
        synchronized(lock) {
            var fd: ParcelFileDescriptor? = null
            var renderer: PdfRenderer? = null
            var bmp: Bitmap? = null
            try {
                fd = openDescriptor(path)
                renderer = PdfRenderer(fd)
                if (pageIndex < 0 || pageIndex >= renderer.pageCount) {
                    promise.reject("RANGE", "page $pageIndex outside 0..${renderer.pageCount - 1}")
                    return
                }
                val w = targetWidth.coerceIn(64, 4096)
                renderer.openPage(pageIndex).use { page ->
                    val h = ((w.toLong() * page.height) / page.width).toInt().coerceIn(64, 8192)
                    bmp = Bitmap.createBitmap(w, h, Bitmap.Config.RGB_565)
                    // A PDF page is transparent where nothing is drawn. Without
                    // this the page renders as black-on-black in a dark theme —
                    // present, correct, and unreadable.
                    bmp!!.eraseColor(Color.WHITE)
                    page.render(bmp!!, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                }
                val dest = File(outPath.removePrefix("file://"))
                dest.parentFile?.mkdirs()
                FileOutputStream(dest).use { os ->
                    bmp!!.compress(Bitmap.CompressFormat.JPEG, 85, os)
                }
                val out = Arguments.createMap()
                out.putString("uri", "file://${dest.absolutePath}")
                out.putInt("width", bmp!!.width)
                out.putInt("height", bmp!!.height)
                promise.resolve(out)
            } catch (e: SecurityException) {
                promise.reject("PASSWORD_REQUIRED", "This PDF is password protected.", e)
            } catch (e: OutOfMemoryError) {
                // Reported as a normal rejection, not a crash: the caller can
                // retry at a smaller width, which is a real recovery.
                promise.reject("TOO_LARGE", "This page is too large to render at that size.")
            } catch (e: Exception) {
                promise.reject("RENDER_FAILED", e.message ?: "This page could not be rendered.", e)
            } finally {
                try { bmp?.recycle() } catch (_: Exception) {}
                try { renderer?.close() } catch (_: Exception) {}
                try { fd?.close() } catch (_: Exception) {}
            }
        }
    }
}
