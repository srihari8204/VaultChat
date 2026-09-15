package com.vaultchat.app.calls

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

/**
 * Foreground service that keeps the WebRTC microphone (and camera, for video)
 * alive while a call is active — this is what stops audio dropping the moment
 * the app is backgrounded on Android 12+.
 *
 * Started with foregroundServiceType="microphone" (or "microphone|camera"). It
 * MUST call startForeground() with an ongoing notification within 5s of start
 * or Android kills it (and on API 34+ throws ForegroundServiceStartNotAllowed).
 * A partial WakeLock keeps the CPU running so audio doesn't stutter in doze.
 */
class CallForegroundService : Service() {

    companion object {
        const val CHANNEL_ID = "vaultchat_calls_ongoing"
        const val NOTIF_ID = 0xCA11
        const val EXTRA_CALL_ID = "callId"
        const val EXTRA_NAME = "callerName"
        const val EXTRA_VIDEO = "isVideo"

        const val ACTION_START = "com.vaultchat.app.CALL_FG_START"
        const val ACTION_STOP = "com.vaultchat.app.CALL_FG_STOP"
        /** Promote the live call service to also carry mediaProjection. */
        const val ACTION_PROJECTION = "com.vaultchat.app.CALL_FG_PROJECTION"

        /** Ask the running call service to add the mediaProjection type. */
        @JvmStatic
        fun allowProjection(ctx: Context) {
            try {
                val i = Intent(ctx, CallForegroundService::class.java).setAction(ACTION_PROJECTION)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
                else ctx.startService(i)
            } catch (_: Throwable) {}
        }

        fun start(ctx: Context, callId: String, callerName: String, isVideo: Boolean) {
            val i = Intent(ctx, CallForegroundService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_CALL_ID, callId)
                putExtra(EXTRA_NAME, callerName)
                putExtra(EXTRA_VIDEO, isVideo)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
            else ctx.startService(i)
        }

        /**
         * STOPPING MUST WORK FROM THE BACKGROUND — that is the normal case.
         *
         * This used to be a bare `startService`, which on O+ throws
         * IllegalStateException when the app is not in the foreground. The
         * throw was swallowed by the empty catch below, so the intent was never
         * delivered, the service kept running, and its ONGOING|NO_CLEAR
         * notification stayed on the shade forever. Calls end backgrounded far
         * more often than not (screen off, app switched, callee hung up), so
         * these accumulated: measured on the Nothing Phone as TWO live
         * `vaultchat_calls_ongoing` notifications with no call in progress and
         * no CallForegroundService in `dumpsys activity services`.
         *
         * startForegroundService is deliverable while backgrounded. It carries a
         * contract — the service MUST call startForeground within ~5s or the OS
         * kills the process with "did not call startForeground" — which is why
         * the ACTION_STOP branch promotes itself before standing down rather
         * than calling stopSelf immediately.
         *
         * The notification is also cancelled directly. stopForeground(REMOVE)
         * normally does it, but if the service is already dead (killed by the
         * OEM, or a previous leak) nothing would ever clear a NO_CLEAR entry the
         * user cannot swipe away.
         */
        fun stop(ctx: Context) {
            val i = Intent(ctx, CallForegroundService::class.java).apply { action = ACTION_STOP }
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
                else ctx.startService(i)
            } catch (_: Throwable) {
                // The service is not running (already stopped, or never started).
                // Nothing to stand down — but a stale notification may still be
                // on the shade, so fall through to the cancel below.
            }
            try {
                (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIF_ID)
            } catch (_: Throwable) {}
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null
    /** Last call's chrome, so the projection promotion can reuse it. */
    private var lastName: String = "crazzychat call"
    private var lastVideo: Boolean = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            // Satisfy the startForegroundService contract before standing down.
            //
            // stop() now delivers this via startForegroundService so it works
            // from the background, and that obliges us to call startForeground
            // within ~5s even though we are about to quit — otherwise the OS
            // kills the process with "did not call startForeground()". Promoting
            // with the same NOTIF_ID and immediately removing it is the standard
            // way out: the notification never becomes visible to the user.
            try { startForeground(NOTIF_ID, buildNotification("crazzychat call", false)) } catch (_: Throwable) {}
            releaseWakeLock()
            stopForegroundCompat()
            try {
                (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIF_ID)
            } catch (_: Throwable) {}
            stopSelf()
            return START_NOT_STICKY
        }

