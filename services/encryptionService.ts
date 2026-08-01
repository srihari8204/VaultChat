// services/encryptionService.ts — message encryption
//
// ⚠️ SECURITY (Phase 1 / P1.3): this module previously derived its AES-256 key
// from PBKDF2 over `vaultchat-v1-${sortedUIDs}` and a hardcoded salt. That input
// is entirely PUBLIC, so the "key" was reproducible by anyone who knew the two
// user IDs — i.e. not end-to-end encryption. The functions had no call sites in
// the client, so there is no stored ciphertext to migrate. To prevent any future
// caller from silently using an insecure key, message crypto here FAILS CLOSED.
// The real end-to-end path is the X3DH + Double Ratchet session in
// services/crypto/e2eeSession.rn.ts, used via lib/chatService.ts.

export interface EncryptedPayload { ciphertext: string; iv: string; tag?: string; }

const ENCSVC_REMOVED =
  'encryptionService message crypto was removed: its key was derivable from ' +
  'public user IDs and is not end-to-end secure. Use the X3DH/Double-Ratchet ' +
  'session in services/crypto/e2eeSession.rn.ts (via lib/chatService.ts) instead.';

export async function encryptMessage(_plaintext: string, _senderUid: string, _recipientUid: string): Promise<EncryptedPayload> {
  throw new Error(ENCSVC_REMOVED);
}

export async function decryptMessage(_payload: EncryptedPayload, _senderUid: string, _recipientUid: string): Promise<string> {
  throw new Error(ENCSVC_REMOVED);
}