/**
 * Local plaintext message store + per-key serialization — the two pieces the
 * live wiring needs beyond the ratchet itself.
 *
 * Why a plaintext store: the Double Ratchet is forward-secret, so once it
 * advances you can NOT re-derive the key for an earlier message. The server
 * only holds ciphertext. So every message's plaintext is cached locally by
 * (chatId, messageId) when it is sent (own echo) or first decrypted, and the
 * UI renders history from this cache.
 *
 * Why a keyed lock: chat.tsx decrypts each visible bubble in its own
 * useEffect, so several first-decrypts for one peer can run concurrently.
 * Ratchet decrypt mutates+persists session state, so those must be serialized
 * per peer or the state clobbers itself. withLock(peerId, fn) chains them.
 *
 * Pure/injectable (no RN imports) → Node-tested in messageStore.selftest.ts.
 */
import type { KVStore } from './e2eeSession';

export interface MessageStore {
  get(chatId: string, messageId: number): Promise<string | null>;
  put(chatId: string, messageId: number, plaintext: string): Promise<void>;
}

export function createMessageStore(store: KVStore): MessageStore {
  const key = (chatId: string, id: number) => `vc_pt_${chatId}_${id}`;
  return {
    get: (chatId, id) => store.get(key(chatId, id)),
    put: (chatId, id, plaintext) => store.set(key(chatId, id), plaintext),
  };
}

/**
 * Returns withLock(key, fn): runs fn after any prior fn for the same key has
 * settled, so same-key operations never interleave. Different keys run freely.
 */
export function createKeyedLock(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = tails.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn); // run regardless of prior outcome
    // keep the tail from rejecting so the chain never breaks
    tails.set(key, run.then(() => undefined, () => undefined));
    return run;
  };
}
