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
import { createKeyedLock } from './messageStore';

// Identity, session and backup wrappers share the same backing adapter.
const locks = new WeakMap<KVStore, ReturnType<typeof createKeyedLock>>();

// Sentinel only ever appears as a stored VALUE (values have no charset limit).
// Sub-keys use an ASCII suffix so they stay valid SecureStore keys
// (alphanumeric + . - _ only — no control chars allowed in keys).
const SENTINEL = 'VCKCHUNKED:';
// LEGACY sub-key, pre-generation. Still READ so an install written by the old
// code keeps working; never written again.
const subKey = (key: string, i: number) => `${key}__c${i}`;
// Generation-tagged sub-key. The generation is what makes a write atomic: new
// parts land on keys the CURRENT head does not name.
const genKey = (key: string, gen: number, i: number) => `${key}__g${gen}c${i}`;

/** Parsed head: how many parts, and which generation holds them (null = legacy). */
function parseHead(head: string): { n: number; gen: number | null } {
  const body = head.slice(SENTINEL.length);
  const colon = body.indexOf(':');
  if (colon < 0) return { n: parseInt(body, 10) || 0, gen: null };
  return { n: parseInt(body.slice(0, colon), 10) || 0, gen: parseInt(body.slice(colon + 1), 10) || 0 };
}

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
  // SecureStore has no multi-key transaction. Serialize all operations for one
  // logical value so a reader cannot retain an old head while a writer removes
  // the old generation after committing the replacement.
  let serial = locks.get(base);
  if (!serial) { serial = createKeyedLock(); locks.set(base, serial); }
  // Delete the parts a given head names. Called only AFTER a new head has been
  // committed - never before one is written.
  async function clearParts(key: string, head: string | null): Promise<void> {
    if (head === null || !head.startsWith(SENTINEL)) return;
    const { n, gen } = parseHead(head);
    for (let i = 0; i < n; i++) {
      await base.del(gen === null ? subKey(key, i) : genKey(key, gen, i));
    }
  }
  return {
    get(key: string): Promise<string | null> { return serial(key, async () => {
      const head = await base.get(key);
      if (head === null) return null;
      if (!head.startsWith(SENTINEL)) return head;
      const { n, gen } = parseHead(head);
      let out = '';
      for (let i = 0; i < n; i++) {
        const part = await base.get(gen === null ? subKey(key, i) : genKey(key, gen, i));
        if (part === null) {
          // DAMAGE, NOT ABSENCE - and the difference is catastrophic.
          //
          // A head naming N parts is a commitment that those N parts exist.
          // Returning null told the caller "there is no value", and for the
          // identity blob that is `loadIdentity() ?? createIdentity()` - so a
          // torn read MINTED AND PUBLISHED a new identity, killing every peer
          // session and making all history undecryptable, with no error.
          //
          // Writes are generation-tagged now, so this should be unreachable.
          // If it ever happens, failing loudly is the only honest answer.
          throw new Error(`e2ee: chunked value truncated (${key} part ${i}/${n})`);
        }
        out += part;
      }
      return out;
    }); },
    set(key: string, val: string): Promise<void> { return serial(key, async () => {
      // WRITE NEW, THEN SWAP, THEN CLEAN. Never clear first.
      //
      // The old order deleted every existing part, wrote the new parts, then
      // wrote the head last. A process death anywhere in that window - Android
      // killing a backgrounded app during the OPK top-up is the ordinary case -
      // left a head naming parts that no longer existed. get() read that as
      // "absent", and absent identity means createIdentity(): a brand new
      // keypair, published, every session dead and all history undecryptable,
      // silently. See the comment in get().
      //
      // The head is ONE key, so replacing it is the only atomic step this store
      // offers. Everything before it is written to keys the CURRENT head does
      // not name, so the old value stays whole and readable right up to the
      // instant the new one becomes valid.
      const prev = await base.get(key);
      const prevGen = prev !== null && prev.startsWith(SENTINEL) ? parseHead(prev).gen : null;
      // Alternate 0/1. Two generations is all that can ever exist, so this
      // cannot grow, and the new parts never collide with the live ones.
      const gen = prevGen === 0 ? 1 : 0;

      if (byteLen(val) <= maxBytes) {
        await base.set(key, val); // COMMIT POINT
        await clearParts(key, prev);
        return;
      }
      const parts = splitBySize(val, maxBytes);
      for (let i = 0; i < parts.length; i++) await base.set(genKey(key, gen, i), parts[i]);
      await base.set(key, `${SENTINEL}${parts.length}:${gen}`); // COMMIT POINT
      await clearParts(key, prev);
    }); },
    del(key: string): Promise<void> { return serial(key, async () => {
      // Head first: once it is gone the value is gone, and orphaned parts are
      // unreachable rather than mistaken for a live value.
      const prev = await base.get(key);
      await base.del(key);
      await clearParts(key, prev);
    }); },
  };
}
