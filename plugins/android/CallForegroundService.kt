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

        fun stop(ctx: Context) {
            val i = Intent(ctx, CallForegroundService::class.java).apply { action = ACTION_STOP }
            try { ctx.startService(i) } catch (_: Throwable) {}
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            releaseWakeLock()
            stopForegroundCompat()
            stopSelf()
            return START_NOT_STICKY
        }

        val callId = intent?.getStringExtra(EXTRA_CALL_ID) ?: ""
        val name = intent?.getStringExtra(EXTRA_NAME) ?: "VaultChat call"
        val isVideo = intent?.getBooleanExtra(EXTRA_VIDEO, false) ?: false

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
            .setContentTitle(if (isVideo) "VaultChat video call" else "VaultChat call")
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
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "VaultChat:call").apply {
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
