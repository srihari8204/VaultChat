package com.vaultchat.transportcore

import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit

class TransportCoreModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    private val io = ThreadPoolExecutor(2, 2, 0L, TimeUnit.MILLISECONDS, ArrayBlockingQueue<Runnable>(2))
    private val pending = ConcurrentHashMap<Long, Semaphore>()
    private val started = ConcurrentHashMap.newKeySet<Long>()
    override fun getName() = "TransportCore"
    private external fun nativeCreate(): Long
    private external fun nativeSupportsWebTransport(): Boolean
    private external fun nativeRun(id: Long, url: String, token: String, listener: EventListener)
    private external fun nativeSend(id: Long, bytes: ByteArray): Boolean
    private external fun nativeClose(id: Long)
    fun interface EventListener { fun onEvent(kind: Int, data: ByteArray?, code: Int) }

    companion object {
        val loaded = try { System.loadLibrary("transportnative"); true } catch (_: Throwable) { false }
        private const val MAX_BASE64 = 2796212 // ceil((2 MiB + 5)/3)*4
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun supportsWebTransport(): Boolean = nativeSupportsWebTransport()

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun create(): Double {
        val id = nativeCreate()
        if (id != 0L) pending[id] = Semaphore(4)
        return id.toDouble()
    }

    @ReactMethod
    fun connect(socketId: Double, url: String, token: String) {
        val id = socketId.toLong()
        val permits = pending[id] ?: return
        if (!started.add(id)) return
        try { io.execute {
            try {
                nativeRun(id, url, token) { kind, data, code ->
                    // Bound queued JS payloads as well as Rust's outbound channel.
                    if (kind == 1 && !permits.tryAcquire(5, TimeUnit.SECONDS)) {
                        nativeClose(id)
                    } else if (pending.containsKey(id)) {
                        val event = Arguments.createMap().apply {
                            putDouble("id", socketId)
                            putInt("kind", kind)
                            putInt("code", code)
                            if (data != null) putString("data", Base64.encodeToString(data, Base64.NO_WRAP))
                        }
                        reactApplicationContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                            .emit("transportSocket", event)
                    }
                }
            } finally {
                nativeClose(id)
                pending.remove(id)
                started.remove(id)
            }
        } } catch (_: RejectedExecutionException) {
            close(socketId)
            val event = Arguments.createMap().apply { putDouble("id", socketId); putInt("kind", 2); putInt("code", 1013) }
            reactApplicationContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("transportSocket", event)
        }
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun send(socketId: Double, data: String): Boolean {
        if (data.isEmpty() || data.length > MAX_BASE64) return false
        return try { nativeSend(socketId.toLong(), Base64.decode(data, Base64.NO_WRAP)) } catch (_: IllegalArgumentException) { false }
    }

    @ReactMethod
    fun acknowledge(socketId: Double) { pending[socketId.toLong()]?.release() }

    @ReactMethod
    fun close(socketId: Double) {
        val id = socketId.toLong()
        pending.remove(id)?.release(4)
        started.remove(id)
        nativeClose(id)
    }

    @ReactMethod fun addListener(eventName: String) = Unit
    @ReactMethod fun removeListeners(count: Int) = Unit

    override fun invalidate() {
        pending.keys.toList().forEach { close(it.toDouble()) }
        io.shutdownNow()
        super.invalidate()
    }
}
