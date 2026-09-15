package com.vaultchat.app.sync

import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Runs lib/syncBackground.ts when a chat FCM message arrives.
 *
 * WHY THIS EXISTS
 *
 * VaultCallMessagingService used to post a notification and stop. Nothing
 * synced and nothing acknowledged, so the sender stayed on ONE TICK until the
 * recipient opened the app — a message could sit undelivered for hours with the
 * device online and its FCM token valid.
 *
 * The JS side does the actual work through the existing sync engine; this class
 * only gives it a process to run in. It deliberately owns no sync logic: a
 * second implementation is how two cursors drift apart.
 *
 * BACKGROUND-START RULES
 *
 * Android 8+ forbids starting a background service from the background, but a
 * HIGH priority FCM data message grants a short exemption — which is exactly
 * when this is started. The server already sends android.priority=HIGH
 * (internal/fcm SendCallMessage), so the exemption applies.
 *
 * Foreground execution is allowed: activity importance does not prove that the
 * realtime connection is healthy. The shared JS sync engine coalesces callers.
 */
class VaultChatSyncService : HeadlessJsTaskService() {

    // Service-start refusals must not crash the notification process. Sync
    // retries on the next push/reconnect; foreground execution itself is allowed.
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int =
        try {
            super.onStartCommand(intent, flags, startId)
        } catch (e: IllegalStateException) {
            stopSelf(startId)
            START_NOT_STICKY
        }

    // Signature must match React Native's exactly — protected, and the Intent is
    // NULLABLE (Android may redeliver a null intent after the process is killed).
    protected override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
        // No intent or no extras means no chatId, so nothing could be
        // acknowledged even if the sync ran. Returning null lets the service
        // stop immediately instead of holding a wake lock for an empty task.
        val extras = intent?.extras ?: return null
        return HeadlessJsTaskConfig(
            TASK_NAME,
            Arguments.fromBundle(extras),
            TIMEOUT_MS,
            true, // allowedInForeground: share catchUp even during lifecycle transitions
        )
    }

    companion object {
        /** Must match SYNC_TASK in lib/syncBackground.ts. */
        const val TASK_NAME = "VaultChatSync"

        /**
         * Generous enough for a cold JS start plus a delta page on a slow
         * network, short enough to stay well inside the window Android allows a
         * push-triggered background service. Exceeding it kills the task, which
         * is safe: nothing is acknowledged, so the message stays undelivered and
         * the next ordinary sync collects it.
         */
        const val TIMEOUT_MS = 30_000L
    }
}
