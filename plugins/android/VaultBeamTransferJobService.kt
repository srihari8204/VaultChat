package com.vaultchat.app.vaultbeam

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobParameters
import android.app.job.JobService
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * The Android 14+ **user-initiated data transfer** job that keeps a VaultBeam
 * transfer alive.
 *
 * WHY THIS EXISTS INSTEAD OF THE dataSync FOREGROUND SERVICE
 * ---------------------------------------------------------
 * Transfers currently ride the shared Notifee foreground service, whose type is
 * `dataSync`. From Android 15 (targetSdk 35) `dataSync` is capped at six hours
 * per 24-hour period ACROSS THE WHOLE APP: past that the system calls
 * `Service.onTimeout()` and the service must stop or the app is killed. That
 * budget is shared with the no-GMS socket connection, so a long transfer does
 * not even get the full six hours — and a 12 GB file on a slow link can want
 * more than what is left.
 *
 * User-initiated data transfer jobs are the mechanism Android provides for
 * exactly this case. They are outside the `dataSync` cap, they may only be
 * scheduled while the app is visible — which is precisely when a user starts a
 * file transfer — and they carry a notification the user can act on.
 *
 * THE NOTIFICATION IS NOT OPTIONAL
 * -------------------------------
 * A user-initiated data transfer job MUST call `setNotification()`, and the
 * system stops the job if it does not. That is why the progress notification
 * moves here from Notifee while the job is running: two mechanisms posting two
 * notifications for one transfer would be the alternative, and the system's
 * requirement is not negotiable. When the job is not carrying the transfer
 * (API < 34, or a schedule the system refused) the JS side keeps posting the
 * Notifee one exactly as before.
 *
 * THIS SERVICE DOES NOT MOVE BYTES
 * -------------------------------
 * The transfer runs where it already ran: the JS engine plus the native worker
 * threads. This job holds the process at foreground priority and gives the
 * transfer a user-visible identity. So `onStartJob` returns true and then waits.
 * Duplicating the transfer loop here would create a second owner of transfer
 * state, which is the thing the Transfer Manager exists to prevent.
 *
 * LIFECYCLE
 * ---------
 * `onStopJob` returns false — do not reschedule. The system stops this job when
 * the user cancels it or when its network constraint is lost. Rescheduling
 * would fight the user in the first case and spin in the second. Transfer state
 * is durable, so the JS side resumes the work when it decides to, not when the
 * scheduler does.
 */
class VaultBeamTransferJobService : JobService() {

    companion object {
        const val TAG = "VaultBeamJob"
        const val CHANNEL_ID = "vaultchat_transfer"
        const val NOTIF_ID = 0x7B12

        /** Live while a scheduled job is running. Read by the JS module. */
        @Volatile @JvmStatic var running: Boolean = false
        /** Last reason the system stopped us, or -1. */
        @Volatile @JvmStatic var lastStopReason: Int = -1

        /** Current notification content, owned by the JS side via the module. */
        @Volatile @JvmStatic var title: String = "Transferring file"
        @Volatile @JvmStatic var text: String = ""
        @Volatile @JvmStatic var progressPct: Int = -1

        /** The running job's params, so progress can be pushed after start. */
        @Volatile @JvmStatic private var liveParams: JobParameters? = null
        @Volatile @JvmStatic private var liveService: VaultBeamTransferJobService? = null

        /**
         * Push new content into the running job's notification. A no-op when no
         * job is running, which is the normal case on older API levels.
         */
        @JvmStatic
        fun pushNotification() {
            val svc = liveService ?: return
            val params = liveParams ?: return
            try { svc.publish(params) } catch (t: Throwable) { Log.w(TAG, "notification update failed: ${t.message}") }
        }

        @JvmStatic
        fun ensureChannel(ctx: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
            if (nm.getNotificationChannel(CHANNEL_ID) != null) return
            // LOW: an ongoing transfer should be visible, never noisy. Matches
            // the importance lib/transferForeground.ts uses for the Notifee one,
            // so the user sees the same weight of notification either way.
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "File transfers", NotificationManager.IMPORTANCE_LOW),
            )
        }
    }

    private fun build(): Notification {
        ensureChannel(this)
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val tap = if (launch != null) {
            PendingIntent.getActivity(this, 0, launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), flags)
        } else null

        val b = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(applicationInfo.icon)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
        if (tap != null) b.setContentIntent(tap)
        val pct = progressPct
        // A negative percentage means "we do not know yet" and gets an
        // indeterminate bar, rather than a confident 0% that never moves.
        if (pct in 0..100) b.setProgress(100, pct, false) else b.setProgress(0, 0, true)
        return b.build()
    }

    private fun publish(params: JobParameters) {
        if (Build.VERSION.SDK_INT < 34) return
        setNotification(
            params, NOTIF_ID, build(),
            // REMOVE, not DETACH: when the job ends the transfer is over, and the
            // JS side posts whatever terminal state belongs there. Leaving a
            // detached "Transferring…" behind would outlive the thing it
            // describes.
            JobService.JOB_END_NOTIFICATION_POLICY_REMOVE,
        )
    }

    override fun onStartJob(params: JobParameters?): Boolean {
        running = true
        lastStopReason = -1
        liveParams = params
        liveService = this
        Log.i(TAG, "user-initiated transfer job started (id=${params?.jobId})")
        // MANDATORY for a user-initiated data transfer job: without it the
        // system stops the job almost immediately.
        if (params != null) {
            try { publish(params) } catch (t: Throwable) { Log.w(TAG, "setNotification failed: ${t.message}") }
        }
        // true = work continues on another thread. It genuinely does: the RN
        // instance and the native transfer workers are that thread.
        return true
    }

    override fun onStopJob(params: JobParameters?): Boolean {
        running = false
        liveParams = null
        liveService = null
        lastStopReason = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try { params?.stopReason ?: -1 } catch (_: Throwable) { -1 }
        } else -1
        Log.i(TAG, "user-initiated transfer job stopped (reason=$lastStopReason)")
        return false
    }
}
