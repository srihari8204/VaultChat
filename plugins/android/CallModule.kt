package com.vaultchat.app.calls

import android.app.NotificationManager
import android.content.Context
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Build
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

    // ── Device-default ringtone for the in-app incoming-call screen ──
    private var ringtone: Ringtone? = null

    @ReactMethod
    fun playSystemRingtone() {
        try {
            stopRingtoneInternal()
            val uri = RingtoneManager.getActualDefaultRingtoneUri(reactApplicationContext, RingtoneManager.TYPE_RINGTONE)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
            ringtone = RingtoneManager.getRingtone(reactApplicationContext, uri)?.apply {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) isLooping = true
                play()
            }
        } catch (_: Throwable) {}
    }

    @ReactMethod
    fun stopSystemRingtone() { stopRingtoneInternal() }

    private fun stopRingtoneInternal() {
        try { ringtone?.stop() } catch (_: Throwable) {}
        ringtone = null
    }

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
        val intent = getCurrentActivity()?.intent
        val action = intent?.getStringExtra("vc_action")
        if (intent == null || action == null) {
            promise.resolve(null)
            return
        }
        // Message-notification tap (F2): route straight to the chat.
        if (action == "open_chat") {
            val map = Arguments.createMap()
            map.putString("action", action)
            map.putString("chatId", intent.getStringExtra("vc_chat_id"))
            intent.removeExtra("vc_action")
            intent.removeExtra("vc_chat_id")
            promise.resolve(map)
            return
        }
        val callId = intent.getStringExtra("callId")
        if (callId == null) {
            promise.resolve(null)
            return
        }
        val map = Arguments.createMap()
        map.putString("action", action)                               // "incoming_call" | "answer"
        map.putString("callId", callId)
        map.putString("callerId", intent.getStringExtra("callerId"))
        map.putString("callerName", intent.getStringExtra("callerName"))
        map.putBoolean("isVideo", intent.getBooleanExtra("isVideo", false))
        // Consume so it fires only once.
        intent.removeExtra("vc_action")
        intent.removeExtra("callId")
        promise.resolve(map)
    }

    /**
     * F2 content-free push support: JS keeps a local chatId → display-name
     * directory so the native message notification can show the sender/chat
     * name WITHOUT any name ever riding inside the push payload.
     */
    @ReactMethod
    fun setChatDirectory(json: String) {
        reactApplicationContext
            .getSharedPreferences(VaultCallMessagingService.PREFS, Context.MODE_PRIVATE)
            .edit().putString(VaultCallMessagingService.KEY_CHAT_DIR, json).apply()
    }

    /** Clear a chat's message notification + unread counter (chat opened). */
    @ReactMethod
    fun clearMessageNotifs(chatId: String) {
        try {
            val ctx = reactApplicationContext
            (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager)
                .cancel(chatId, VaultCallMessagingService.MSG_NOTIF_ID)
            ctx.getSharedPreferences(VaultCallMessagingService.PREFS, Context.MODE_PRIVATE)
                .edit().remove("msg_count_$chatId").apply()
        } catch (_: Throwable) {}
    }
}
