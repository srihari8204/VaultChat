package com.vaultchat.app.golive

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
 * Foreground service that keeps a GO LIVE BROADCAST publishing while the app is
 * backgrounded, and — critically — makes screen capture legal.
 *
 * WHY THIS EXISTS INSTEAD OF REUSING CallForegroundService
 * --------------------------------------------------------
 * That service is started and stopped by the CALL lifecycle. A broadcast is not
 * a call: there is no call id, no ringing, no CallModule.start(), so
 * CallForegroundService is simply NOT RUNNING while someone is live. Asking it
 * to carry mediaProjection for a broadcast would mean starting a service whose
 * notification says "VaultChat call • in progress" during a broadcast, and
 * teaching the call lifecycle about broadcasts — coupling the two products at
 * exactly the layer this whole change is separating them at.
 *
 * So Go Live gets its own service, its own channel and its own notification id.
 * Nothing about calling changes, and a broadcast and a call can legitimately run
 * their own foreground service at the same time.
 *
 * THE DEFECT THIS CLOSES
 * ----------------------
 * Android 10+ refuses MediaProjection.createVirtualDisplay() unless a foreground
 * service of type mediaProjection is running. Without one the screen track is
 * published, subscribers subscribe, and the encoder produces `encoded=0
 * size=0x0` — not a black frame, NO frame — because the VirtualDisplay has
 * nowhere legal to write. The same measurement is recorded for calls in
 * CallForegroundService.kt:128; Go Live would have reproduced it exactly.
 *
 * It also stops the more ordinary failure: a host who switches apps mid-stream
 * loses microphone and camera capture on Android 12+ within seconds, so the
 * broadcast goes silent and black while still reading LIVE to every viewer.
 */
class GoLiveForegroundService : Service() {

    companion object {
        // A CHANNEL OF ITS OWN. Sharing vaultchat_calls_ongoing would put
        // broadcasts under a channel the user may have muted for calls, and
        // "Ongoing calls" is the wrong words on the shade during a broadcast.
        const val CHANNEL_ID = "vaultchat_golive_ongoing"
        // Distinct from CallForegroundService.NOTIF_ID (0xCA11). Sharing the id
        // would make ending a broadcast cancel a live call's notification, and
        // vice versa.
        const val NOTIF_ID = 0x6011

        const val EXTRA_TITLE = "title"

        const val ACTION_START = "com.vaultchat.app.GOLIVE_FG_START"
        const val ACTION_STOP = "com.vaultchat.app.GOLIVE_FG_STOP"
        /** Promote the live broadcast service to also carry mediaProjection. */
        const val ACTION_PROJECTION = "com.vaultchat.app.GOLIVE_FG_PROJECTION"

        fun start(ctx: Context, title: String) {
            val i = Intent(ctx, GoLiveForegroundService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_TITLE, title)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
            else ctx.startService(i)
        }

        /**
         * Ask the running broadcast service to add the mediaProjection type.
         *
         * Ordering differs by version and that is why this is called TWICE
         * around a share. Android 10-13 needs the type BEFORE capture starts;
         * Android 14+ only permits the type once the user has already granted a
         * projection, so it must be called AGAIN after consent. Both calls are
         * idempotent and a refusal is swallowed — failing to add the type must
         * never take the broadcast down with it.
         */
        @JvmStatic
        fun allowProjection(ctx: Context) {
            try {
                val i = Intent(ctx, GoLiveForegroundService::class.java).setAction(ACTION_PROJECTION)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
                else ctx.startService(i)
            } catch (_: Throwable) {}
        }

        /**
         * STOPPING MUST WORK FROM THE BACKGROUND — that is the normal case.
         *
         * A broadcast ends with the app backgrounded far more often than not
         * (screen off, app switched, host force-quit). A bare startService
         * throws IllegalStateException on O+ when backgrounded; swallowed, the
         * intent is never delivered, the service keeps running and its
         * ONGOING notification stays on the shade forever. CallForegroundService
         * shipped exactly that bug and the fix is the same one: deliver via
         * startForegroundService, which is legal while backgrounded, and have
         * the ACTION_STOP branch satisfy the 5-second startForeground contract
         * before standing down.
         *
         * The notification is also cancelled directly, in case the service is
         * already dead and nothing would otherwise clear an entry the user
         * cannot swipe away.
         */
        fun stop(ctx: Context) {
            val i = Intent(ctx, GoLiveForegroundService::class.java).apply { action = ACTION_STOP }
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
                else ctx.startService(i)
            } catch (_: Throwable) {
                // Not running. Fall through and clear any stale notification.
            }
            try {
                (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIF_ID)
            } catch (_: Throwable) {}
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null
    /** Last broadcast title, so the projection promotion can reuse the chrome. */
    private var lastTitle: String = "VaultChat Live"

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            // Satisfy the startForegroundService contract before quitting, or
            // the OS kills the process with "did not call startForeground()".
            // Promoting with the same id and immediately removing it means the
            // notification never becomes visible.
            try { startForeground(NOTIF_ID, buildNotification(lastTitle)) } catch (_: Throwable) {}
            releaseWakeLock()
            stopForegroundCompat()
            try {
                (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIF_ID)
            } catch (_: Throwable) {}
            stopSelf()
            return START_NOT_STICKY
        }

