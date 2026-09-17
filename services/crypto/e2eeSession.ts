/**
 * crazzychat E2EE session + identity manager (pure, injectable).
 * ───────────────────────────────────────────────────────────────────────
 * Sits between the proven crypto core (./e2ee) and the app. Handles:
 *   • local identity provisioning (IK + signing key + signed prekey + OTPKs)
 *   • publishing/fetching key bundles via an injected transport
 *   • per-peer X3DH bootstrap + Double Ratchet session persistence
 *   • the on-wire message format (versioned; carries the X3DH header until
 *     the initiator has heard back from the peer)
 *
 * This file is PURE: no expo-secure-store / no ./api imports, so it runs in
 * Node and is unit-tested with in-memory mocks (e2eeSession.selftest.ts). The
 * React-Native bindings (SecureStore + api()) live in e2eeSession.rn.ts.
 *
 * Backend bundle bridge: the backend stores a single opaque `identityKey`
 * blob. We pack BOTH public keys into it — X25519 IK (DH) ‖ Ed25519 signing
 * (SPK signature verification) — so no backend/migration change is needed.
 */

import {
  generateDH, generateSigningKey, sign,
  x3dhInitiator, x3dhResponder,
  ratchetInitAlice, ratchetInitBob, ratchetEncrypt, ratchetDecrypt,
  serializeState, deserializeState, encodeEnvelope, decodeEnvelope,
  bytesToHex, hexToBytes,
} from './index'; // the facade — picks TS or Rust per EXPO_PUBLIC_CRYPTO_BACKEND
import type { KeyPair, PreKeyBundle, InitialHeader, RatchetState, Envelope } from './index';

const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));
/**
 * Thrown when both peers re-keyed at once and WE are the side that keeps its
 * session. Callers must treat it as "skip this message", NOT as a decrypt
 * failure: resetting here would destroy the very session the peer is about to
 * adopt and restart the collision.
 */
export const CONCURRENT_REKEY = 'e2ee: concurrent re-key — keeping our session';

function packIdentity(ikPub: Uint8Array, signPub: Uint8Array): string {
  const out = new Uint8Array(64);
  out.set(ikPub, 0);
  out.set(signPub, 32);
  return b64(out);
}
function unpackIdentity(packed: string): { ik: Uint8Array; sign: Uint8Array } {
  const raw = unb64(packed);
  if (raw.length !== 64) throw new Error('e2ee: malformed packed identity key');
  return { ik: raw.slice(0, 32), sign: raw.slice(32, 64) };
}

// ── injected dependencies ──────────────────────────────────────────────
export interface KVStore {
  get(key: string): Promise<string | null>;
  set(key: string, val: string): Promise<void>;
  del(key: string): Promise<void>;
}
/** Wire shape mirrors the backend /user/keybundle routes exactly. */
export interface PublishBundle {
  identityKey: string;                                            // packed b64
  signedPreKey: { keyId: number; publicKey: string; signature: string };
  oneTimePreKeys: { keyId: number; publicKey: string }[];
}
export interface FetchedBundle {
  identityKey: string;                                            // packed b64
  signedPreKey: { keyId: number; publicKey: string; signature: string };
  oneTimePreKey?: { keyId: number; publicKey: string } | null;
}
export interface KeyBundleTransport {
  publish(bundle: PublishBundle): Promise<void>;
  fetch(peerId: string): Promise<FetchedBundle | null>;
}

// ── persisted local identity ────────────────────────────────────────────
interface StoredOpk { id: number; priv: string; pub: string; }
interface StoredIdentity {
  ikPriv: string; ikPub: string;
  signPriv: string; signPub: string;
  spkId: number; spkPriv: string; spkPub: string; spkSig: string;
  opks: StoredOpk[];     // private OTPKs still available to answer X3DH
  nextKeyId: number;
}
interface StoredSession {
  state: string;                 // serializeState()
  role: 'initiator' | 'responder';
  includeX3DH: boolean;          // initiator keeps sending header until first reply
  initialHeader?: { ik: string; ek: string; opkId: number | null };
  /**
   * The peer's identity key, hex, as of the session this record describes.
   *
   * Recorded so a CHANGE can be detected. A peer who reinstalls legitimately
   * gets a new identity key — and so does an attacker substituting their own.
   * The protocol cannot tell those apart, which is precisely why the change has
   * to be surfaced to the user instead of silently accepted. Without this field
   * a key substitution is completely invisible: the padlock still shows and the
   * ratchet still works, against the wrong person.
   */
  peerIkHex?: string;
}

