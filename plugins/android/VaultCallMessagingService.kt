package com.vaultchat.app.calls

import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.Rect
import android.media.AudioManager
import android.media.RingtoneManager
import android.os.Build
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import com.facebook.react.HeadlessJsTaskService
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.vaultchat.app.sync.VaultChatSyncService
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread
import kotlin.math.abs

/**
 * Native FCM handler. Runs from a COLD START (app killed) because Android starts
 * the FirebaseMessagingService process for a data-only high-priority message and
 * calls onMessageReceived — without needing the React Native JS runtime alive.
 *
 * On type="incoming_call" it immediately:
 *   1. wakes the screen,
 *   2. starts the call foreground service,
 *   3. posts a full-screen-intent CATEGORY_CALL notification with the caller's
 *      NAME (content title) and DP (large icon, loaded async with an initials
 *      fallback), plus Answer/Decline actions.
 * On type="call_cancelled" it cancels the ring.
 */
class VaultCallMessagingService : FirebaseMessagingService() {

    companion object {
        const val INCOMING_CHANNEL = "vaultchat_incoming_calls"
        const val MISSED_CHANNEL = "vaultchat_missed_calls"
        const val MESSAGES_CHANNEL = "vaultchat_messages"
        const val GAMES_CHANNEL = "vaultchat_games"
        const val INCOMING_NOTIF_ID = 0xC411
        const val MISSED_NOTIF_ID = 0xC412
        const val MSG_NOTIF_ID = 0xC413
        const val GAMES_NOTIF_ID = 0xC414
        const val PREFS = "vaultchat_call_prefs"
        const val KEY_FCM = "fcm_token"
        const val KEY_CHAT_DIR = "chat_dir"          // JSON map chatId → display name (set by JS)

        const val ACTION_ANSWER = "com.vaultchat.app.CALL_ANSWER"
        const val ACTION_DECLINE = "com.vaultchat.app.CALL_DECLINE"
    }

