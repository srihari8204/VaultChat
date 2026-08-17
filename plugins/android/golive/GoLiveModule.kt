package com.vaultchat.app.golive

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Native bridge for Go Live broadcasting: `NativeModules.VaultGoLive`.
 *
 * Deliberately SMALL and deliberately SEPARATE from VaultCalls. It owns exactly
 * the two things a broadcast needs that a call's module cannot provide, because
 * the call module drives a service that is not running during a broadcast:
 *
 *   startBroadcastService / stopBroadcastService   keep publishing in background
 *   allowScreenCapture                             make MediaProjection legal
 *
 * WHAT IS NOT HERE, ON PURPOSE
 * ----------------------------
 * FLAG_SECURE. Clearing it is required for capture to produce frames at all
 * (VaultCalls.setWindowSecure, CallModule.kt:200 — a secure window makes
 * MediaProjection run, the consent succeed, and the encoder receive nothing).
 * But that is a property of the ACTIVITY WINDOW, not of calling: it is already
 * exported, it takes a boolean, and it has no call state in it. Go Live CALLS
 * it rather than duplicating it — a second module setting the same window flag
 * would be two owners for one piece of state, and they would fight the moment a
 * call and a broadcast ever overlapped.
 */
class GoLiveModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    override fun getName() = "VaultGoLive"

    /**
     * Promote the app to a foreground service for the duration of a broadcast.
     *
     * Without this, Android 12+ revokes microphone and camera capture within
     * seconds of the host switching apps: the broadcast goes silent and black
     * while still reading LIVE to every viewer.
     */
    @ReactMethod
    fun startBroadcastService(title: String?, promise: Promise) {
        try {
            GoLiveForegroundService.start(ctx, title ?: "")
            promise.resolve(true)
        } catch (_: Throwable) {
            // Best-effort. A broadcast that cannot hold a foreground service is
            // degraded, not broken — it still works while the app is in front —
            // so JS is told and carries on rather than failing the go-live.
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun stopBroadcastService(promise: Promise) {
        try {
            GoLiveForegroundService.stop(ctx)
            promise.resolve(true)
        } catch (_: Throwable) { promise.resolve(false) }
    }

    /**
     * Let the live broadcast service carry mediaProjection, so screen capture is
     * legal. Safe to call twice — and it MUST be called twice, before and after
     * the consent dialog, because Android 10-13 needs the type up front while
     * 14+ refuses to grant it until a projection already exists.
     */
    @ReactMethod
    fun allowScreenCapture(promise: Promise) {
        try {
            GoLiveForegroundService.allowProjection(ctx)
            promise.resolve(true)
        } catch (_: Throwable) { promise.resolve(false) }
    }
}
