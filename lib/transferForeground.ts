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

export interface FgsAggregate { count: number; bytes: number; totalBytes: number }

/** Reflect the current set of active transfers into the FGS notification.
 * Pass null / count 0 when nothing is active. Fire-and-forget safe. */
export async function updateTransferForeground(agg: FgsAggregate | null): Promise<void> {
  if (Platform.OS !== 'android') return;
  let notifee: any, AndroidImportance: any, AndroidForegroundServiceType: any;
  try { ({ default: notifee, AndroidImportance, AndroidForegroundServiceType } = require('@notifee/react-native')); } catch { return; }
  const bg = require('./backgroundConnection');

  if (!agg || agg.count === 0) {
    if (!visible) return;
    visible = false; lastPct = -1;
    try { await notifee.cancelNotification(NOTIF_ID); } catch {}
    try { await bg.releaseFgs('transfer'); } catch {}
    return;
  }

  const pct = agg.totalBytes > 0 ? Math.min(100, Math.floor((agg.bytes / agg.totalBytes) * 100)) : 0;
  const now = Date.now();
  if (visible && now - lastPost < POST_THROTTLE_MS && pct === lastPct) return;
  lastPost = now; lastPct = pct;

  try {
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
