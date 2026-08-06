// lib/transferForeground.ts — Android foreground service for ACTIVE VaultBeam
// transfers (UITE §13). While any upload/download is in flight the app posts an
// ongoing progress notification attached to the shared FGS (see the holds
// refcount in lib/backgroundConnection), so minimizing the app no longer
// freezes/kills a multi-GB transfer. Stops (and releases the service) the
// moment the last transfer reaches a terminal state.
//
// Driven entirely by vaultBeamController.setState — no screen needs to know.

import { Platform } from 'react-native';

const CHANNEL_ID = 'vaultchat_transfer';
const NOTIF_ID = 'vc-transfer';
const POST_THROTTLE_MS = 1200;

let channelReady = false;
let visible = false;
let lastPost = 0;
let lastPct = -1;

export interface FgsAggregate { count: number; bytes: number; totalBytes: number; upload?: boolean }

/** Reflect the current set of active transfers into the FGS notification.
 * Pass null / count 0 when nothing is active. Fire-and-forget safe. */
export async function updateTransferForeground(agg: FgsAggregate | null): Promise<void> {
  if (Platform.OS !== 'android') return;
  let notifee: any, AndroidImportance: any, AndroidForegroundServiceType: any;
  try { ({ default: notifee, AndroidImportance, AndroidForegroundServiceType } = require('@notifee/react-native')); } catch { return; }
  const bg = require('./backgroundConnection');

  // ANDROID 15: `dataSync` is capped at six hours per 24 h across the whole app,
  // and that budget is shared with the no-GMS socket connection — so a long
  // transfer does not even get the full six. A user-initiated data transfer job
  // is outside that cap, so prefer it and hold the dataSync service only when
  // the job is unavailable (API < 34, or the app was not visible enough to
  // qualify). See lib/vaultBeamJob.ts.
  const { transferJobHost } = require('./vaultBeamJob');
  const job = transferJobHost();

  if (!agg || agg.count === 0) {
    try { await job.release(); } catch {}
    if (!visible) return;
    visible = false; lastPct = -1;
    try { await notifee.cancelNotification(NOTIF_ID); } catch {}
    try { await bg.releaseFgs('transfer'); } catch {}
    return;
  }

  const jobPct = agg.totalBytes > 0 ? Math.min(100, Math.floor((agg.bytes / agg.totalBytes) * 100)) : -1;
  try {
    await job.sync({
      count: agg.count,
      remainingBytes: Math.max(0, (agg.totalBytes || 0) - (agg.bytes || 0)),
      upload: agg.upload !== false,
      title: agg.count === 1 ? 'Transferring file' : `Transferring ${agg.count} files`,
      text: jobPct >= 0 ? `${jobPct}%` : 'Starting…',
      progressPct: jobPct,
    });
  } catch { /* the fallback below covers it */ }

  const pct = agg.totalBytes > 0 ? Math.min(100, Math.floor((agg.bytes / agg.totalBytes) * 100)) : 0;
  const now = Date.now();
  if (visible && now - lastPost < POST_THROTTLE_MS && pct === lastPct) return;
  lastPost = now; lastPct = pct;

  try {
    // Hold the shared dataSync service ONLY when the job is not carrying us.
    // Holding both would spend the six-hour budget for nothing, which is the
    // whole problem this is meant to avoid. The progress notification is posted
    // either way — it is what makes the transfer visible and cancellable, and
    // that is independent of which mechanism keeps the process alive.
    const needFgs = job.needsForegroundService;
    if (!needFgs) {
      // The job is carrying the transfer AND owns the progress notification —
      // calling setNotification is mandatory for a user-initiated data transfer
      // job, so posting a second Notifee one here would show the user two
      // notifications for one transfer.
      try { await bg.releaseFgs('transfer'); } catch {}
      if (visible) { try { await notifee.cancelNotification(NOTIF_ID); } catch {} visible = false; }
      return;
    }
    bg.holdFgs('transfer');
    bg.registerBackgroundConnection();   // arm the shared FGS task (idempotent)
    if (!channelReady) {
      channelReady = true;
      await notifee.createChannel({ id: CHANNEL_ID, name: 'File transfers', importance: AndroidImportance.LOW }).catch(() => {});
    }
    await notifee.displayNotification({
      id: NOTIF_ID,
      title: agg.count === 1 ? 'Transferring file' : `Transferring ${agg.count} files`,
      body: `${pct}%`,
      android: {
        channelId: CHANNEL_ID,
        importance: AndroidImportance.LOW,
        ongoing: true,
        onlyAlertOnce: true,
        asForegroundService: true,
        foregroundServiceTypes: [AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_DATA_SYNC],
        progress: { max: 100, current: pct },
        pressAction: { id: 'default', launchActivity: 'default' },
      },
    });
    visible = true;
  } catch {}
}

export default {};
