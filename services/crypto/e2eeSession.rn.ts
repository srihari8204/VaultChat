/**
 * React-Native bindings for the E2EE session layer.
 *
 * Wires the pure session manager (./e2eeSession) to real device storage
 * (expo-secure-store, via the chunked wrapper) and the backend key-bundle
 * routes (lib/api). Exposes a ready singleton `e2ee`.
 *
 * RN-only (imports expo-secure-store + lib/api) → NOT Node-testable; the
 * logic it composes is tested in e2eeSession.selftest.ts + e2eeStorage.selftest.ts.
 *
 * ⚠️ Importing this file pulls the @noble crypto into the Metro bundle. That
 * resolves (metro.config.js has unstable_enablePackageExports = true), but it
 * is still NOT imported by the live app — the chatService seam is the switch.
 */
import * as SecureStore from 'expo-secure-store';
import { api } from '../../lib/api';
import { createE2EESession } from './e2eeSession';
import type { KVStore, KeyBundleTransport, PublishBundle, FetchedBundle } from './e2eeSession';
import { chunkedKV } from './e2eeStorage';
import { createMessageStore, createKeyedLock } from './messageStore';

// SecureStore keys must match /^[A-Za-z0-9._-]+$/ — our keys (vc_e2ee_*,
// peer UUIDs, and `__cN` chunk suffixes) all comply.
const secureStoreKV: KVStore = {
  get: (k) => SecureStore.getItemAsync(k),
  set: (k, v) => SecureStore.setItemAsync(k, v),
  del: (k) => SecureStore.deleteItemAsync(k).then(() => undefined),
};

const apiTransport: KeyBundleTransport = {
  async publish(bundle: PublishBundle): Promise<void> {
    await api('/user/keybundle', { method: 'POST', json: bundle });
  },
  async fetch(peerId: string): Promise<FetchedBundle | null> {
    try {
      const r = await api<FetchedBundle>(`/user/${encodeURIComponent(peerId)}/keybundle`);
      // Backend returns identityKey only once the peer has provisioned keys.
      return r && (r as any).identityKey ? r : null;
    } catch (e: any) {
      if (e?.status === 404) return null;
      throw e;
    }
  },
};

/** Singleton E2EE session bound to device storage + the backend. */
export const e2ee = createE2EESession({
  store: chunkedKV(secureStoreKV),
  transport: apiTransport,
});

// ── high-level glue used by lib/chatService.ts ─────────────────────────
// Plaintext cache (forward secrecy → can't re-derive old keys) + per-peer
// serialization (chat.tsx decrypts every visible bubble concurrently).
const msgStore = createMessageStore(chunkedKV(secureStoreKV));
const withLock = createKeyedLock();

export function isEnvelope(wire: string | null | undefined): boolean {
  return e2ee.isEnvelope(wire);
}

/** Encrypt one outgoing message for a direct-chat peer (serialized per peer). */
export function e2eeEncrypt(_chatId: string, peerId: string, plaintext: string): Promise<string> {
  return withLock(peerId, () => e2ee.encryptForPeer(peerId, plaintext));
}

/** Decrypt one incoming message; cache-first by (chatId, messageId). */
export function e2eeDecrypt(chatId: string, peerId: string, messageId: number, wire: string): Promise<string> {
  return withLock(peerId, async () => {
    if (messageId > 0) {
      const cached = await msgStore.get(chatId, messageId);
      if (cached !== null) return cached;
    }
    const plaintext = await e2ee.decryptFromPeer(peerId, wire);
    if (messageId > 0) await msgStore.put(chatId, messageId, plaintext);
    return plaintext;
  });
}

/** Cache the plaintext of an own-sent message once the server assigns its id. */
export async function e2eeCachePlaintext(chatId: string, messageId: number, plaintext: string): Promise<void> {
  if (messageId > 0) await msgStore.put(chatId, messageId, plaintext);
}

/** Read a cached message plaintext by (chatId, messageId), or null. Shared by the
 *  group session so a sender can render their own (un-self-decryptable) messages. */
export async function e2eeGetCached(chatId: string, messageId: number): Promise<string | null> {
  if (messageId <= 0) return null;
  return msgStore.get(chatId, messageId);
}

/**
 * Provision + publish this device's key bundle so peers can start E2EE
 * sessions. Idempotent and cheap after the first successful call this session.
 */
let _provisioned = false;
let _provisioning: Promise<void> | null = null;
export async function provisionE2EEIdentity(): Promise<void> {
  if (_provisioned) return;
  // Dedupe concurrent callers (app/_layout startup + app/chat mount) onto a
  // single in-flight publish so they can't double-provision.
  if (!_provisioning) {
    _provisioning = e2ee.ensurePublished()
      .then(() => { _provisioned = true; })
      .finally(() => { _provisioning = null; });
  }
  return _provisioning;
}

export default e2ee;
