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

/**
 * Call once after sign-in (and periodically) to make sure this device has a
 * published key bundle so peers can start E2EE sessions with it. Safe to call
 * repeatedly — it only regenerates if no identity exists and tops up OTPKs.
 */
export async function provisionE2EEIdentity(): Promise<void> {
  await e2ee.ensurePublished();
}

export default e2ee;
