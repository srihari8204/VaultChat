// utils/financeBackupSeal.ts — password protection for the Full Backup file.
//
// The Full Backup is every ledger, member name, phone, address and amount the
// user has. It used to leave the phone as plain JSON, readable by anything it
// was shared to. It is now sealed with the same envelope the chat backup's
// end-to-end password mode uses (lib/backupCrypto + lib/vaultCrypto): a
// per-file random salt, PBKDF2-SHA256 at the OWASP cost, AES-256-GCM. No new
// crypto here — only the wiring.
//
// The secret is a password the user types, not a device key: the backup is
// for restoring onto a NEW phone, where no key from this one exists. So a
// forgotten password means the file cannot be opened, and the screen says so.
//
// Restore stays compatible with every plain backup written before this: a file
// without the envelope header is treated as plain JSON, exactly as before.

import { vaultEncryptAsync, vaultDecryptAsync, type VaultPayload } from '../lib/vaultCrypto';
import { newHeader, backupSecretAsync, stampE2EEHeader, readE2EEHeader, passwordProblem, type E2EEHeader } from '../lib/backupCrypto';

export { passwordProblem };

// Both KDFs run async (lib/vaultCrypto pbkdf2BytesAsync), so the busy overlay
// in app/finance/io.tsx keeps drawing while ~310k PBKDF2 rounds run.

/** Seal backup JSON under a password. `header` is injectable only for tests. */
export async function sealFinanceBackup(json: string, password: string, header: E2EEHeader = newHeader('password')): Promise<string> {
  if (header.mode !== 'password') throw new Error('A finance backup is sealed with a password.');
  return stampE2EEHeader(await vaultEncryptAsync(await backupSecretAsync(header, password), json), header);
}

/** True when the file text is a password-sealed backup (needs a password). */
export function isSealedFinanceBackup(text: string): boolean {
  return readE2EEHeader(text)?.mode === 'password';
}

/**
 * The backup JSON inside a sealed file. Throws 'WRONG_PASSWORD' when the
 * password does not open it (AES-GCM authenticates, so a wrong password or a
 * tampered file cannot yield garbage that then gets restored).
 */
export async function openFinanceBackup(text: string, password: string): Promise<string> {
  const header = readE2EEHeader(text);
  if (!header || header.mode !== 'password') throw new Error('Not a sealed backup.');
  const payload = JSON.parse(text) as VaultPayload;
  try {
    return await vaultDecryptAsync(await backupSecretAsync(header, password), payload);
  } catch {
    throw new Error('WRONG_PASSWORD');
  }
}
