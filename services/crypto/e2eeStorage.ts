/**
 * Storage helpers for the E2EE session layer.
 *
 * expo-secure-store caps each value at ~2 KB on Android (it warns/fails above
 * that). The E2EE identity blob (with an OTPK pool) and busy ratchet sessions
 * can exceed that, so `chunkedKV` transparently splits large values across
 * sibling items and reassembles them on read — keeping every private key in
 * the encrypted store (never AsyncStorage).
 *
 * Pure (no RN imports) → Node-tested in e2eeStorage.selftest.ts.
 */
import type { KVStore } from './e2eeSession';

// Sentinel only ever appears as a stored VALUE (values have no charset limit).
// Sub-keys use an ASCII suffix so they stay valid SecureStore keys
// (alphanumeric + . - _ only — no control chars allowed in keys).
const SENTINEL = 'VCKCHUNKED:';
const subKey = (key: string, i: number) => `${key}__c${i}`;

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}
// Our stored payloads are ASCII (hex / base64 / JSON of those), so a
// character split is also a safe byte split.
function splitBySize(s: string, max: number): string[] {
  const parts: string[] = [];
  for (let i = 0; i < s.length; i += max) parts.push(s.slice(i, i + max));
  return parts;
}

export function chunkedKV(base: KVStore, maxBytes = 1800): KVStore {
  async function clearChunks(key: string): Promise<void> {
    const head = await base.get(key);
    if (head !== null && head.startsWith(SENTINEL)) {
      const n = parseInt(head.slice(SENTINEL.length), 10) || 0;
      for (let i = 0; i < n; i++) await base.del(subKey(key, i));
    }
  }
  return {
    async get(key: string): Promise<string | null> {
      const head = await base.get(key);
      if (head === null) return null;
      if (!head.startsWith(SENTINEL)) return head;
      const n = parseInt(head.slice(SENTINEL.length), 10) || 0;
      let out = '';
      for (let i = 0; i < n; i++) {
        const part = await base.get(subKey(key, i));
        if (part === null) return null; // partial/corrupt write — treat as absent
        out += part;
      }
      return out;
    },
    async set(key: string, val: string): Promise<void> {
      await clearChunks(key);
      if (byteLen(val) <= maxBytes) {
        await base.set(key, val);
        return;
      }
      const parts = splitBySize(val, maxBytes);
      for (let i = 0; i < parts.length; i++) await base.set(subKey(key, i), parts[i]);
      await base.set(key, `${SENTINEL}${parts.length}`);
    },
    async del(key: string): Promise<void> {
      await clearChunks(key);
      await base.del(key);
    },
  };
}