const IDENTITY_KEY = 'vc_e2ee_identity';
const sessionKey = (peerId: string) => `vc_e2ee_session_${peerId}`;
/**
 * The peers we hold a session key for. 2026-09-17.
 *
 * Exists only so clearIdentity() can find its own keys. The store is
 * SecureStore-backed and SecureStore CANNOT ENUMERATE — there is no listing
 * call — so a key nobody wrote down is a key nobody can delete. That is how
 * signing out left user A's identity keypair and every ratchet on the device
 * for user B to inherit: the purge lists had nothing to name.
 *
 * PRE-INDEX SESSIONS ARE THE DANGEROUS CASE, not a cosmetic leftover. An
 * earlier version of this comment claimed an orphaned `vc_e2ee_session_<peer>`
 * was "unreadable without the identity and overwritten on next contact". Both
 * halves were wrong, and the correction is the whole reason clearIdentity()
 * takes an extra peer list:
 *   • a StoredSession is serializeState(ratchet) — SYMMETRIC root/chain keys.
 *     It does not need the identity keypair to work, so deleting the identity
 *     does not make it unreadable.
 *   • encryptForPeer() reuses any stored session UNCONDITIONALLY; it only
 *     re-runs X3DH when none exists, so nothing overwrites it.
 * So on an install predating the index, a sign-out left user B continuing user
 * A's ratchet: B's messages encrypted under A's chain, arriving at the peer
 * authenticated as A. That is an impersonation, not an orphan.
 *
 * Hence clearIdentity(alsoPeerIds) — the caller passes the peers the app
 * already knows from the local chat cache (see e2eeSession.rn), so those blobs
 * are enumerated even when the index never recorded them.
 *
 * RESIDUAL RISK, deliberately not papered over: a peer in NEITHER the index nor
 * the local chat cache — e.g. a chat deleted locally on a pre-index build while
 * its ratchet blob stayed — is still unreachable, because SecureStore cannot be
 * enumerated. Reopening that chat re-fetches the peer's bundle only if no
 * session exists, so such a blob would be reused. It is a narrow window on old
 * installs and it closes for good on the first sign-out after this build.
 *
 * Entries are never removed on resetSession() — deleting an absent key is a
 * no-op, and a stale name costs one wasted del() at purge time.
 */
const PEER_INDEX = 'vc_e2ee_peers';
// Refill the one-time prekey pool well before it empties.
//
// The top-up only runs from provisionE2EEIdentity() — app start and opening a
// chat — so the pool has to survive every session established BETWEEN those
// points. At the old floor of 5 an account sat at exactly 5 and did not refill
// (5 is not < 5), leaving room for only five incoming sessions before hitting
// zero. Running dry is not fatal — X3DH still completes without a one-time
// prekey — but it silently costs the forward secrecy the OTPK is there to
// provide, and nothing surfaces that it happened.
//
// 10 is simply enough slack that a burst between two app starts cannot drain
// the pool. Observed on a real account parked at exactly 5 after the
// consumption bug in [otpkConsume.selftest.ts] burned 15 of its 20.
const OPK_POOL_MIN = 10;
const OPK_BATCH = 20;

