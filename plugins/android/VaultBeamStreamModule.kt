package com.vaultchat.app.vaultbeam

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
import java.io.RandomAccessFile
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

                // Seal each chunk into memory (≤ block + 8·16B overhead). Bounded —
                // never the whole file — which is the entire point of the native path.
                val parts = ArrayList<ByteArray>(chunksPerBlock)
                RandomAccessFile(srcPath, "r").use { raf ->
                    var g = firstChunk; var i = 0
                    while (i < chunksPerBlock && g < chunkCount) {
                        val plainOffset = g * chunkBytes.toLong()
                        val plainLen = minOf(chunkBytes.toLong(), totalBytes - plainOffset).toInt()
                        val plain = ByteArray(plainLen)
                        raf.seek(plainOffset); raf.readFully(plain, 0, plainLen)
                        val aad = "$transferId|$fileId|$g".toByteArray(Charsets.UTF_8)
                        parts.add(gcm(Cipher.ENCRYPT_MODE, keyBytes, chunkNonce(transferId, g), aad).doFinal(plain))
                        g++; i++
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
                    var off = 0; var g = firstChunk; var i = 0; var written = 0
                    while (i < chunksPerBlock && g < chunkCount) {
                        val plainOffset = g * chunkBytes.toLong()
                        val plainLen = minOf(chunkBytes.toLong(), totalBytes - plainOffset).toInt()
                        val ctLen = plainLen + 16 // + GCM tag
                        if (off + ctLen > body.size) throw IllegalStateException("short block body for block $blockIndex")
                        val ct = body.copyOfRange(off, off + ctLen)
                        val aad = "$transferId|$fileId|$g".toByteArray(Charsets.UTF_8)
                        val plain = gcm(Cipher.DECRYPT_MODE, keyBytes, chunkNonce(transferId, g), aad).doFinal(ct)
                        raf.seek(plainOffset); raf.write(plain)
                        off += ctLen; written++; g++; i++
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
                RandomAccessFile(fsPath(path), "r").use { raf ->
                    val buf = ByteArray(1 shl 20)
                    while (true) { val r = raf.read(buf); if (r <= 0) break; md.update(buf, 0, r) }
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
                RandomAccessFile(srcPath, "r").use { it.seek(plainOffset); it.readFully(plain, 0, plainLen) }
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

                RandomAccessFile(srcPath, "r").use { raf ->
                    var g = 0L
                    while (g < chunkCount) {
                        val plainOffset = g * chunkBytes.toLong()
                        val plainLen = minOf(chunkBytes.toLong(), totalBytes - plainOffset).toInt()
                        val plain = ByteArray(plainLen)
                        raf.seek(plainOffset); raf.readFully(plain, 0, plainLen)
                        val aad = "$transferId|$fileId|$g".toByteArray(Charsets.UTF_8)
                        val ct = gcm(Cipher.ENCRYPT_MODE, keyBytes, chunkNonce(transferId, g), aad).doFinal(plain)
                        out.writeInt(g.toInt()); out.writeInt(ct.size); out.write(ct)
                        if ((g % 16L) == 0L) {
                            out.flush()
                            val p = Arguments.createMap()
                            p.putString("transferId", transferId); p.putInt("done", (g + 1).toInt()); p.putInt("total", chunkCount)
                            emitEvent("vbLanProgress", p)
                        }
                        g++
                    }
                    out.flush()
                }
                // Wait for the receiver's 1-byte delivery ack — written only after
                // it has decrypted + persisted EVERY chunk — before declaring the
                // transfer delivered. Without this the sender could report success
                // while the receiver's last write failed.
                val ack = ins.read()
                if (ack == 1) promise.resolve(chunkCount.toDouble())
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

                RandomAccessFile(dstPath, "rw").use { raf ->
                    var received = 0
                    while (received < chunkCount) {
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
                            p.putString("transferId", transferId); p.putInt("done", received); p.putInt("total", chunkCount)
                            emitEvent("vbLanProgress", p)
                        }
                    }
                }
                // Every chunk is decrypted + on disk (the RandomAccessFile is closed)
                // → send the 1-byte delivery ack so the sender can declare success.
                out.write(1); out.flush()
                promise.resolve(chunkCount.toDouble())
            } catch (e: Throwable) { promise.reject("lanConnect", e) }
            finally { try { sock?.close() } catch (_: Throwable) {} }
        }
    }
}
