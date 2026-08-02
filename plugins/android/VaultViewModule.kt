package com.vaultchat.app.vaultview

import android.app.Activity
import android.content.Context
import android.hardware.display.DisplayManager
import android.os.Build
import android.view.Display
import android.view.WindowManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * VaultView screen guard — Android.
 *
 * What this platform actually allows, stated plainly because the JS layer's
 * promises depend on it:
 *
 *   FLAG_SECURE  — real, OS-enforced. Blocks BOTH screenshots and screen
 *                  recording: the window renders black in any capture, from the
 *                  user's own screenshot, a third-party recorder, or a cast.
 *                  This is why Android needs no recording *detection* — the
 *                  block is total. Requires Android 9+ to be dependable, which
 *                  is effectively the whole active fleet.
 *
 *   External display — real, via DisplayManager. Any display beyond the default
 *                  (HDMI, Chromecast, Miracast, desktop mode) is reported so JS
 *                  can refuse to decrypt.
 *
 *   Screenshot callback — Android 14 (API 34) and up only, via
 *                  Activity.registerScreenCaptureCallback. Fires AFTER a
 *                  screenshot of this app's content. Useful for the notify path
 *                  in `allow_notify` mode; irrelevant under FLAG_SECURE because
 *                  the capture is already black.
 *
 *   Local screen recording, as a *detected* state — NOT possible. Android
 *                  exposes no API to ask "is a MediaProjection recording me
 *                  right now" from outside the recording app. Do not add a
 *                  heuristic here and report it as detection; FLAG_SECURE is
 *                  the answer on this platform, and iOS is where detection
 *                  carries the weight.
 *
 * Emits `vaultview_state` with { external: Boolean, captured: Boolean } on every
 * display change, and `vaultview_screenshot` when the API-34 callback fires.
 */
class VaultViewModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "VaultViewGuard"

    private var displayListener: DisplayManager.DisplayListener? = null
    private var screenCaptureCallback: Any? = null   // Activity.ScreenCaptureCallback (API 34+)

    private fun displayManager(): DisplayManager? =
        reactApplicationContext.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager

    /** Any display other than the built-in one currently attached/mirroring. */
    private fun hasExternalDisplay(): Boolean {
        val dm = displayManager() ?: return false
        return try {
            dm.displays.any { d ->
                d.displayId != Display.DEFAULT_DISPLAY && d.state != Display.STATE_OFF
            }
        } catch (_: Throwable) { false }
    }

    private fun stateMap(): WritableMap = Arguments.createMap().apply {
        putBoolean("external", hasExternalDisplay())
        // Android has no queryable "being recorded" state — see the class note.
        // Reported as false rather than omitted so the JS shape is stable across
        // platforms; iOS fills this in for real.
        putBoolean("captured", false)
        putBoolean("blockingSupported", true)   // FLAG_SECURE is real here
    }

    private fun emit(event: String, payload: WritableMap) {
        try {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(event, payload)
        } catch (_: Throwable) { /* JS side gone */ }
    }

    // ── FLAG_SECURE ──────────────────────────────────────────

    @ReactMethod
    fun setSecure(enabled: Boolean, promise: Promise) {
        val activity: Activity? = getCurrentActivity()
        if (activity == null) { promise.resolve(false); return }
        activity.runOnUiThread {
            try {
                if (enabled) activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                promise.resolve(true)
            } catch (e: Throwable) {
                promise.resolve(false)
            }
        }
    }

    // ── State ────────────────────────────────────────────────

    @ReactMethod
    fun getState(promise: Promise) {
        try { promise.resolve(stateMap()) } catch (e: Throwable) { promise.reject("state_failed", e) }
    }

    @ReactMethod
    fun startWatch() {
        if (displayListener != null) return
        val dm = displayManager() ?: return
        val listener = object : DisplayManager.DisplayListener {
            override fun onDisplayAdded(displayId: Int)   { emit("vaultview_state", stateMap()) }
            override fun onDisplayRemoved(displayId: Int) { emit("vaultview_state", stateMap()) }
            override fun onDisplayChanged(displayId: Int) { emit("vaultview_state", stateMap()) }
        }
        try {
            dm.registerDisplayListener(listener, null)
            displayListener = listener
        } catch (_: Throwable) { return }

        // API 34+: post-hoc screenshot notification, for the allow_notify path.
        if (Build.VERSION.SDK_INT >= 34) {
            try {
                val activity = getCurrentActivity() ?: return
                val cb = Activity.ScreenCaptureCallback {
                    emit("vaultview_screenshot", Arguments.createMap())
                }
                activity.registerScreenCaptureCallback(reactApplicationContext.mainExecutor, cb)
                screenCaptureCallback = cb
            } catch (_: Throwable) { /* optional path */ }
        }
    }

    @ReactMethod
    fun stopWatch() {
        displayListener?.let {
            try { displayManager()?.unregisterDisplayListener(it) } catch (_: Throwable) {}
        }
        displayListener = null

        if (Build.VERSION.SDK_INT >= 34) {
            (screenCaptureCallback as? Activity.ScreenCaptureCallback)?.let { cb ->
                try { getCurrentActivity()?.unregisterScreenCaptureCallback(cb) } catch (_: Throwable) {}
            }
        }
        screenCaptureCallback = null
    }

    override fun invalidate() {
        stopWatch()
        super.invalidate()
    }

    // RN requires these on modules that emit events, or it warns on every emit.
    @ReactMethod fun addListener(eventName: String) { /* handled by RCTDeviceEventEmitter */ }
    @ReactMethod fun removeListeners(count: Int) { /* handled by RCTDeviceEventEmitter */ }
}
