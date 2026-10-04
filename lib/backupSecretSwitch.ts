// lib/backupSecretSwitch.ts — replace the stored end-to-end backup secret
// without ever leaving the device on a secret the server copy does not match.
//
// Used by lib/cloudBackup's enableE2EEBackup for every switch: account → password,
// account → key, password → new password ("Change password"), password ↔ key.
// Pure (the store and the upload are passed in), so the state transitions are
// tested under plain Node in backupSecretSwitch.selftest.ts.
//
// Order, and why:
//   1. Read the current pair. A failed read aborts before anything changes.
//   2. Upload under the NEW pair while the OLD pair is still stored. Scheduled
//      backups keep using the old one, and a failed upload changes nothing —
//      the old code deleted the secret here, which silently dropped a user who
//      was already on e2ee back to server-readable backups.
//   3. Store the new pair. If that fails, put the old pair (or account mode)
//      back and re-upload under it, so the server copy is again one the device
//      — and the user — can open. A new recovery key that was never shown must
//      not be the only key to the server copy.

export interface SecretPair<H> { secret: string; header: H }

export interface SecretSlot<H> {
  /** The stored pair, or null in account-managed mode. Throws on a read failure. */
  get(): Promise<SecretPair<H> | null>;
  put(pair: SecretPair<H>): Promise<void>;
  /** Back to account-managed mode. */
  clear(): Promise<void>;
}

/**
 * Upload under `next`, then store it. `upload(null)` means "with the account
 * key". Throws the upload's (or the store's) error; on any throw the slot holds
 * what it held before.
 */
export async function switchBackupSecret<H>(
  slot: SecretSlot<H>,
  next: SecretPair<H>,
  upload: (using: SecretPair<H> | null) => Promise<void>,
): Promise<void> {
  const prev = await slot.get();
  await upload(next);
  try {
    await slot.put(next);
  } catch (e) {
    await (prev ? slot.put(prev) : slot.clear()).catch(() => {});
    await upload(prev).catch(() => {});
    throw e;
  }
}