export interface E2EESession {
  /** Ensure a local identity exists and its bundle is published. Idempotent. */
  ensurePublished(): Promise<void>;
  /** Encrypt for a peer; bootstraps an X3DH session on first use. Returns wire JSON. */
  encryptForPeer(peerId: string, plaintext: string): Promise<string>;
  /** Decrypt a wire JSON from a peer; bootstraps the responder side on first inbound. */
  decryptFromPeer(peerId: string, wire: string): Promise<string>;
  /** True if a wire string is an E2EE envelope (vs. legacy plaintext). */
  isEnvelope(wire: string | null | undefined): boolean;
  /** Whether a usable session already exists for a peer. */
  hasSession(peerId: string): Promise<boolean>;
  /** Drop the local session so the next message re-initiates X3DH ("reset secure session"). */
  resetSession(peerId: string): Promise<void>;
  /**
   * The peer identity key this session was built on, hex, or null.
   *
   * For CHANGE detection, not for display. Safety numbers already exist
   * (services/security/safetyNumber.ts, rendered by app/verify-contact.tsx);
   * what was missing is noticing that a key differs from the one used before.
   */
  peerIdentityKey(peerId: string): Promise<string | null>;
  /**
   * Destroy this device's E2EE identity and every per-peer ratchet. 2026-09-17.
   *
   * Sign-out purges the local database, media and PIN, but the identity keypair
   * and the sessions built on it were in no purge list at all — so the next
   * account signed in on the device adopted the previous user's identity, and
   * their safety numbers were somebody else's.
   *
   * `alsoPeerIds` are peers to clear ON TOP of the index — see PEER_INDEX for
   * why an install predating the index cannot rely on the index alone.
   */
  clearIdentity(alsoPeerIds?: string[]): Promise<void>;
  /**
   * Record peers in the index WITHOUT touching their sessions.
   *
   * For the one writer that legitimately puts a session blob in the store
   * behind saveSession()'s back: the encrypted-backup restore in
   * e2eeSession.rn. A session the index never heard of is a session
   * clearIdentity() cannot delete.
   */
  rememberPeers(peerIds: string[]): Promise<void>;
  /**
   * The current identity generation — bumped by every clearIdentity().
   *
   * Lets a caller holding a fire-and-forget promise tell whether the identity
   * it started with is still the live one. See provisionE2EEIdentity().
   */
  identityGeneration(): number;
}

