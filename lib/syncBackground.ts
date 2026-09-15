// lib/syncBackground.ts — wake, sync, THEN acknowledge.
//
// THE PROBLEM THIS SOLVES
//
// A chat push was a doorbell and nothing else. VaultCallMessagingService
// received the FCM data message, posted a notification, and stopped. No JS ran,
// nothing synced, and chat_members.last_delivered_message_id never moved — so
// the sender sat on ONE TICK until the recipient happened to open the app.
// Measured on production: message 435 undelivered for five hours while its
// recipient's device was reachable and its FCM token was valid.
//
// Registered as a React Native headless task, started by the native FCM service
// (VaultChatSyncService). Imported for its side effects from app/_layout.tsx so
// the registration exists at JS-load time — the same pattern callBackground.ts
// already uses for calls launched while killed.
//
// ORDERING IS THE WHOLE CONTRACT
//
// The ack must mean "this device HAS the message", not "this device was told
// about a message". So it happens only after catchUp() has returned and the row
// is actually on disk, and the id acked is read back FROM the local database
// rather than taken from the push. A push carries a chatId and nothing else;
// trusting it for the ack would confirm delivery of something we never stored.
//
// Any failure — no session, network error, sync throw — returns WITHOUT acking.
// The message stays undelivered server-side and the next ordinary sync
// (app open, socket reconnect) picks it up. FCM is a wake-up, never the source
// of truth.

import { AppRegistry } from 'react-native';

export const SYNC_TASK = 'VaultChatSync';

/**
 * One background catch-up. Never throws — a headless task that rejects is an
 * app-wide crash report on some OEMs, and there is nothing useful to surface
 * from a process the user cannot see.
 *
 * Returns what happened, for the tests and for logging.
 */
export async function runBackgroundSync(
  data?: { chatId?: string },
): Promise<'synced' | 'no-session' | 'sync-failed' | 'nothing-to-ack'> {
  const chatId = data?.chatId;
  let owner = '';
  try {
    // 1. A session, or there is nothing we may call the API with. Not an error:
    //    a logged-out device legitimately receives no acks.
    const { getAccessToken } = await import('./api');
    const { tokenSubject } = await import('./tokenIdentity');
    owner = tokenSubject(await getAccessToken());
    if (!owner) return 'no-session';

    // 2. Drain the delta through the EXISTING engine — same cursor, same
    //    dedup, same cacheMessages upsert. Deliberately not a second sync
    //    implementation: a parallel path is how two cursors drift apart.
    //    requestCatchUp() joins the shared drain and requests another pass if
    //    this push arrived during an older response snapshot. The await covers
    //    that follow-up before reading the local delivery high-water mark.
    const { requestCatchUp } = await import('./syncEngine');
    await requestCatchUp();
  } catch {
    // Offline, 401, server hiccup. Say nothing to the server: an ack here
    // would mark delivered a message we do not have.
    return 'sync-failed';
  }

  // 3. Acknowledge, and only now. The id comes from the LOCAL database — the
  //    newest row actually persisted for this chat — so the high-water mark we
  //    send can never exceed what this device holds.
  if (!chatId) return 'nothing-to-ack';
  try {
    const { getCachedMessages } = await import('./localDb');
    const newest = (await getCachedMessages(chatId, 1))[0];
    if (!newest || typeof newest.id !== 'number' || newest.id <= 0) return 'nothing-to-ack';
    const { markDelivered } = await import('./chatService');
    await markDelivered(chatId, newest.id, owner);
    return 'synced';
  } catch {
    // The rows are on disk; only the receipt failed. The next sync re-acks —
    // markDelivered is a monotonic high-water mark, so repeating it is free.
    return 'sync-failed';
  }
}

// Headless entry. The native service passes the FCM data bundle straight
// through, so `data.chatId` is the chat the push was about.
AppRegistry.registerHeadlessTask(SYNC_TASK, () => async (data: any) => {
  await runBackgroundSync(data);
});
