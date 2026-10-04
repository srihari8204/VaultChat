// lib/postSignIn.ts — where a person lands after signing in on this device.
//
// The new-phone restore offer (app/restore-backup) used to be reachable only
// from app/index.tsx, which runs on launches the root gate allowed — i.e.
// someone ALREADY signed in. A returning user signing in on a new phone goes
// onboard → mpin-entry (or mpin-recover) and never passes through index, so the
// offer was skipped in exactly the case it exists for. Both sign-in exits now
// ask the same local question index.tsx asks.

import { router } from 'expo-router';

import { shouldCheckRestore } from './restoreGate';

/**
 * On a phone with no chat history yet, open the restore offer and return
 * true; otherwise return false and the caller continues with
 * resetTo('/(tabs)/chats') as before.
 */
export async function openRestoreIfNewPhone(): Promise<boolean> {
  if (!(await shouldCheckRestore())) return false;
  // Same stack reset lib/authNav.resetTo does, but without its "not into the
  // tabs, so drop the stashed launch link" branch: the link is replayed when
  // restore-backup continues into Chats through resetTo('/(tabs)/chats').
  try { if (router.canDismiss()) router.dismissAll(); } catch { /* nothing to dismiss */ }
  router.replace('/restore-backup' as any);
  return true;
}
