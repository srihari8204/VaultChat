// lib/restoreGate.ts — should this device be offered its backup?
//
// The restore prompt has to fire on a NEW PHONE and nowhere else. Getting that
// wrong in either direction is bad in a different way:
//
//   never shown   → the history is lost on every handset upgrade, silently,
//                   which is the bug this exists to fix
//   shown wrongly → an older backup is offered to a device that already has
//                   newer messages, and restoring would overwrite them
//
// So the answer is the conjunction of three facts, and all three are cheap:
//
//   1. signed in            — the backup is account-scoped; there is nothing
//                             to look up before auth
//   2. no local history     — this device has never held messages. The local
//                             store is the source of truth for "is this a
//                             fresh install", not a flag we set ourselves
//   3. not already asked    — once per install, so declining is respected
//
// Condition 2 is what makes this safe. A device with messages is not a new
// phone, whatever any flag says.
//
// Every failure here SKIPS the offer, and that no longer exposes the backup.
// Uploads are not gated on this screen having been shown: lib/restoreDecision
// treats an install that never restored, never chose to replace the online
// copy and never completed a backup as undecided, and keeps every upload
// (scheduled or not) paused while the account or a linked Drive holds a copy.

import AsyncStorage from '@react-native-async-storage/async-storage';

const SEEN_KEY = 'vc_restore_prompt_seen';

/** Remember that we asked, so a decline is not re-asked on the next launch. */
export async function markRestorePromptSeen(): Promise<void> {
  try { await AsyncStorage.setItem(SEEN_KEY, '1'); } catch {}
}

/** For tests and for "restore again" from Settings. */
export async function clearRestorePromptSeen(): Promise<void> {
  try { await AsyncStorage.removeItem(SEEN_KEY); } catch {}
}

async function alreadyAsked(): Promise<boolean> {
  try { return (await AsyncStorage.getItem(SEEN_KEY)) === '1'; } catch { return true; }
}

/**
 * Does this device hold any messages of its own?
 *
 * Deliberately tolerant: a local store that cannot be read yet counts as
 * NON-empty, so a slow or failed open can never cause a restore offer over
 * history we simply could not see. Wrongly skipping the prompt costs a trip to
 * Settings; wrongly showing it risks overwriting messages.
 */
async function deviceHasHistory(): Promise<boolean> {
  try {
    const { getLocalDb } = await import('./localDb');
    const db = await getLocalDb();
    // Preserve the previous definition of an established device (a cached
    // conversation exists) without decrypting every chat row just to count it.
    return !!(await db.getFirstAsync(`SELECT 1 AS x FROM chats LIMIT 1`));
  } catch {
    return true;
  }
}

/**
 * True when the restore screen should be shown before the chat list.
 *
 * Never throws, and every failure path answers `false` — the prompt is a
 * convenience, and it must not be able to block someone from reaching their
 * app.
 */
export async function shouldOfferRestore(): Promise<boolean> {
  try {
    if (!(await shouldCheckRestore())) return false;

    // Only now is a network call worth making. Doing it first would put a
    // request in front of every cold start for a question that is usually
    // answered "no" locally.
    const { cloudBackupMeta } = await import('./cloudBackup');
    const meta = await cloudBackupMeta();
    return !!meta?.exists;
  } catch {
    return false;
  }
}

/** Local-only launch decision; the restore screen owns the network lookup. */
export async function shouldCheckRestore(): Promise<boolean> {
  try {
    if (await alreadyAsked()) return false;
    return !(await deviceHasHistory());
  } catch {
    return false;
  }
}

export default { shouldOfferRestore, shouldCheckRestore, markRestorePromptSeen, clearRestorePromptSeen };