        if (intent?.action == ACTION_PROJECTION) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ensureChannel()
                    startForeground(
                        NOTIF_ID,
                        buildNotification(lastTitle),
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                            or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
                            or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION,
                    )
                }
            } catch (_: Throwable) { /* 14+ before consent — retried after it */ }
            return START_STICKY
        }

        lastTitle = intent?.getStringExtra(EXTRA_TITLE)?.takeIf { it.isNotBlank() } ?: "VaultChat Live"

        ensureChannel()
        val notification = buildNotification(lastTitle)

        // Promote immediately, well under the 5s budget. camera|microphone from
        // the start because a broadcast publishes both — mediaProjection is
        // added later, only if the host actually shares their screen, so a
        // broadcast that never shares never asks for a capability it does not
        // use.
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIF_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                        or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA,
                )
            } else {
                startForeground(NOTIF_ID, notification)
            }
        } catch (e: Throwable) {
            // API 34 ForegroundServiceStartNotAllowedException. Fall back to a
            // plain foreground notification and let the broadcast proceed
            // best-effort rather than failing it outright.
            try { startForeground(NOTIF_ID, notification) } catch (_: Throwable) {}
        }

        acquireWakeLock()
        // START_NOT_STICKY, unlike CallForegroundService's START_STICKY.
        //
        // A restarted service would come back with a null intent and re-post
        // "You are live" — but the process it was publishing from is gone, so
        // there is no LiveKit room, no camera and no stream. The notification
        // would be a lie the user cannot dismiss (it is ONGOING), and the server
        // has already ended the broadcast by then anyway: the host's
        // participant_left fires the grace period in
        // internal/routes/golive_reaper.go.
        //
        // A call is different — CallKit/FCM can genuinely resurrect one — which
        // is why that service makes the opposite choice.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        releaseWakeLock()
        super.onDestroy()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            val ch = NotificationChannel(CHANNEL_ID, "Live broadcasts", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Keeps your broadcast publishing while VaultChat is in the background"
                setShowBadge(false)
            }
            nm.createNotificationChannel(ch)
        }
    }

    private fun buildNotification(title: String): Notification {
        val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            addCategory(Intent.CATEGORY_LAUNCHER)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pi = PendingIntent.getActivity(
            this, 0, launch ?: Intent(),
            PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0),
        )
        // Says LIVE, not "call". A host glancing at the shade must be able to
        // tell instantly that they are still broadcasting — this notification is
        // the only indication once the app is backgrounded.
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("You are live")
            .setContentText(title)
            .setSmallIcon(applicationInfo.icon)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setOngoing(true)
            .setUsesChronometer(true)
            .setContentIntent(pi)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "VaultChat:golive").apply {
            setReferenceCounted(false)
            // 4h rather than the call service's 1h: a broadcast is a much
            // longer-lived thing than a call, and the cap is only a safety net
            // against a leak — it is released on end either way.
            acquire(4 * 60 * 60 * 1000L)
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
