// services/crypto/plaintextStore.rn.ts
//
// Where an own-sent message's plaintext is kept so the SENDER can render it.
// A Double Ratchet ciphertext cannot be opened by the party that produced it,
// so this cache is the only copy of your own outgoing text.
//
// It used to live in SecureStore (Android Keystore), one entry per message and
// split into ~1.8 KB chunks for anything longer. That is the wrong store:
//
//   • Volume — SecureStore is SharedPreferences + Keystore, meant for a handful
//     of secrets. A chat history is thousands of entries, and a long message is
//     several of them. Loading a chat does one Keystore decrypt PER own message.
//   • Silent loss — the write is wrapped in `catch {}` by its caller, so a
//     failed/oversized write is invisible, and the sender later sees
//     "[e2ee] own message has no cached plaintext" with no way to recover the
//     text. Observed on a real device for existing message ids.
//
// SQLite is the right store for per-message rows. Values go through the same
// encField/decField used for cached message bodies, so they stay encrypted at
// rest. Private KEYS (identity, ratchet sessions) deliberately stay in
// SecureStore — only this bulk plaintext cache moves.
//
// Migration is lazy and read-through: a miss falls back to SecureStore and
// promotes what it finds, so existing history stays readable with no boot cost
// and no migration pass to get wrong.

import type { KVStore } from './e2eeSession';

/** SQLite-backed KVStore, with read-through migration from `legacy`. */
export function sqliteKV(legacy: KVStore): KVStore {
  return {
    async get(key: string): Promise<string | null> {
      try {
        const { getMeta } = await import('../../lib/localDb');
        const { decField } = await import('../../lib/cacheCrypto');
        const hit = await getMeta(key);
        // '' is the tombstone written by del() — the kv table has no delete.
        // Treated as absent, which is also right for a message with no text.
        if (hit) return decField(hit);
        if (hit === '') return null;
      } catch { /* db unavailable — fall through to legacy */ }

      // Not in SQLite yet: this message predates the move. Read it from
      // SecureStore and promote it, so the next read is a plain DB hit.
      let old: string | null = null;
      try { old = await legacy.get(key); } catch { return null; }

      if (old == null) {
        // Remember the MISS. Without this, every message whose plaintext is
        // permanently gone re-reads SecureStore on every single app start, and
        // an Android Keystore read is expensive: ~1s per message was measured
        // during boot hydration, leaving the user on a white screen while ~80
        // dead lookups ran. The tombstone is read as "absent" above, so the
        // legacy store is consulted at most ONCE per message, ever.
        try {
          const { setMeta } = await import('../../lib/localDb');
          await setMeta(key, '');
        } catch { /* best-effort */ }
        return null;
      }
      try {
        const { setMeta } = await import('../../lib/localDb');
        const { encField } = await import('../../lib/cacheCrypto');
        const sealed = encField(old);
        if (sealed != null) await setMeta(key, sealed);
        // The legacy copy is intentionally NOT deleted. Removing it would make
        // this a one-way move with no fallback if the DB is later reset, and it
        // is bounded anyway — nothing new is ever written there.
      } catch { /* promotion is best-effort; the value is still returned */ }
      return old;
    },

    async set(key: string, value: string): Promise<void> {
      // Deliberately NOT swallowed. The caller decides what a failure means;
      // silently dropping a write here is exactly how own messages became
      // unreadable in the first place.
      const { setMeta } = await import('../../lib/localDb');
      const { encField } = await import('../../lib/cacheCrypto');
      // MUST be sealed: the kv table is documented as "not sealed — callers
      // store opaque cursors here, never content". Message text IS content, so
      // it is sealed with the same cache DEK as message bodies before it lands.
      // Writing it raw would move plaintext OUT of Keystore-backed storage and
      // into a readable DB row — a downgrade, not a fix.
      const sealed = encField(value);
      if (sealed == null) throw new Error('plaintext seal failed');
      await setMeta(key, sealed);
    },

    async del(key: string): Promise<void> {
      // Tombstone rather than DELETE: get() must not fall back to the legacy
      // SecureStore copy and resurrect a plaintext that was deliberately erased.
      try {
        const { setMeta } = await import('../../lib/localDb');
        await setMeta(key, '');
      } catch { /* best-effort */ }
      try { await legacy.del(key); } catch { /* legacy copy may not exist */ }
    },
  };
}

export default { sqliteKV };
