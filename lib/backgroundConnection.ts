// lib/backgroundConnection.ts — persistent background connection for no-GMS
// devices (Huawei P30 Pro etc.), the WhatsApp/Signal model.
//
// With no FCM there is nothing to wake a backgrounded app, so real-time delivery
// needs the app's own socket to stay alive. A Notifee foreground service keeps
// the process (and therefore lib/socket's realtime connection) running while
// the app is in the background, with a single silent MIN-importance notification
// ("Keeping you connected") — exactly what WhatsApp shows on protected-app OEMs.
//
// Only started where it's actually needed (push unavailable → see push.ts); on a
// Google-Play device the server's FCM push covers background delivery and this
// stays off to save battery. Catch-up on next reopen (syncEngine.initSync) fills
// any gap if the OEM battery-killer stops the service.
//
// ponytail: needs FOREGROUND_SERVICE_DATA_SYNC (app.json) + the dataSync service
// type (plugins/withVaultChatSync.js) + a prebuild; must be device-tested on a
// real no-GMS handset — like the calls-when-killed path, it can't be validated
// in-editor.

import { Platform } from 'react-native';
import notifee, { AndroidImportance, AndroidForegroundServiceType } from '@notifee/react-native';

const CHANNEL_ID = 'vaultchat_connection';
const NOTIF_ID   = 'vc-bg-connection';

let registered = false;
let wantRunning = false;
let stopResolver: (() => void) | null = null;

// Android allows ONE notifee foreground service. It's shared between this
// module ('connection', no-GMS keep-alive) and active VaultBeam transfers
// ('transfer', lib/transferForeground). Holds refcount the service: it stops
// only when the LAST holder releases; each holder manages its own notification.
const fgsHolds = new Set<string>();
export function holdFgs(tag: string): void { fgsHolds.add(tag); }
export async function releaseFgs(tag: string): Promise<void> {
  fgsHolds.delete(tag);
  if (fgsHolds.size === 0) {
    try { stopResolver?.(); stopResolver = null; } catch {}
    try { await notifee.stopForegroundService(); } catch {}
  }
}

/**
 * Register the foreground-service task ONCE at JS load. Notifee invokes it
 * whenever the service is active — including a headless process restart after an
 * OEM kill — so the socket + message→notification bridge are armed here, not
 * only from the React tree. The task promise stays pending until we stop the
 * service, which is what keeps the process (and the socket) alive.
 */
export function registerBackgroundConnection(): void {
  if (registered || Platform.OS !== 'android') return;
  registered = true;
  notifee.registerForegroundService(() => new Promise<void>((resolve) => {
    stopResolver = resolve;
    (async () => {
      try {
        const { addPersistentListener, getSocket } = require('./socket');
        const { notify } = require('./messageNotifications');
        // Inbound message → OS notification (self-dedupes; safe if also armed
        // from _layout). Persistent so it survives socket reconnects.
        addPersistentListener('new_message', (m: any) => {
          notify(m).catch(() => {});
          // VaultBeam auto-download while backgrounded (flag-gated; no-op when off).
          if (m?.meta?.vaultbeam) { try { require('./vaultBeamIngest').onIncomingVaultbeamMessage(m); } catch {} }
        });
        await getSocket().catch(() => {});   // open + keep the connection alive
      } catch {}
      if (!wantRunning && fgsHolds.size === 0) resolve(); // all holders stopped before we started
    })();
  }));
}

async function ensureChannel(): Promise<void> {
  try {
    await notifee.createChannel({
      id: CHANNEL_ID,
      name: 'Background connection',
      importance: AndroidImportance.MIN,   // silent, collapsed
    });
  } catch {}
}

/** Start the persistent connection service (idempotent). Android only. */
export async function startBackgroundConnection(): Promise<void> {
  if (Platform.OS !== 'android') return;
  wantRunning = true;
  holdFgs('connection');
  registerBackgroundConnection();
  await ensureChannel();
  try {
    await notifee.displayNotification({
      id: NOTIF_ID,
      title: 'crazzychat',
      body: 'Keeping you connected',
      android: {
        channelId: CHANNEL_ID,
        importance: AndroidImportance.MIN,
        ongoing: true,
        asForegroundService: true,
        foregroundServiceTypes: [AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_DATA_SYNC],
        pressAction: { id: 'default', launchActivity: 'default' },
      },
    });
  } catch {}
}

/** Stop the persistent connection service. */
export async function stopBackgroundConnection(): Promise<void> {
  if (Platform.OS !== 'android') return;
  wantRunning = false;
  await releaseFgs('connection');   // stops the service only if transfers aren't holding it
  try { await notifee.cancelNotification(NOTIF_ID); } catch {}
}

export default {};
