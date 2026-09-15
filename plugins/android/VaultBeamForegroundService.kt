package com.vaultchat.app.vaultbeam

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
 * Keeps VaultBeam transfers running while the app is backgrounded or the screen
 * is locked.
 *
 * THE DEFECT THIS CLOSES
 * ----------------------
 * The transfer engine is JavaScript in the RN runtime. Android suspends that
 * runtime shortly after the app leaves the foreground, and Doze finishes the
 * job — so a transfer simply stopped when the user pressed Home. Measured in
 * production: a 2.24 GB send advanced from 160 to 224 blocks in EIGHT HOURS,
 * i.e. it died the moment the app went to background and only ever moved again
 * when someone reopened it. Nothing was lost — the bitmap and persisted send
 * mean it resumes — but "resumes when you look at it" is not a file transfer.
 *
 * A foreground service of type dataSync is the only sanctioned way to keep that
 * runtime alive. FOREGROUND_SERVICE_DATA_SYNC is already declared in the
 * manifest, so this adds no new permission.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is NOT a transfer engine. It holds no chunks, no keys, no bitmap, no
 * sockets; it never touches WebRTC, ICE, TURN, R2 signing or crypto. It owns
 * exactly one thing: process lifetime, plus the notification that legally buys
 * it. All transfer truth stays in VaultBeam, which is already authoritative and
 * already persists across process death.
 *
 * That separation is deliberate. If this service ever grew its own idea of
 * progress, there would be two sources of truth for the same transfer and they
 * would disagree the first time one was killed.
 *
 * ONE SERVICE, ONE NOTIFICATION
 * -----------------------------
 * Several transfers can be in flight at once. They share this service and a
 * single consolidated notification — never one service per transfer, and never
 * one per chunk. JS owns the summary text because JS is where the transfer
 * state lives; the service just renders whatever it was last told.
 *
 * WHAT IT CANNOT PROMISE
 * ----------------------
 * A foreground service is not immunity. Aggressive OEM battery managers —
 * Xiaomi/MIUI especially — still kill background work regardless of service
 * type, and that is the user's setting to grant, not something to work around.
 * When Android does kill us, START_NOT_STICKY is deliberate: relaunching this
 * service without the JS runtime would produce a notification for a transfer
 * that is not running. Recovery belongs to VaultBeam's own hydrate-and-resume
 * path on next launch.
 */
class VaultBeamForegroundService : Service() {