export function createE2EESession(deps: { store: KVStore; transport: KeyBundleTransport }): E2EESession {
  const { store, transport } = deps;

  async function loadIdentity(): Promise<StoredIdentity | null> {
    const raw = await store.get(IDENTITY_KEY);
    return raw ? (JSON.parse(raw) as StoredIdentity) : null;
  }
  async function saveIdentity(id: StoredIdentity): Promise<void> {
    await store.set(IDENTITY_KEY, JSON.stringify(id));
  }

  /**
   * Write a key, and make a concurrent purge WIN. 2026-09-17.
   *
   * Checking the generation before the write is not enough on its own: a
   * SecureStore write is slow and chunked, so clearIdentity() lands DURING one
   * routinely — the store deletes the key, our write then recreates it, and the
   * account is back. The store offers no compare-and-swap, so the only way for
   * the purge to win is to check again afterwards and undo what we wrote.
   *
   * Deleting is right even in the rare case where the next account has already
   * written this key: chunkedKV serializes per key, so our write overwrote
   * theirs whole, and an absent key re-provisions cleanly while a stale one is
   * the leak this whole mechanism exists to stop.
   */
  async function guardedSet(k: string, v: string, gen: number): Promise<void> {
    if (gen !== _generation) return;
    await store.set(k, v);
    if (gen !== _generation) { try { await store.del(k); } catch {} }
  }

  // Single-flight identity: the local identity is loaded (or created) exactly
  // ONCE and shared by every caller — publish, encrypt, and decrypt. Without
  // this, provisioning fired from two places at once (app/_layout + app/chat)
  // each ran createIdentity(), and their chunked SecureStore writes interleaved
  // and corrupted the stored blob — so loadIdentity() later returned null
  // ("local identity not provisioned") even though the key bundle had just been
  // published. Memoizing the create makes that race impossible.
  let _identity: StoredIdentity | null = null;
  let _identityPromise: Promise<StoredIdentity> | null = null;

  /**
   * IDENTITY GENERATION — the half a flag reset cannot reach. 2026-09-17.
   *
   * clearIdentity() can null the memos below, but it CANNOT cancel work that is
   * already sitting on an await. provisionE2EEIdentity() is fired and forgotten
   * from app/_layout, so a forced sign-out lands in the middle of it routinely:
   *
   *   1. ensurePublished() captures `id` from getIdentity()
   *   2. the purge deletes vc_e2ee_identity, the sessions and the index
   *   3. the in-flight publish reaches its OTPK top-up and calls
   *      saveIdentitySerial(id) — WRITING THE DELETED IDENTITY BACK TO DISK,
   *      re-publishing the purged public key, and marking itself provisioned
   *
   * The next account then inherits the previous user's identity and never
   * publishes its own: exactly the leak the purge was added to close, restored
   * by a promise nobody could cancel.
   *
   * So every write carries the generation it was PLANNED under and is dropped
   * if the generation has moved on. A counter and not a flag, because a second
   * purge during the first one's recovery has to invalidate that work too.
   */
  let _generation = 0;
  /** Thrown when the account was purged while its identity was being loaded. */
  const IDENTITY_CLEARED = 'e2ee: identity cleared during load';

  function getIdentity(): Promise<StoredIdentity> {
    if (_identity) return Promise.resolve(_identity);
    if (!_identityPromise) {
      _identityPromise = (async () => {
        const gen = _generation;
        const id = (await loadIdentity()) ?? (await createIdentity(gen));
        // A purge landed while we were reading: `id` is the dead account's
        // keypair (or one created for it). Caching it would hand the next
        // getIdentity() the very thing the purge deleted, and publishing it
        // would re-expose the signed-out user's public key. Fail instead — the
        // catch below clears the memo, so the next caller retries cleanly and
        // gets a fresh identity for whoever is signed in now.
        if (gen !== _generation) throw new Error(IDENTITY_CLEARED);
        _identity = id;
        return id;
      })();
      _identityPromise.catch(() => { _identityPromise = null; }); // allow retry on failure
    }
    return _identityPromise;
  }

  // Serialize identity writes so concurrent mutations (OTPK top-up on publish,
  // OTPK consumption on decrypt) never interleave their chunked writes.
  let _saveChain: Promise<void> = Promise.resolve();
  function saveIdentitySerial(id: StoredIdentity, gen: number): Promise<void> {
    // Through guardedSet, and evaluated INSIDE the chained closure: this write
    // may have been queued behind an await that a purge slipped through, and it
    // may also be overtaken by one while it runs.
    const write = () => guardedSet(IDENTITY_KEY, JSON.stringify(id), gen);
    const next = _saveChain.then(write, write);
    _saveChain = next.catch(() => {});
    return next;
  }
  function newOpks(start: number, n: number): StoredOpk[] {
    const out: StoredOpk[] = [];
    for (let i = 0; i < n; i++) {
      const kp = generateDH();
      out.push({ id: start + i, priv: bytesToHex(kp.priv), pub: bytesToHex(kp.pub) });
    }
    return out;
  }
  async function createIdentity(gen: number): Promise<StoredIdentity> {
    const ik = generateDH();
    const signing = generateSigningKey();
    const spk = generateDH();
    const spkId = 1;
    const spkSig = sign(spk.pub, signing.priv);
    const opks = newOpks(2, OPK_BATCH);
    const id: StoredIdentity = {
      ikPriv: bytesToHex(ik.priv), ikPub: bytesToHex(ik.pub),
      signPriv: bytesToHex(signing.priv), signPub: bytesToHex(signing.pub),
      spkId, spkPriv: bytesToHex(spk.priv), spkPub: bytesToHex(spk.pub), spkSig: bytesToHex(spkSig),
      opks,
      nextKeyId: 2 + OPK_BATCH,
    };
    // Through the guarded writer: a keypair minted for an account that signed
    // out mid-creation must not be left on disk for the next one to adopt.
    await saveIdentitySerial(id, gen);
    return id;
  }
  function publishPayload(id: StoredIdentity): PublishBundle {
    return {
      identityKey: packIdentity(hexToBytes(id.ikPub), hexToBytes(id.signPub)),
      signedPreKey: {
        keyId: id.spkId,
        publicKey: b64(hexToBytes(id.spkPub)),
        signature: b64(hexToBytes(id.spkSig)),
      },
      oneTimePreKeys: id.opks.map((o) => ({ keyId: o.id, publicKey: b64(hexToBytes(o.pub)) })),
    };
  }

  async function ensurePublished(): Promise<void> {
    const gen = _generation;
    const id = await getIdentity();
    // Top up the OTPK pool if it has run low.
    // <=, not <: the floor is the number of prekeys we want to KEEP available,
    // so being down to it is already the trigger. With a strict < a pool that
    // lands exactly on the floor never refills, which is how a real account
    // ended up parked at exactly 5 with no margin at all.
    if (id.opks.length <= OPK_POOL_MIN) {
      const fresh = newOpks(id.nextKeyId, OPK_BATCH);
      id.opks.push(...fresh);
      id.nextKeyId += OPK_BATCH;
      await saveIdentitySerial(id, gen);
    }
    // Never republish an identity that has been purged since we captured it.
    // This call is fire-and-forget from app/_layout, so a sign-out can land at
    // any await above. The check cannot be atomic with the network call — a
    // request already on the wire still lands — but it carries the signed-out
    // user's bearer token, which the backend rejects, and the next account
    // publishes its own bundle because _provisioned was never set (see
    // provisionE2EEIdentity).
    if (gen !== _generation) return;
    await transport.publish(publishPayload(id));
  }

  function identityKeyPairs(id: StoredIdentity): { ik: KeyPair; spk: KeyPair } {
    return {
      ik: { priv: hexToBytes(id.ikPriv), pub: hexToBytes(id.ikPub) },
      spk: { priv: hexToBytes(id.spkPriv), pub: hexToBytes(id.spkPub) },
    };
  }
  function toPreKeyBundle(f: FetchedBundle): PreKeyBundle {
    const idk = unpackIdentity(f.identityKey);
    return {
      identityKey: idk.ik,
      signingKey: idk.sign,
      signedPreKey: unb64(f.signedPreKey.publicKey),
      signedPreKeySig: unb64(f.signedPreKey.signature),
      oneTimePreKey: f.oneTimePreKey ? unb64(f.oneTimePreKey.publicKey) : null,
      oneTimePreKeyId: f.oneTimePreKey ? f.oneTimePreKey.keyId : null,
    };
  }

  async function loadSession(peerId: string): Promise<StoredSession | null> {
    const raw = await store.get(sessionKey(peerId));
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  }
  async function saveSession(peerId: string, s: StoredSession, gen: number): Promise<void> {
    // Same reason as saveIdentitySerial: a ratchet written after the purge is a
    // ratchet the purge cannot have deleted, and encryptForPeer() reuses any
    // stored session unconditionally — so the next account would carry on this
    // one's chain, sending as the previous user.
    if (gen !== _generation) return;
    await guardedSet(sessionKey(peerId), JSON.stringify(s), gen);
    await rememberPeers([peerId], gen);
  }

  // Peer index (see PEER_INDEX). Cached in memory so the common case — a peer
  // we already know, saving a session on every message — costs nothing.
  let _peers: Set<string> | null = null;
  async function loadPeers(): Promise<Set<string>> {
    if (_peers) return _peers;
    try {
      const raw = await store.get(PEER_INDEX);
      const arr = raw ? JSON.parse(raw) : [];
      _peers = new Set(Array.isArray(arr) ? arr.filter((p) => typeof p === 'string') : []);
    } catch { _peers = new Set(); }
    return _peers;
  }
  async function rememberPeers(peerIds: string[], gen = _generation): Promise<void> {
    // Best-effort: failing to index a peer must never fail a message.
    try {
      const peers = await loadPeers();
      const added = [...new Set(peerIds)].filter((p) => p && !peers.has(p));
      if (!added.length) return;
      // WRITE FIRST, memoize on SUCCESS. 2026-09-17.
      //
      // This used to add to the memo and then write. The write is wrapped in
      // `catch {}` (by design — indexing a peer must not fail a message), so a
      // throwing SecureStore write left the peer marked indexed for the whole
      // process lifetime: every later saveSession() short-circuited on the memo,
      // nothing ever retried the write, and that peer's session survived the
      // purge. A security index that silently stops recording is worse than
      // none, because clearIdentity() reports success either way.
      await guardedSet(PEER_INDEX, JSON.stringify([...peers, ...added]), gen);
      for (const p of added) peers.add(p);
    } catch {}
  }

  async function clearIdentity(alsoPeerIds: string[] = []): Promise<void> {
    // BUMP FIRST. Everything already in flight was planned under the old
    // generation and must be dropped from here on — including a publish or a
    // ratchet save that is parked on an await right now. See _generation.
    _generation++;
    // Sessions first: if this is interrupted, an identity with no sessions
    // re-keys cleanly, while sessions with no identity are undecryptable junk.
    //
    // `alsoPeerIds` covers what the index cannot: sessions written before the
    // index existed. See PEER_INDEX — those blobs are live symmetric ratchets,
    // not inert leftovers. Deleting a key that was never there is a no-op, so
    // an over-broad list costs one wasted del() each and nothing else.
    const targets = new Set<string>(alsoPeerIds.filter((p) => typeof p === 'string' && p));
    try { for (const peerId of await loadPeers()) targets.add(peerId); } catch {}
    for (const peerId of targets) {
      try { await store.del(sessionKey(peerId)); } catch {}
    }
    try { await store.del(PEER_INDEX); } catch {}
    try { await store.del(IDENTITY_KEY); } catch {}
    // The single-flight memo is the other half of the leak: without this the
    // next getIdentity() in this process hands out the keypair we just deleted
    // from disk, and the new account publishes the old user's public key.
    _identity = null;
    _identityPromise = null;
    _peers = null;
  }

  async function hasSession(peerId: string): Promise<boolean> {
    return (await store.get(sessionKey(peerId))) !== null;
  }

  function isEnvelope(wire: string | null | undefined): boolean {
    if (!wire || typeof wire !== 'string' || wire[0] !== '{') return false;
    try { return JSON.parse(wire)?.v === 'dr1'; } catch { return false; }
  }

  async function encryptForPeer(peerId: string, plaintext: string): Promise<string> {
    const gen = _generation;
    const id = await getIdentity();

    let session = await loadSession(peerId);
    let state: RatchetState;
    if (!session) {
      const fetched = await transport.fetch(peerId);
      if (!fetched) throw new Error(`e2ee: peer ${peerId} has no key bundle`);
      const bundle = toPreKeyBundle(fetched);
      const me = identityKeyPairs(id);
      const init = x3dhInitiator(me.ik, bundle);
      state = ratchetInitAlice(init.sk, bundle.signedPreKey);
      session = {
        state: serializeState(state),
        role: 'initiator',
        includeX3DH: true,
        initialHeader: {
          ik: b64(init.header.identityKey),
          ek: b64(init.header.ephemeralKey),
          opkId: init.header.oneTimePreKeyId ?? null,
        },
        // The peer's identity key, from the bundle we just built this session on.
        //
        // Recorded HERE and not only on the responder path, because the
        // initiator is the side that gets no other chance to learn it. Without
        // this line peerIdentityKey() returned null for every conversation this
        // device STARTED, so lib/keyChange.ts had no baseline to compare
        // against — it recorded a key for the first time only after the peer
        // had already re-keyed, and reported "first contact, nothing to warn
        // about". A peer reinstalling, or an attacker substituting their key,
        // was silent on exactly the half of all conversations we initiated.
        peerIkHex: bytesToHex(bundle.identityKey),
      };
    } else {
      state = deserializeState(session.state);
    }

    const env = ratchetEncrypt(state, new TextEncoder().encode(plaintext));
    session.state = serializeState(state);
    await saveSession(peerId, session, gen);

    const wire: any = { v: 'dr1', env: encodeEnvelope(env) };
    if (session.includeX3DH && session.initialHeader) wire.x3dh = session.initialHeader;
    return JSON.stringify(wire);
  }

  // Bootstrap a fresh responder ratchet from a message's X3DH header. Consumes the
  // one-time prekey the initiator used (if any). Shared by the no-session path and
  // the re-key recovery path below.
  /** Raised when the sender referenced a one-time prekey we no longer hold. */
  const MISSING_OPK = 'e2ee: missing requested one-time prekey';

  /**
   * Derive the responder side of X3DH from a message's header.
   *
   * DOES NOT CONSUME the one-time prekey. It returns a `commit` the caller runs
   * only once the message has actually decrypted.
   *
   * WHY THAT ORDERING IS THE WHOLE POINT
   * ------------------------------------
   * This used to splice the OTPK out and save BEFORE the caller decrypted. When
   * the decrypt then failed — for any reason at all — the key was gone, and the
   * retry was doomed in a way nothing could recover:
   *
   *   1. an offer arrives carrying opkId 7; we consume 7 and derive a secret
   *   2. decrypt fails
   *   3. the ring loop resends the SAME offer, still referencing opkId 7
   *   4. 7 is gone, findIndex returns -1, and myOpk fell back to null
   *   5. x3dhResponder then derived a DIFFERENT secret than the sender used
   *   6. "aes/gcm: invalid ghash tag" — forever, through any number of resets,
   *      because the sender's stored initialHeader keeps naming the same OTPK
   *
   * Measured on device as resets=4, decryptFails=29 with concurrentRekeys=0,
   * and 15 of one account's 20 prekeys burned by failed bootstraps.
   *
   * The silent `myOpk = null` fallback was the second half of the bug: a
   * missing OTPK is not a reason to compute a different key, it is a reason to
   * stop. Failing loudly turns an unrecoverable wrong-key state into an ordinary
   * re-key request.
   */
  async function bootstrapResponder(
    parsed: any, id: StoredIdentity, gen: number,
  ): Promise<{ state: RatchetState; commit: () => Promise<void> }> {
    const header: InitialHeader = {
      identityKey: unb64(parsed.x3dh.ik),
      ephemeralKey: unb64(parsed.x3dh.ek),
      oneTimePreKeyId: parsed.x3dh.opkId ?? null,
    };
    const me = identityKeyPairs(id);

    let myOpk: KeyPair | null = null;
    let consumeIdx = -1;
    if (header.oneTimePreKeyId != null) {
      consumeIdx = id.opks.findIndex((o) => o.id === header.oneTimePreKeyId);
      if (consumeIdx < 0) {
        // The sender used a prekey we have already spent. Any secret derived
        // here would be wrong, so say so instead of producing one.
        throw new Error(MISSING_OPK);
      }
      myOpk = {
        priv: hexToBytes(id.opks[consumeIdx].priv),
        pub: hexToBytes(id.opks[consumeIdx].pub),
      };
    }

    const sk = x3dhResponder(me.ik, me.spk, myOpk, header);
    const state = ratchetInitBob(sk, me.spk);

    return {
      state,
      commit: async () => {
        if (consumeIdx < 0) return;
        // Re-find by id: the pool may have been mutated (an OTPK top-up, or a
        // concurrent bootstrap) between derivation and commit, so a stale index
        // would delete the wrong key.
        const i = id.opks.findIndex((o) => o.id === header.oneTimePreKeyId);
        if (i >= 0) {
          id.opks.splice(i, 1);       // consumed exactly once, and only on success
          await saveIdentitySerial(id, gen);
        }
      },
    };
  }

  async function decryptFromPeer(peerId: string, wire: string): Promise<string> {
    const parsed = JSON.parse(wire);
    if (parsed?.v !== 'dr1' || !parsed.env) throw new Error('e2ee: not a dr1 envelope');

    const gen = _generation;
    const id = await getIdentity();
    const envelope = decodeEnvelope(parsed.env) as Envelope;

    const session = await loadSession(peerId);

    if (!session) {
      if (!parsed.x3dh) throw new Error('e2ee: no session and no X3DH header to bootstrap responder');
      const { state, commit } = await bootstrapResponder(parsed, id, gen);
      // Decrypt FIRST. If this throws, the one-time prekey is still in the pool
      // and the sender's retry can bootstrap again with the same header.
      const plaintextBytes = ratchetDecrypt(state, envelope);
      await commit();
      await saveSession(peerId, { state: serializeState(state), role: 'responder', includeX3DH: false,
        peerIkHex: bytesToHex(unb64(parsed.x3dh.ik)) }, gen);
      return new TextDecoder().decode(plaintextBytes);
    }

    const state = deserializeState(session.state);
    try {
      const plaintextBytes = ratchetDecrypt(state, envelope);
      // Initiator: receiving a reply proves the peer established the session →
      // stop attaching the X3DH header to future messages.
      if (session.role === 'initiator' && session.includeX3DH) session.includeX3DH = false;
      session.state = serializeState(state);
      await saveSession(peerId, session, gen);
      return new TextDecoder().decode(plaintextBytes);
    } catch (err) {
      // The cached session can't decrypt this. If the message carries an X3DH
      // header, the peer RE-KEYED (e.g. reinstalled / fresh identity) and is
      // bootstrapping a new session — our old one is dead. Adopt the new session
      // and retry, so the conversation self-heals instead of being stuck on
      // "unable to decrypt" forever.
      if (!parsed.x3dh) throw err;

      // SIMULTANEOUS RE-KEY (glare at the session layer).
      //
      // Adopting the peer's session is right when only THEY re-keyed. When both
      // sides re-key at once — which is exactly what a mutual "reset + ask the
      // peer to reset" recovery produces — both hold an outstanding initiator
      // session and both receive an X3DH-headed message. If both adopt, they
      // SWAP: each ends up on the other's session and neither can decrypt, so
      // both fail again, reset again, and the loop never converges. Observed on
      // device as repeated "aes/gcm: invalid ghash tag" with resets firing in
      // pairs until the call gave up.
      //
      // Break the tie deterministically on the identity keys, which both sides
      // already have: the LOWER key yields and adopts, the higher keeps its own
      // and the peer converges onto it. Same shape as the ICE glare rule — it
      // does not matter which session wins, only that both pick the same one.
      //
      // Scoped to the collision: a plain responder, or an initiator whose
      // session is already established, still adopts exactly as before, so a
      // genuinely reinstalled peer heals on the first message.
      if (session.role === 'initiator' && session.includeX3DH) {
        const mine = id.ikPub.toLowerCase();
        const theirs = bytesToHex(unb64(parsed.x3dh.ik)).toLowerCase();
        if (mine > theirs) {
          // We win: keep our session untouched. Their next message arrives on
          // it once they adopt. This ONE message is undecryptable, which is
          // harmless — call offers repeat every 3s and text is re-sent.
          throw new Error(CONCURRENT_REKEY);
        }
      }

      const { state: fresh, commit } = await bootstrapResponder(parsed, id, gen);
      const plaintextBytes = ratchetDecrypt(fresh, envelope); // throws if genuinely undecryptable
      await commit();                                        // only now is the OTPK spent
      await saveSession(peerId, { state: serializeState(fresh), role: 'responder', includeX3DH: false,
        peerIkHex: bytesToHex(unb64(parsed.x3dh.ik)) }, gen);
      return new TextDecoder().decode(plaintextBytes);
    }
  }

  // Drop the local session for a peer. The next outbound message then re-initiates
  // X3DH (Signal's "reset secure session"); the peer adopts it on receipt.
  async function resetSession(peerId: string): Promise<void> {
    await store.del(sessionKey(peerId));
  }

  /**
   * The peer identity key this session was built on, hex, or null.
   *
   * Deliberately NOT a safety number: services/security/safetyNumber.ts already
   * computes those and app/verify-contact.tsx already renders them. A second
   * construction would produce a DIFFERENT number for the same pair, and a user
   * comparing codes across two screens would conclude their conversation was
   * compromised.
   *
   * What was missing is the other half — noticing a key CHANGED. The screen
   * shows today's number; nothing warned when yesterday's differed. A peer who
   * reinstalls gets a new key legitimately, and so does an attacker
   * substituting their own; the protocol cannot tell them apart, so the change
   * must be surfaced rather than silently accepted.
   */
  async function peerIdentityKey(peerId: string): Promise<string | null> {
    const sess = await loadSession(peerId);
    return sess?.peerIkHex ?? null;
  }

  return { ensurePublished, encryptForPeer, decryptFromPeer, isEnvelope, hasSession, resetSession,
    peerIdentityKey, clearIdentity, rememberPeers, identityGeneration: () => _generation };
}
