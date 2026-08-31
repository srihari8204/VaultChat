// lib/notesVault.ts — end-to-end-encrypted backup & restore for Encrypted Notes.
//
// THE PROBLEM THIS SOLVES
// The notes DEK lives only in SecureStore (lib/notesCrypto), which no backup
// path copies. Worse, `vc_encrypted_notes` is a plain AsyncStorage key, so
// lib/cloudBackup ALREADY sweeps the sealed notes blob into every bundle — a
// restore therefore hands you ciphertext with no key on earth that opens it.
// The backup looked like it worked and silently guaranteed total loss.
//
// THE MODEL: passphrase-wrapped DEK, ciphertext at every hop
//   notes  ──sealed under──▶  DEK  ──sealed under──▶  scrypt(passphrase, salt)
// The wrap record is itself just another AsyncStorage value, so it rides the
// existing backup with no new transport and no server change. cloudBackup's own
// key is ACCOUNT-MANAGED (its header says so plainly: the server can recover
// it), so anything protected only by that key is readable by the server. The
// inner wrap is what makes notes genuinely end-to-end: a server holding the
// outer key still sees nothing but a scrypt-hardened blob. Only the passphrase,
// which never leaves the device and is never stored, opens it.
//
// Notes and attachments are NEVER re-encrypted or serialised in the clear to
// move them. They are already sealed under the DEK, so export copies those
// envelopes verbatim — the plaintext never exists outside the running screen.
//
// The crypto and validation live in lib/notesVaultCore — pure, no RN import,
// so the shipping code runs under tsx in lib/notesVault.selftest.ts. This file
// is only the persistence around it.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { exportDEKHex, importDEKHex, hasDEK } from './notesCrypto';
import { listAttachmentBlobs, writeAttachmentBlob } from './notesAttachments';
import { makeWrap, openWrap, isBundle, type KeyWrap, type NotesBundle } from './notesVaultCore';

export { makeWrap, openWrap, isWrap, isBundle, purgeExpired } from './notesVaultCore';
export type { KeyWrap, NotesBundle } from './notesVaultCore';

/** AsyncStorage key holding the notes blob (owned by app/encrypted-notes.tsx). */
export const NOTES_STORAGE_KEY = 'vc_encrypted_notes';
/** AsyncStorage key holding the wrap. Rides cloudBackup as opaque ciphertext. */
export const NOTES_WRAP_KEY = 'vc_notes_keywrap_v1';

// ── Persistence (React Native) ──────────────────────────────────────────────

/** Is a backup passphrase set up on this install? */
export async function hasPassphrase(): Promise<boolean> {
  return !!(await AsyncStorage.getItem(NOTES_WRAP_KEY));
}

/**
 * Set (or change) the backup passphrase. Wraps the CURRENT DEK, so every note
 * already written stays readable — this never rotates the key underneath them.
 */
export async function setPassphrase(passphrase: string): Promise<void> {
  if (passphrase.length < 8) throw new Error('Passphrase must be at least 8 characters.');
  const wrap = await makeWrap(passphrase, await exportDEKHex());
  await AsyncStorage.setItem(NOTES_WRAP_KEY, JSON.stringify(wrap));
}

/** Verify a passphrase against the stored wrap without changing anything. */
export async function checkPassphrase(passphrase: string): Promise<boolean> {
  const raw = await AsyncStorage.getItem(NOTES_WRAP_KEY);
  if (!raw) return false;
  try { return !!(await openWrap(passphrase, JSON.parse(raw))); } catch { return false; }
}

/**
 * After a device restore: the notes blob and the wrap both came back through
 * the normal backup, but the DEK did not. Recover it from the wrap.
 *
 * Returns 'ok' when the key is now installed, 'wrong' for a bad passphrase,
 * 'none' when no wrap travelled with the backup, and 'occupied' when this
 * install already has a different key — overwriting it would strand the notes
 * it seals, so the caller must confirm before forcing.
 */
export async function restoreKeyFromWrap(
  passphrase: string, force = false,
): Promise<'ok' | 'wrong' | 'none' | 'occupied'> {
  const raw = await AsyncStorage.getItem(NOTES_WRAP_KEY);
  if (!raw) return 'none';
  let hex: string | null = null;
  try { hex = await openWrap(passphrase, JSON.parse(raw)); } catch { return 'wrong'; }
  if (!hex) return 'wrong';
  if (!force && await hasDEK()) {
    // Already holding this same key is not a conflict — it is a no-op.
    if ((await exportDEKHex()) === hex) return 'ok';
    return 'occupied';
  }
  await importDEKHex(hex, true);
  return 'ok';
}

/**
 * Build a self-contained export bundle. Nothing here is plaintext: the notes
 * blob and every attachment envelope are copied exactly as they sit sealed on
 * disk, and the only new material is the passphrase-wrapped DEK.
 */
export async function buildBundle(passphrase: string): Promise<NotesBundle> {
  if (passphrase.length < 8) throw new Error('Passphrase must be at least 8 characters.');
  return {
    v: 1,
    kind: 'vaultchat-notes',
    createdAt: Date.now(),
    wrap: await makeWrap(passphrase, await exportDEKHex()),
    notes: await AsyncStorage.getItem(NOTES_STORAGE_KEY),
    attachments: await listAttachmentBlobs(),
  };
}

/**
 * Restore a bundle. The passphrase is checked FIRST: a wrong one must not be
 * able to overwrite this device's notes with a blob it cannot open.
 *
 * `force` is required to replace an existing, different key — same reasoning as
 * restoreKeyFromWrap. Returns the number of attachments written.
 */
export async function restoreBundle(
  passphrase: string, bundle: unknown, force = false,
): Promise<{ status: 'ok' | 'wrong' | 'invalid' | 'occupied'; attachments: number }> {
  if (!isBundle(bundle)) return { status: 'invalid', attachments: 0 };
  const hex = await openWrap(passphrase, bundle.wrap);
  if (!hex) return { status: 'wrong', attachments: 0 };
  if (!force && await hasDEK() && (await exportDEKHex()) !== hex) {
    return { status: 'occupied', attachments: 0 };
  }
  await importDEKHex(hex, true);

  let n = 0;
  for (const [id, blob] of Object.entries(bundle.attachments)) {
    // ponytail: sequential writes; a vault with thousands of attachments would
    // want batching, but the restore is a one-shot the user is watching.
    try { await writeAttachmentBlob(id, blob); n++; } catch {}
  }
  // The notes blob goes last: if an attachment write fails we would rather the
  // notes still land than have notes referencing files that never arrived.
  if (bundle.notes) await AsyncStorage.setItem(NOTES_STORAGE_KEY, bundle.notes);
  await AsyncStorage.setItem(NOTES_WRAP_KEY, JSON.stringify(bundle.wrap));
  return { status: 'ok', attachments: n };
}

export default { setPassphrase, checkPassphrase, restoreKeyFromWrap, buildBundle, restoreBundle };
