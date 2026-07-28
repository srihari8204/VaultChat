package com.vaultchat.vaultbeamcore

import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONObject
import java.io.BufferedInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * VaultBeamStreamRust — the RUST-BACKED twin of the Kotlin VaultBeamStream module.
 *
 * Identical @ReactMethod surface and identical over-the-wire behaviour, but the
 * byte pipeline (positional file I/O + per-chunk AES-256-GCM + chunk/block
 * geometry + the LAN TCP transport) lives in the shared Rust crate
 * (services/vaultbeam/rust) reached through a JSON-in/JSON-out C ABI. Only the
 * thin marshaling shim + the block HTTP is per-platform.
 *
 * Design A′ split:
 *   - seal/open + layout + file IO + LAN sockets → shared Rust (one impl, all platforms)
 *   - block HTTP PUT/GET → platform-native here, byte-for-byte matching
 *     plugins/android/VaultBeamStreamModule.kt so an old(Kotlin)↔new(Rust)
 *     transfer opens on the relay tier.
 *
 * getName() = "VaultBeamStreamRust". lib/vaultBeamStreamNative.ts prefers this
 * module when present and falls back to "VaultBeamStream" (Kotlin) otherwise.
 * If libvaultbeamnative.so fails to load, the package registers NOTHING (see
 * VaultBeamStreamRustPackage), so JS never sees "VaultBeamStreamRust" and cleanly
 * falls back — same contract as crypto-core's "JS finds no CryptoCore".
 */
class VaultBeamStreamRustModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val io = Executors.newFixedThreadPool(4)

    override fun getName() = "VaultBeamStreamRust"

    // ── JNI surface (libvaultbeamnative.so → src/main/cpp/VaultBeamJni.cpp) ──
    private external fun nativeCall(op: String, argsJson: String): String
    private external fun nativeLanServe(argsJson: String, listener: LanEventListener): String
    private external fun nativeLanConnect(argsJson: String, listener: LanEventListener): String

    // The Rust LAN callback (vbLanBound/vbLanProgress) reaches Kotlin through this.
    fun interface LanEventListener {
        fun onEvent(name: String, payloadJson: String)
    }

    companion object {
        /** Loaded once; the package only registers the module when this is true. */
        val loaded: Boolean = try {
            System.loadLibrary("vaultbeamnative")
            true
        } catch (t: Throwable) {
            android.util.Log.w("VaultBeamStreamRust", "native lib unavailable — Kotlin fallback", t)
            false
        }
    }

    // ── JSON marshaling helpers ─────────────────────────────────────────

    // ReadableMap → JSONObject. Whole numbers are emitted as Long (integer JSON)
    // so the Rust side's serde_json `as_u64` accepts them — a Double like 512.0
    // would serialize as "512.0" and fail u64 parsing. Strings/paths/base64/url
    // pass through as-is; url/srcPath/dstPath that a given Rust op ignores are
    // harmless extra keys.
    private fun toJson(map: ReadableMap): JSONObject {
        val o = JSONObject()
        val it = map.keySetIterator()
        while (it.hasNextKey()) {
            val k = it.nextKey()
            when (map.getType(k)) {
                ReadableType.String -> o.put(k, map.getString(k))
                ReadableType.Boolean -> o.put(k, map.getBoolean(k))
                ReadableType.Number -> {
                    val d = map.getDouble(k)
                    if (!d.isInfinite() && !d.isNaN() && d == Math.floor(d)) o.put(k, d.toLong())
                    else o.put(k, d)
                }
                else -> { /* Null/Map/Array not used by any vaultbeam op */ }
            }
        }
        return o
    }

    // Unwrap {"ok":true,"result":…} | {"ok":false,"error":"…"}; throws on error.
    private fun result(resp: String): Any? {
        val o = JSONObject(resp)
        if (!o.optBoolean("ok", false)) throw RuntimeException(o.optString("error", "vaultbeam native error"))
        return if (o.isNull("result")) null else o.get("result")
    }

    private fun resultDouble(resp: String): Double = when (val r = result(resp)) {
        is Number -> r.toDouble()
        is Boolean -> if (r) 1.0 else 0.0
        else -> throw RuntimeException("vaultbeam: expected number result, got $r")
    }

    private fun call(op: String, args: JSONObject): Any? = result(nativeCall(op, args.toString()))

    // ── file IO ops (positional; no file byte ever crosses to JS) ────────

    @ReactMethod
    fun prealloc(path: String, totalBytes: Double, promise: Promise) {
        io.execute {
            try {
                val args = JSONObject().put("path", path).put("totalBytes", totalBytes.toLong())
                promise.resolve(result(nativeCall("prealloc", args.toString())) as? Boolean ?: false)
            } catch (e: Throwable) { promise.reject("prealloc", e) }
        }
    }

    @ReactMethod
    fun sha256(path: String, promise: Promise) {
        io.execute {
            try {
                promise.resolve(call("sha256", JSONObject().put("path", path)) as String)
            } catch (e: Throwable) { promise.reject("sha256", e) }
        }
    }

    @ReactMethod
    fun deleteFile(path: String, promise: Promise) {
        io.execute {
            try {
                promise.resolve(call("deleteFile", JSONObject().put("path", path)) as? Boolean ?: false)
            } catch (e: Throwable) { promise.reject("delete", e) }
        }
    }

    // ── R2 block ops: Rust seals/opens+writes, platform does the HTTP ────
    // HTTP semantics COPIED byte-for-byte from VaultBeamStreamModule.kt so an
    // old(Kotlin)↔new(Rust) transfer interoperates on the relay tier.

    @ReactMethod
    fun uploadBlock(opts: ReadableMap, promise: Promise) {
        io.execute {
            try {
                val url = opts.getString("url")!!
                // Rust seals this block's chunks from srcPath → base64 ciphertext.
                val ctB64 = call("sealBlockFromFile", toJson(opts)) as String
                val body = Base64.decode(ctB64, Base64.DEFAULT)

                val conn = URL(url).openConnection() as HttpURLConnection
                try {
                    conn.requestMethod = "PUT"
                    conn.doOutput = true
                    conn.setRequestProperty("Content-Type", "application/octet-stream") // must match presigned ContentType
                    conn.setFixedLengthStreamingMode(body.size)                          // stream, don't buffer
                    conn.connectTimeout = 30_000; conn.readTimeout = 120_000
                    conn.outputStream.use { it.write(body) }
                    val code = conn.responseCode
                    if (code in 200..299) promise.resolve(body.size.toDouble())
                    else promise.reject("upload_http_$code", "PUT block ${opts.getInt("blockIndex")} failed: $code")
                } finally { conn.disconnect() }
            } catch (e: Throwable) { promise.reject("upload", e) }
        }
    }

    @ReactMethod
    fun downloadBlock(opts: ReadableMap, promise: Promise) {
        io.execute {
            try {
                val url = opts.getString("url")!!
                val conn = URL(url).openConnection() as HttpURLConnection
                val body: ByteArray
                try {
                    conn.requestMethod = "GET"
                    conn.connectTimeout = 30_000; conn.readTimeout = 120_000
                    val code = conn.responseCode
                    if (code !in 200..299) { promise.reject("download_http_$code", "GET block ${opts.getInt("blockIndex")} failed: $code"); return@execute }
                    body = BufferedInputStream(conn.inputStream).use { it.readBytes() }
                } finally { conn.disconnect() }

                // Rust verifies+opens each chunk from the body and writes plaintext @ offset.
                val args = toJson(opts).put("bodyB64", Base64.encodeToString(body, Base64.NO_WRAP))
                promise.resolve(resultDouble(nativeCall("writeBlockFromBody", args.toString())))
            } catch (e: Throwable) { promise.reject("download", e) }
        }
    }

    // ── P2 (WebRTC) per-chunk cipher primitives ─────────────────────────
    @ReactMethod
    fun readCipherChunk(opts: ReadableMap, promise: Promise) {
        io.execute {
            try { promise.resolve(call("readCipherChunk", toJson(opts)) as String) }
            catch (e: Throwable) { promise.reject("readCipherChunk", e) }
        }
    }

    @ReactMethod
    fun writeCipherChunk(opts: ReadableMap, promise: Promise) {
        io.execute {
            try { promise.resolve(resultDouble(nativeCall("writeCipherChunk", toJson(opts).toString()))) }
            catch (e: Throwable) { promise.reject("writeCipherChunk", e) }
        }
    }

    // ── P3 (LAN) direct TCP transport (Rust owns socket + file) ─────────

    @ReactMethod
    fun lanIp(promise: Promise) {
        io.execute {
            try { promise.resolve(call("lanIp", JSONObject()) as String?) }
            catch (e: Throwable) { promise.reject("lanIp", e) }
        }
    }

    @ReactMethod
    fun lanServe(opts: ReadableMap, promise: Promise) {
        io.execute {
            try {
                val resp = nativeLanServe(toJson(opts).toString(), lanListener())
                promise.resolve(resultDouble(resp)) // chunk count; bound port arrives via vbLanBound
            } catch (e: Throwable) { promise.reject("lanServe", e) }
        }
    }

    @ReactMethod
    fun lanConnect(opts: ReadableMap, promise: Promise) {
        io.execute {
            try {
                val resp = nativeLanConnect(toJson(opts).toString(), lanListener())
                promise.resolve(resultDouble(resp))
            } catch (e: Throwable) { promise.reject("lanConnect", e) }
        }
    }

    // ── Event emitter (native-driven LAN progress) ──────────────────────
    private fun lanListener() = LanEventListener { name, payloadJson -> emitEvent(name, payloadJson) }

    // Rust emits a JSON payload; rebuild it as a WritableMap and forward under
    // the SAME event names/fields as the Kotlin module (vbLanBound/vbLanProgress).
    private fun emitEvent(name: String, payloadJson: String) {
        try {
            val o = JSONObject(payloadJson)
            val m = Arguments.createMap()
            val keys = o.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                when (val v = o.get(k)) {
                    is String -> m.putString(k, v)
                    is Boolean -> m.putBoolean(k, v)
                    is Int -> m.putInt(k, v)
                    is Long -> m.putDouble(k, v.toDouble())
                    is Double -> m.putDouble(k, v)
                    else -> m.putString(k, v.toString())
                }
            }
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(name, m)
        } catch (_: Throwable) {}
    }

    // NativeEventEmitter requires these to exist (no-ops for the classic bridge).
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}
