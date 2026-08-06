package com.vaultchat.app.vaultbeam

import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.net.NetworkRequest
import android.net.NetworkCapabilities
import android.os.Build
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * JS bridge for the Android 14+ user-initiated data transfer job.
 *
 *   isSupported()                    — does this device/API level offer UIDT jobs?
 *   start(estimatedBytes, upload)    — schedule the job for the active transfer set
 *   stop()                           — cancel it (last transfer finished)
 *   status()                         — { supported, scheduled, running, lastStopReason }
 *
 * `start` is idempotent by construction: the job id is a constant, so
 * rescheduling replaces the pending job rather than stacking a second one. The
 * caller can therefore refresh the byte estimate as the active set changes
 * without tracking whether it has already scheduled.
 *
 * MUST BE CALLED WHILE THE APP IS VISIBLE. `setUserInitiated(true)` throws if
 * the app is not in a state that permits it — which is correct and is why this
 * is scheduled at the moment the user starts a transfer, not lazily on the first
 * background tick. The JS side catches and falls back to the dataSync
 * foreground service, so a refusal degrades to today's behaviour rather than
 * dropping the transfer.
 */
class VaultBeamJobModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "VaultBeamJob"

    companion object {
        /** One constant id: scheduling again REPLACES, never stacks. */
        const val JOB_ID = 0x7B_11
        /** UIDT jobs arrived in Android 14 (API 34). */
        const val MIN_SDK = 34
    }

    private fun scheduler(): JobScheduler? =
        reactApplicationContext.getSystemService(Context.JOB_SCHEDULER_SERVICE) as? JobScheduler

    private fun supported(): Boolean = Build.VERSION.SDK_INT >= MIN_SDK && scheduler() != null

    private fun pending(): Boolean {
        val js = scheduler() ?: return false
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) js.getPendingJob(JOB_ID) != null
            else js.allPendingJobs.any { it.id == JOB_ID }
        } catch (_: Throwable) { false }
    }

    @ReactMethod
    fun isSupported(promise: Promise) = promise.resolve(supported())

    @ReactMethod
    fun status(promise: Promise) {
        val m = Arguments.createMap()
        m.putBoolean("supported", supported())
        m.putBoolean("scheduled", pending())
        m.putBoolean("running", VaultBeamTransferJobService.running)
        m.putInt("lastStopReason", VaultBeamTransferJobService.lastStopReason)
        promise.resolve(m)
    }

    /**
     * Schedule (or re-schedule) the transfer job.
     *
     * @param estimatedBytes total bytes still to move across active transfers.
     *        Android uses this to decide how to treat the job, so a rough
     *        number is worth far more than zero. Negative/absent is passed as
     *        UNKNOWN rather than as a lie.
     * @param upload true when the dominant direction is a send.
     */
    @ReactMethod
    fun start(estimatedBytes: Double, upload: Boolean, title: String, text: String, progressPct: Double, promise: Promise) {
        if (!supported()) { promise.resolve(false); return }
        val js = scheduler() ?: run { promise.resolve(false); return }
        try {
            // Seed the notification content BEFORE scheduling: onStartJob must
            // call setNotification immediately (the system stops a UIDT job that
            // does not), so it has to have something true to say by then.
            VaultBeamTransferJobService.title = title.ifEmpty { "Transferring file" }
            VaultBeamTransferJobService.text = text
            VaultBeamTransferJobService.progressPct = progressPct.toInt()
            VaultBeamTransferJobService.ensureChannel(reactApplicationContext)

            val bytes = if (estimatedBytes > 0) estimatedBytes.toLong() else JobInfo.NETWORK_BYTES_UNKNOWN

            // A user-initiated data transfer job MUST declare a network
            // constraint; without one the scheduler rejects it outright. ANY
            // network is correct here: VaultBeam's own policy layer decides
            // whether a given transfer may run on mobile data, and duplicating
            // that decision in the job constraint would make the two disagree.
            val network = NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .addCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                .build()

            val builder = JobInfo.Builder(JOB_ID, ComponentName(reactApplicationContext, VaultBeamTransferJobService::class.java))
                .setUserInitiated(true)
                .setRequiredNetwork(network)

            if (upload) builder.setEstimatedNetworkBytes(bytes, JobInfo.NETWORK_BYTES_UNKNOWN.toLong())
            else builder.setEstimatedNetworkBytes(JobInfo.NETWORK_BYTES_UNKNOWN.toLong(), bytes)

            val result = js.schedule(builder.build())
            promise.resolve(result == JobScheduler.RESULT_SUCCESS)
        } catch (t: Throwable) {
            // The commonest cause is scheduling while not visible enough to
            // qualify. Resolve false rather than rejecting: the JS side treats
            // this as "use the foreground service instead", and a rejection
            // would turn a graceful downgrade into a transfer-side error.
            promise.resolve(false)
        }
    }

    /**
     * Update the running job's notification. Cheap and safe to call on every
     * progress tick — it is a no-op unless a job is actually running.
     */
    @ReactMethod
    fun updateNotification(title: String, text: String, progressPct: Double, promise: Promise) {
        try {
            VaultBeamTransferJobService.title = title.ifEmpty { "Transferring file" }
            VaultBeamTransferJobService.text = text
            VaultBeamTransferJobService.progressPct = progressPct.toInt()
            VaultBeamTransferJobService.pushNotification()
            promise.resolve(true)
        } catch (t: Throwable) { promise.resolve(false) }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        try { scheduler()?.cancel(JOB_ID) } catch (_: Throwable) {}
        VaultBeamTransferJobService.running = false
        promise.resolve(true)
    }
}
