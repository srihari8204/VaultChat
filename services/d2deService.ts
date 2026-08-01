import { E2EE_ENABLED } from '../constants/flags';

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  tag: string;
  keyId: string;
  v: number;
}

export interface D2DEStatusLayer {
  layer: string;
  active: boolean;
  label: string;
}

// ⚠️ SECURITY (Phase 1 / P1.3): the previous implementation derived the AES-256
// key from a PBKDF2 over `vaultchat-v1-${sortedUIDs}` plus a hardcoded salt.
// That input is fully PUBLIC — anyone who knows the two user IDs can reproduce
// the key, so it was NOT end-to-end encryption despite the "Double Ratchet /
// X3DH" labels this module reports. These helpers had zero call sites in the
// client, so no ciphertext exists in the wild to migrate. Rather than leave a
// public-derivable key primitive lying around for a future caller to pick up,
// we FAIL CLOSED: the real per-conversation E2EE lives in
// services/crypto/e2eeSession.rn.ts (X3DH + Double Ratchet), and all message
// crypto must go through lib/chatService.ts, which uses it.

const D2DE_REMOVED =
  'd2deService message crypto was removed: its key was derivable from public ' +
  'user IDs and is not end-to-end secure. Use the X3DH/Double-Ratchet session ' +
  'in services/crypto/e2eeSession.rn.ts (via lib/chatService.ts) instead.';

export function clearKeyCache(): void { /* no key cache — kept for API compatibility */ }

export async function encryptMessage(
  _plaintext: string, _myUid: string, _peerUid: string
): Promise<EncryptedPayload> {
  throw new Error(D2DE_REMOVED);
}

export async function decryptMessage(
  _payload: EncryptedPayload, _myUid: string, _peerUid: string
): Promise<string> {
  throw new Error(D2DE_REMOVED);
}

// Reports the REAL encryption posture. TLS is always on (transport). The
// end-to-end layers are active only when E2EE_ENABLED — i.e. they reflect the
// actual services/crypto double-ratchet path used for direct chats, not a
// hardcoded "everything green".
export function getD2DEStatus(): D2DEStatusLayer[] {
  const e2e = E2EE_ENABLED;
  return [
    { layer: 'TLS 1.3',        active: true, label: 'Transport — encrypted on all connections' },
    { layer: 'AES-256-GCM',    active: e2e,  label: e2e ? 'Direct messages encrypted on your device' : 'End-to-end encryption rolling out' },
    { layer: 'Double Ratchet', active: e2e,  label: e2e ? 'Forward secrecy — a fresh key per message' : 'Not active yet' },
    { layer: 'X3DH',           active: e2e,  label: e2e ? 'Key agreement via published prekeys' : 'Not active yet' },
    { layer: 'Secure Keystore',active: e2e,  label: e2e ? 'Keys held in the device secure store' : 'No end-to-end keys yet' },
  ];
}