        // ── ADD THE mediaProjection TYPE ──────────────────────────────
        //
        // Android 10+ refuses MediaProjection.createVirtualDisplay() unless a
        // foreground service of type mediaProjection is running. Measured on
        // device: our service sat at types=0x000000C0 (camera|microphone) and
        // the screen track produced `encoded=0 size=0x0` — not a black frame, no
        // frame at all, because the VirtualDisplay had nowhere legal to write.
        //
        // The type is ADDED to the live call service rather than given its own
        // service: the call already owns the notification and the mic, and two
        // foreground services for one call is how OEM battery managers start
        // killing things.
        //
        // Ordering matters and differs by version. Android 14+ only permits this
        // type once the user has granted a projection, so this is invoked both
        // before capture (where 10-13 needs it) and again after consent (where
        // 14+ accepts it). Both calls are idempotent, and a refusal is caught:
        // a failure here must never take the CALL down with it.
        if (intent?.action == ACTION_PROJECTION) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ensureChannel()
                    startForeground(
                        NOTIF_ID,
                        buildNotification(lastName, lastVideo),
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                            or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
                            or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION,
                    )
                }
            } catch (_: Throwable) { /* 14+ before consent — retried after it */ }
            return START_STICKY
        }

        val callId = intent?.getStringExtra(EXTRA_CALL_ID) ?: ""
        val name = intent?.getStringExtra(EXTRA_NAME) ?: "crazzychat call"
        val isVideo = intent?.getBooleanExtra(EXTRA_VIDEO, false) ?: false
        lastName = name
        lastVideo = isVideo

        ensureChannel()
        val notification = buildNotification(name, isVideo)

        // CRITICAL: promote to foreground immediately (well under the 5s budget),
        // declaring the right service type so the OS keeps mic/camera capture.
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val type = if (isVideo)
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
                else
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                startForeground(NOTIF_ID, notification, type)
            } else {
                startForeground(NOTIF_ID, notification)
            }
        } catch (e: Throwable) {
            // API 34 ForegroundServiceStartNotAllowedException (e.g. started from
            // the background without a qualifying exemption). Fall back to a plain
            // foreground notification and let the call proceed best-effort.
            try { startForeground(NOTIF_ID, notification) } catch (_: Throwable) {}
        }

        acquireWakeLock()
        return START_STICKY
    }

    override fun onDestroy() {
        releaseWakeLock()
        super.onDestroy()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            val ch = NotificationChannel(CHANNEL_ID, "Ongoing calls", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Keeps a call connected in the background"
                setShowBadge(false)
            }
            nm.createNotificationChannel(ch)
        }
    }

    private fun buildNotification(name: String, isVideo: Boolean): Notification {
        val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            addCategory(Intent.CATEGORY_LAUNCHER)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pi = PendingIntent.getActivity(
            this, 0, launch ?: Intent(),
            PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0),
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(if (isVideo) "crazzychat video call" else "crazzychat call")
            .setContentText("$name • in progress")
            .setSmallIcon(applicationInfo.icon)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setUsesChronometer(true)
            .setContentIntent(pi)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "crazzychat:call").apply {
            setReferenceCounted(false)
            acquire(60 * 60 * 1000L) // 1h safety cap; released on call end
        }
    }

    private fun releaseWakeLock() {
        try { if (wakeLock?.isHeld == true) wakeLock?.release() } catch (_: Throwable) {}
        wakeLock = null
    }

    private fun stopForegroundCompat() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
            else @Suppress("DEPRECATION") stopForeground(true)
        } catch (_: Throwable) {}
    }
}