    override fun onNewToken(token: String) {
        // The backend register call needs the user's JWT, which lives in JS. Save
        // the token; CallModule.getFcmToken() lets JS read + POST /call/token.
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_FCM, token).apply()
    }

    override fun onMessageReceived(msg: RemoteMessage) {
        val data = msg.data
        when (data["type"]) {
            "incoming_call" -> showIncoming(data)
            "games_turn" -> showGameTurn(data)
            "call_cancelled" -> handleCancel(data["callId"])
            "screenshot" -> showScreenshot(data)
            "message" -> {
                // A notification alone left the sender on ONE TICK: nothing
                // synced and nothing was acknowledged until the user opened the
                // app. Wake the JS sync first, then draw the notification.
                if (!isAppForeground()) startBackgroundSync(data)
                showMessage(data)
            }
        }
    }

    /**
     * Hand the push to lib/syncBackground.ts, which drains the delta through the
     * existing sync engine and acknowledges delivery only after the rows are on
     * disk. This class stays out of the sync itself on purpose.
     *
     * Foreground is the caller's check: the app is already syncing over its
     * socket, and HeadlessJsTaskService refuses to start in the foreground.
     *
     * Failure here must never cost the notification, so it is best-effort. If
     * Android refuses the background start the user still sees the message and
     * the next ordinary sync collects it — FCM is a wake-up, not the source of
     * truth.
     */
    private fun startBackgroundSync(data: Map<String, String>) {
        try {
            val intent = Intent(this, VaultChatSyncService::class.java)
            for ((k, v) in data) intent.putExtra(k, v)
            startService(intent)
            // Keeps the CPU up between startService() and the JS task actually
            // taking its own wake lock; released by HeadlessJsTaskService.
            HeadlessJsTaskService.acquireWakeLockNow(this)
        } catch (t: Throwable) {
            Log.w("VaultChatSync", "background sync start refused: ${t.javaClass.simpleName}")
        }
    }

    /**
     * WhatsApp-style content-free doorbell (F2). The push carries ONLY
     * { type:"message", chatId } — no sender name, no body, no message type —
     * so nothing readable ever transits Google FCM. The notification's title
     * (chat/sender name) is resolved LOCALLY from the chat directory JS keeps
     * in SharedPreferences. When the app is in the FOREGROUND the in-app socket
     * path already presents the message, so we skip the status-bar notification.
     */
    private fun showMessage(data: Map<String, String>) {
        val chatId = data["chatId"] ?: return
        if (isAppForeground()) return

        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val title = try {
            org.json.JSONObject(prefs.getString(KEY_CHAT_DIR, "{}") ?: "{}").optString(chatId, "")
        } catch (_: Throwable) { "" }.ifBlank { "VaultChat" }

        // Per-chat unread counter → "New message" / "N new messages". Cleared by
        // CallModule.clearMessageNotifs(chatId) when JS opens the chat.
        val countKey = "msg_count_$chatId"
        val count = prefs.getInt(countKey, 0) + 1
        prefs.edit().putInt(countKey, count).apply()

        // Use the recipient's per-chat sound channel when it exists (created by
        // the JS notifee setup); otherwise the default messages channel. Posting
        // to a non-existent channel silently drops the notification on O+.
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        var channel = data["channelId"] ?: ""
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            (channel.isBlank() || nm.getNotificationChannel(channel) == null)) {
            ensureMessagesChannel()
            channel = MESSAGES_CHANNEL
        } else if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            channel = MESSAGES_CHANNEL
        }

        val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("vc_action", "open_chat")
            putExtra("vc_chat_id", chatId)
        } ?: Intent()
        // Unique request code per chat so PendingIntents don't overwrite each other.
        val pi = PendingIntent.getActivity(this, chatId.hashCode(), launch, piFlags())

        val n = NotificationCompat.Builder(this, channel)
            .setSmallIcon(applicationInfo.icon)
            .setContentTitle(title)
            .setContentText(if (count > 1) "$count new messages" else "New message")
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .setNumber(count)
            .build()
        // Tag by chatId: one collapsed notification per chat (newest replaces).
        nm.notify(chatId, MSG_NOTIF_ID, n)
    }

    /**
     * "Someone screenshotted your chat."
     *
     * The socket event this accompanies only reaches a device that has THAT
     * chat open at that moment, which is the least likely state to be in when
     * somebody screenshots you. This covers every other state.
     *
     * Content-free like the message doorbell: the push carries only
     * { type:"screenshot", chatId }, so neither the chat name nor the
     * capturer's name transits Google. The title is resolved locally from the
     * chat directory JS keeps in SharedPreferences.
     *
     * Foreground is skipped for the same reason showMessage skips it: the
     * in-app banner has already said this, and two alerts for one event reads
     * like two screenshots.
     *
     * NOT tagged by chatId and NOT collapsed, unlike messages: three
     * screenshots is materially different information from one, and a
     * collapsing "3 new" counter would hide when they happened.
     */
    private fun showScreenshot(data: Map<String, String>) {
        val chatId = data["chatId"] ?: return
        if (isAppForeground()) return

        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val who = try {
            org.json.JSONObject(prefs.getString(KEY_CHAT_DIR, "{}") ?: "{}").optString(chatId, "")
        } catch (_: Throwable) { "" }

        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        ensureMessagesChannel()

        val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("vc_action", "open_chat")
            putExtra("vc_chat_id", chatId)
        } ?: Intent()
        val pi = PendingIntent.getActivity(this, ("ss" + chatId).hashCode(), launch, piFlags())

        val n = NotificationCompat.Builder(this, MESSAGES_CHANNEL)
            .setSmallIcon(applicationInfo.icon)
            .setContentTitle(if (who.isBlank()) "Screenshot taken" else "Screenshot in $who")
            .setContentText("Someone took a screenshot of this chat.")
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        nm.notify("ss:" + chatId, MSG_NOTIF_ID, n)
    }

    /**
     * VaultGames turn / invite nudge (POST /games/notify → fcm).
     *
     * This is what makes ASYNCHRONOUS play possible. The games platform has ~19
     * players and almost never two online at once, so a match that needs both
     * present at the same moment is a match that ends in a bot offer. Your
     * opponent moves, this fires hours later, and the tap has to land on the
     * exact table — anything less and the player has to go hunting for their own
     * game, which is the same as not being told.
     *
     * NOT suppressed in the foreground, unlike showMessage: the games server
     * already refuses to notify a player who is currently connected to it, so a
     * push that reaches us is by definition for someone who is not looking at
     * that table — even if VaultChat itself happens to be open.
     */
    private fun showGameTurn(data: Map<String, String>) {
        val game = data["game"].orEmpty()
        val room = data["room"].orEmpty()
        val title = data["title"]?.ifBlank { null } ?: "VaultGames"
        val body = data["body"]?.ifBlank { null } ?: "It is your turn"

        ensureGamesChannel()

        val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("vc_action", "open_game")
            putExtra("vc_game", game)
            putExtra("vc_room", room)
        } ?: Intent()
        // Request code per table, so two games waiting on you keep two distinct
        // PendingIntents instead of the newer one silently retargeting the older.
        val pi = PendingIntent.getActivity(this, ("g:$room").hashCode(), launch, piFlags())

        val n = NotificationCompat.Builder(this, GAMES_CHANNEL)
            .setSmallIcon(applicationInfo.icon)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setCategory(NotificationCompat.CATEGORY_SOCIAL)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        // Tagged by table: a second nudge for the same game replaces the first
        // rather than stacking, while a different table gets its own line.
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .notify(room.ifBlank { "games" }, GAMES_NOTIF_ID, n)
    }

    private fun ensureGamesChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(GAMES_CHANNEL) == null) {
            // IMPORTANCE_DEFAULT, not HIGH: a turn in an asynchronous board game
            // is not worth a heads-up banner over whatever the user is doing.
            nm.createNotificationChannel(NotificationChannel(GAMES_CHANNEL, "Games", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Your turn, invites and friend requests in VaultGames"
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            })
        }
    }

    private fun isAppForeground(): Boolean = try {
        val am = getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
        am.runningAppProcesses?.any {
            it.pid == android.os.Process.myPid() &&
            it.importance <= android.app.ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
        } == true
    } catch (_: Throwable) { false }

    private fun ensureMessagesChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(MESSAGES_CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(MESSAGES_CHANNEL, "Messages", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "New message notifications"
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            })
        }
    }

    /**
     * Caller hung up / timed out. Clear the ring; if it was NEVER answered (the
     * app didn't call dismissIncoming → answered marker), turn it into a
     * "Missed call" notification with the caller's saved name + DP.
     */
    private fun handleCancel(callId: String?) {
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(INCOMING_NOTIF_ID)
        CallForegroundService.stop(this)

        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val pending = prefs.getString("ring_callId", null)
        if (pending != null && (callId == null || pending == callId)) {
            val name = prefs.getString("ring_name", "VaultChat user") ?: "VaultChat user"
            val dpUrl = prefs.getString("ring_dp", "") ?: ""
            val video = prefs.getBoolean("ring_video", false)
            postMissed(name, dpUrl, video)
            prefs.edit().remove("ring_callId").remove("ring_name").remove("ring_dp").remove("ring_video").apply()
        }
    }

    /**
     * Is our own process in the foreground right now?
     *
     * When it is, the JS layer already has the socket event and shows the in-app
     * ring screen, so posting an OS notification on top produces the SECOND
     * notification users see. Asking the OS is enough — it needs no bridge to JS
     * and works from a cold FCM delivery, where no JS runtime exists to ask.
     */
    private fun appInForeground(): Boolean = try {
        val am = getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
        am.runningAppProcesses?.any {
            it.processName == packageName &&
                it.importance == android.app.ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
        } ?: false
    } catch (_: Throwable) { false }   // unknown → post it; a missed ring is worse than a duplicate

    private fun showIncoming(data: Map<String, String>) {
        val callId = data["callId"] ?: return
        val callerId = data["callerId"] ?: ""

        // ONE OWNER FOR THE OS RING.
        //
        // Two independent systems were ringing: this service (FCM → full-screen
        // notification, WITH the caller's photo) and the JS/notifee layer
        // (channel "calls", no photo). Confirmed on device during a live ring —
        // id=50193 channel=vaultchat_incoming_calls alongside the notifee entry
        // on channel=calls. The server tried to arbitrate by skipping the push
        // when the callee had a live socket, but a backgrounded phone's socket
        // drops and reconnects across the caller's 3s re-rings, so both fired.
        //
        // Arbitrating on the DEVICE removes the race: whoever owns the screen
        // owns the ring. Foreground → JS shows the in-app screen and we stay
        // out. Anything else → we ring, because JS may not even be running.
        if (appInForeground()) return

        val name = data["callerName"]?.ifBlank { "VaultChat user" } ?: "VaultChat user"
        val dpUrl = data["callerDpUrl"] ?: ""
        val isVideo = data["isVideo"] == "true"

        // Remember who is ringing so an unanswered cancel becomes a missed call.
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("ring_callId", callId).putString("ring_name", name)
            .putString("ring_dp", dpUrl).putBoolean("ring_video", isVideo).apply()

        wakeScreen()
        ensureChannel()

        // Post the ring immediately with an initials fallback so it never waits
        // on the network; swap in the real DP when it loads.
        val fallback = initialsBitmap(name)
        notifyIncoming(callId, callerId, name, isVideo, fallback)

        if (dpUrl.isNotBlank()) {
            thread(name = "vc-dp-load") {
                val bmp = loadBitmap(absoluteUrl(dpUrl))
                if (bmp != null) notifyIncoming(callId, callerId, name, isVideo, circleCrop(bmp))
            }
        }
    }

    /** Lock-screen "Missed call from X" with a tap-to-open + the caller DP. */
    private fun postMissed(name: String, dpUrl: String, isVideo: Boolean) {
        ensureMissedChannel()
        val large = if (dpUrl.isNotBlank()) (loadBitmap(absoluteUrl(dpUrl))?.let { circleCrop(it) } ?: initialsBitmap(name)) else initialsBitmap(name)
        val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("vc_action", "open_calls")
        } ?: Intent()
        val pi = PendingIntent.getActivity(this, 9, launch, piFlags())
        val n = NotificationCompat.Builder(this, MISSED_CHANNEL)
            .setSmallIcon(applicationInfo.icon)
            .setContentTitle("Missed ${if (isVideo) "video " else ""}call")
            .setContentText(name)
            .setLargeIcon(large)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(MISSED_NOTIF_ID, n)
    }

    private fun ensureMissedChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(MISSED_CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(MISSED_CHANNEL, "Missed calls", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Notifications for missed VaultChat calls"
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            })
        }
    }

    private fun notifyIncoming(callId: String, callerId: String, name: String, isVideo: Boolean, large: Bitmap) {
        val pkg = packageName

        // Full-screen intent → MainActivity, routed by JS to the incoming-call UI.
        val fullScreen = packageManager.getLaunchIntentForPackage(pkg)?.apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("vc_action", "incoming_call")
            putExtra("callId", callId)
            putExtra("callerId", callerId)
            putExtra("callerName", name)
            putExtra("isVideo", isVideo)
        } ?: Intent()
        val fsPi = PendingIntent.getActivity(this, 1, fullScreen, piFlags())

        val answerIntent = Intent(fullScreen).apply { putExtra("vc_action", "answer") }
        val answerPi = PendingIntent.getActivity(this, 2, answerIntent, piFlags())

        val declinePi = PendingIntent.getBroadcast(
            this, 3,
            Intent(this, CallActionReceiver::class.java).apply {
                action = ACTION_DECLINE; putExtra("callId", callId)
            },
            piFlags(),
        )

        val n: Notification = NotificationCompat.Builder(this, INCOMING_CHANNEL)
            .setSmallIcon(applicationInfo.icon)
            .setContentTitle(name)
            .setContentText(if (isVideo) "VaultChat video call" else "VaultChat audio call")
            .setLargeIcon(large)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setOngoing(true)
            .setAutoCancel(false)
            .setFullScreenIntent(fsPi, true)            // shows over the lock screen
            .setContentIntent(fsPi)
            .addAction(applicationInfo.icon, "Decline", declinePi)
            .addAction(applicationInfo.icon, "Answer", answerPi)
            .setVibrate(longArrayOf(0, 800, 600, 800, 600))
            .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), AudioManager.STREAM_RING)
            .setTimeoutAfter(35_000)
            .build()

        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(INCOMING_NOTIF_ID, n)
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(INCOMING_CHANNEL) == null) {
            val ch = NotificationChannel(INCOMING_CHANNEL, "Incoming calls", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Rings for incoming VaultChat calls"
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 800, 600, 800, 600)
                setBypassDnd(true)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                setSound(
                    RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                    android.media.AudioAttributes.Builder()
                        .setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION).build(),
                )
            }
            nm.createNotificationChannel(ch)
        }
    }

    @Suppress("DEPRECATION")
    private fun wakeScreen() {
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            pm.newWakeLock(
                PowerManager.FULL_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE,
                "VaultChat:ring",
            ).apply { acquire(10_000) }
            val km = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) km.newKeyguardLock("VaultChat").disableKeyguard()
        } catch (_: Throwable) {}
    }

    private fun absoluteUrl(url: String): String {
        if (url.startsWith("http")) return url
        val base = getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("api_base", "") ?: ""
        return if (base.isNotBlank()) base.trimEnd('/') + "/" + url.trimStart('/') else url
    }

    private fun loadBitmap(url: String): Bitmap? = try {
        val token = getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("access_token", null)
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 4000; readTimeout = 4000
            if (!token.isNullOrBlank()) setRequestProperty("Authorization", "Bearer $token")
        }
        conn.inputStream.use { BitmapFactory.decodeStream(it) }
    } catch (_: Throwable) { null }

    private fun circleCrop(src: Bitmap): Bitmap {
        val size = minOf(src.width, src.height)
        val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(out)
        val paint = Paint().apply { isAntiAlias = true }
        canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint)
        paint.xfermode = android.graphics.PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
        val left = (src.width - size) / 2; val top = (src.height - size) / 2
        canvas.drawBitmap(src, Rect(left, top, left + size, top + size), Rect(0, 0, size, size), paint)
        return out
    }

    private fun initialsBitmap(name: String): Bitmap {
        val size = 256
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        val palette = intArrayOf(0xFF9D6FD0.toInt(), 0xFF7E57C2.toInt(), 0xFF5C6BC0.toInt(), 0xFF26A69A.toInt(), 0xFFEF5350.toInt())
        val bg = palette[abs(name.hashCode()) % palette.size]
        val circle = Paint().apply { isAntiAlias = true; color = bg }
        canvas.drawCircle(size / 2f, size / 2f, size / 2f, circle)
        val initial = name.trim().firstOrNull()?.uppercaseChar()?.toString() ?: "?"
        val text = Paint().apply {
            isAntiAlias = true; color = Color.WHITE; textSize = size * 0.45f
            textAlign = Paint.Align.CENTER; isFakeBoldText = true
        }
        val y = size / 2f - (text.descent() + text.ascent()) / 2f
        canvas.drawText(initial, size / 2f, y, text)
        return bmp
    }

    private fun piFlags(): Int =
        PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
}

/** Handles the Decline action without opening the app. */
class CallActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .cancel(VaultCallMessagingService.INCOMING_NOTIF_ID)
        CallForegroundService.stop(context)
        // Best-effort: persist a "declined" marker the JS reads on next launch to
        // notify the caller over the socket. (A killed app can't open a socket here.)
        context.getSharedPreferences(VaultCallMessagingService.PREFS, Context.MODE_PRIVATE)
            .edit().putString("declined_call", intent.getStringExtra("callId")).apply()
    }
}
