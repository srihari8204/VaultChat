package com.vaultchat.app.calls

import android.app.NotificationManager
import android.content.Context
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.google.firebase.messaging.FirebaseMessaging

/**
 * JS bridge for the call subsystem.
 *
 *   startCallService(callId, callerName, callerDpUrl, isVideo)  — promote to a
 *       microphone/camera foreground service so audio survives backgrounding.
 *   stopCallService()                                           — end + release.
 *   getFcmToken()                                               — native FCM token
 *       to POST to /call/token (JS holds the JWT).
 *   setApiContext(baseUrl, accessToken)                         — lets the native
 *       FCM service fetch the caller DP for the ring notification.
 *   dismissIncoming()                                           — cancel the ring.
 *   consumeDeclinedCall()                                       — read a decline
 *       made from the notification while the app was killed.
 */
class CallModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "VaultCalls"

    @ReactMethod
    fun startCallService(callId: String, callerName: String, callerDpUrl: String, isVideo: Boolean) {
        CallForegroundService.start(reactApplicationContext, callId, callerName, isVideo)
    }

    @ReactMethod
    fun stopCallService() {
        CallForegroundService.stop(reactApplicationContext)
    }

    @ReactMethod
    fun dismissIncoming() {
        (reactApplicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .cancel(VaultCallMessagingService.INCOMING_NOTIF_ID)
        // Mark the ring as handled so a later call_cancelled doesn't post a
        // "missed call" for a call we actually answered.
        reactApplicationContext.getSharedPreferences(VaultCallMessagingService.PREFS, Context.MODE_PRIVATE)
            .edit().remove("ring_callId").apply()
    }

    @ReactMethod
    fun getFcmToken(promise: Promise) {
        try {
            FirebaseMessaging.getInstance().token
                .addOnSuccessListener { promise.resolve(it) }
                .addOnFailureListener { promise.reject("fcm_token", it) }
        } catch (e: Throwable) {
            promise.reject("fcm_token", e)
        }
    }

    @ReactMethod
    fun setApiContext(baseUrl: String, accessToken: String) {
        reactApplicationContext
            .getSharedPreferences(VaultCallMessagingService.PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString("api_base", baseUrl)
            .putString("access_token", accessToken)
            .apply()
    }

    @ReactMethod
    fun consumeDeclinedCall(promise: Promise) {
        val prefs = reactApplicationContext.getSharedPreferences(VaultCallMessagingService.PREFS, Context.MODE_PRIVATE)
        val id = prefs.getString("declined_call", null)
        if (id != null) prefs.edit().remove("declined_call").apply()
        promise.resolve(id)
    }

    /**
     * If the app was launched (cold or warm) by tapping the full-screen call
     * notification, return its extras so JS can route straight to the incoming /
     * active call screen. Consumed once (extras cleared) so a later reload doesn't
     * re-trigger the call UI.
     */
    @ReactMethod
    fun getInitialCallIntent(promise: Promise) {
        val act = currentActivity ?: return promise.resolve(null)
        val intent = act.intent
        val action = intent?.getStringExtra("vc_action")
        if (action == null || intent.getStringExtra("callId") == null) return promise.resolve(null)
        val map = Arguments.createMap().apply {
            putString("action", action)                               // "incoming_call" | "answer"
            putString("callId", intent.getStringExtra("callId"))
            putString("callerId", intent.getStringExtra("callerId"))
            putString("callerName", intent.getStringExtra("callerName"))
            putBoolean("isVideo", intent.getBooleanExtra("isVideo", false))
        }
        // Consume so it fires only once.
        intent.removeExtra("vc_action"); intent.removeExtra("callId")
        promise.resolve(map)
    }
}