    companion object {
        const val CHANNEL_ID = "vaultchat_vaultbeam_transfers"
        const val NOTIF_ID = 0x7B11

        const val ACTION_START = "com.vaultchat.app.VAULTBEAM_FG_START"
        const val ACTION_UPDATE = "com.vaultchat.app.VAULTBEAM_FG_UPDATE"
        const val ACTION_STOP = "com.vaultchat.app.VAULTBEAM_FG_STOP"
        const val ACTION_CANCEL = "com.vaultchat.app.VAULTBEAM_FG_CANCEL"

        const val EXTRA_TITLE = "title"
        const val EXTRA_TEXT = "text"

        /**
         * Invoked when the user taps Cancel on the notification.
         *
         * Same-process callback rather than a broadcast: the module and the
         * service live in one process, and the handler's only job is to reach
         * VaultBeam's existing AbortSignal path. The service must never cancel
         * a transfer itself — it has no idea what a transfer is.
         */
        @Volatile
        @JvmStatic
        var onCancelRequested: (() -> Unit)? = null

        fun start(ctx: Context, title: String, text: String) {
            val i = Intent(ctx, VaultBeamForegroundService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_TITLE, title)
                putExtra(EXTRA_TEXT, text)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
            else ctx.startService(i)
        }

        /** Re-render the notification. Cheap: no service restart, no re-promotion. */
        fun update(ctx: Context, title: String, text: String) {
            val i = Intent(ctx, VaultBeamForegroundService::class.java).apply {
                action = ACTION_UPDATE
                putExtra(EXTRA_TITLE, title)
                putExtra(EXTRA_TEXT, text)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
            else ctx.startService(i)
        }

        fun stop(ctx: Context) {
            val i = Intent(ctx, VaultBeamForegroundService::class.java).apply { action = ACTION_STOP }
            // Still routed through startService: a stop delivered as a start
            // intent lets onStartCommand satisfy the 5-second startForeground
            // contract before stopping, which is what avoids the OS killing the
            // process with "did not call startForeground()".
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
            else ctx.startService(i)
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var lastTitle = "VaultBeam"
    private var lastText = "Transferring…"

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                // Promote first, THEN stop. See the comment in stop() above.
                try { startForeground(NOTIF_ID, buildNotification(lastTitle, lastText)) } catch (_: Throwable) {}
                releaseWakeLock()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_CANCEL -> {
                // Hand straight to VaultBeam. If nothing is registered we do
                // nothing rather than guess — a service must not invent a
                // cancellation the app never asked for.
                try { onCancelRequested?.invoke() } catch (_: Throwable) {}
                return START_NOT_STICKY
            }
        }

        lastTitle = intent?.getStringExtra(EXTRA_TITLE) ?: lastTitle
        lastText = intent?.getStringExtra(EXTRA_TEXT) ?: lastText

        val notification = buildNotification(lastTitle, lastText)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else {
                startForeground(NOTIF_ID, notification)
            }
        } catch (_: Throwable) {
            // A promotion refused (background-start restrictions, missing
            // permission) must not crash the app. The transfer still runs while
            // the app is foreground; it simply loses background protection.
            try { startForeground(NOTIF_ID, notification) } catch (_: Throwable) {}
        }

        acquireWakeLock()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        releaseWakeLock()
        VaultBeamForegroundService.onCancelRequested = null
        super.onDestroy()
    }

    // ── notification ────────────────────────────────────────────────
    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val ch = NotificationChannel(
            CHANNEL_ID,
            "File transfers",
            // LOW: an ongoing transfer must be visible, not noisy. It updates
            // every progress tick, and IMPORTANCE_DEFAULT would buzz each time.
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Shows VaultBeam transfers that are running in the background"
            setShowBadge(false)
            enableVibration(false)
            setSound(null, null)
        }
        nm.createNotificationChannel(ch)
    }

    private fun buildNotification(title: String, text: String): Notification {
        ensureChannel()

        val openIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val contentPi = if (openIntent != null) {
            PendingIntent.getActivity(this, 0, openIntent, flags)
        } else null

        val cancelPi = PendingIntent.getService(
            this, 1,
            Intent(this, VaultBeamForegroundService::class.java).setAction(ACTION_CANCEL),
            flags,
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            // The text carries a size and a percentage and can outrun one line.
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            // No file name, no peer, no URL: a lock screen is a public surface
            // and this notification is visible on it.
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .apply { if (contentPi != null) setContentIntent(contentPi) }
            .addAction(0, "Cancel", cancelPi)
            .build()
    }

    // ── wake lock ───────────────────────────────────────────────────
    // A foreground service keeps the PROCESS alive; it does not keep the CPU
    // awake once the screen is off. Without this the JS runtime is descheduled
    // on a locked device and the transfer crawls. Released on every exit path,
    // and bounded by the service's own lifetime — the service stops as soon as
    // no transfer is active, so this cannot outlive the work it exists for.
    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "crazzychat:vaultbeam").apply {
                setReferenceCounted(false)
                acquire(4L * 60L * 60L * 1000L)   // hard ceiling; stop() releases far sooner
            }
        } catch (_: Throwable) {}
    }

    private fun releaseWakeLock() {
        try { if (wakeLock?.isHeld == true) wakeLock?.release() } catch (_: Throwable) {}
        wakeLock = null
    }
}
