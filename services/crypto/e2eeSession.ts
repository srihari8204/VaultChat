/**
 * VaultChat E2EE session + identity manager (pure, injectable).
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
} from './e2ee';
import type { KeyPair, PreKeyBundle, InitialHeader, RatchetState, Envelope } from './e2ee';

const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));
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
}

const IDENTITY_KEY = 'vc_e2ee_identity';
const sessionKey = (peerId: string) => `vc_e2ee_session_${peerId}`;
const OPK_POOL_MIN = 5;
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

  // Single-flight identity: the local identity is loaded (or created) exactly
  // ONCE and shared by every caller — publish, encrypt, and decrypt. Without
  // this, provisioning fired from two places at once (app/_layout + app/chat)
  // each ran createIdentity(), and their chunked SecureStore writes interleaved
  // and corrupted the stored blob — so loadIdentity() later returned null
  // ("local identity not provisioned") even though the key bundle had just been
  // published. Memoizing the create makes that race impossible.
  let _identity: StoredIdentity | null = null;
  let _identityPromise: Promise<StoredIdentity> | null = null;
  function getIdentity(): Promise<StoredIdentity> {
    if (_identity) return Promise.resolve(_identity);
    if (!_identityPromise) {
      _identityPromise = (async () => {
        const id = (await loadIdentity()) ?? (await createIdentity());
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
  function saveIdentitySerial(id: StoredIdentity): Promise<void> {
    const next = _saveChain.then(() => saveIdentity(id), () => saveIdentity(id));
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
  async function createIdentity(): Promise<StoredIdentity> {
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
    await saveIdentity(id);
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
    const id = await getIdentity();
    // Top up the OTPK pool if it has run low.
    if (id.opks.length < OPK_POOL_MIN) {
      const fresh = newOpks(id.nextKeyId, OPK_BATCH);
      id.opks.push(...fresh);
      id.nextKeyId += OPK_BATCH;
      await saveIdentitySerial(id);
    }
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
  async function saveSession(peerId: string, s: StoredSession): Promise<void> {
    await store.set(sessionKey(peerId), JSON.stringify(s));
  }

  async function hasSession(peerId: string): Promise<boolean> {
    return (await store.get(sessionKey(peerId))) !== null;
  }

  function isEnvelope(wire: string | null | undefined): boolean {
    if (!wire || typeof wire !== 'string' || wire[0] !== '{') return false;
    try { return JSON.parse(wire)?.v === 'dr1'; } catch { return false; }
  }

  async function encryptForPeer(peerId: string, plaintext: string): Promise<string> {
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
      };
    } else {
      state = deserializeState(session.state);
    }

    const env = ratchetEncrypt(state, new TextEncoder().encode(plaintext));
    session.state = serializeState(state);
    await saveSession(peerId, session);

    const wire: any = { v: 'dr1', env: encodeEnvelope(env) };
    if (session.includeX3DH && session.initialHeader) wire.x3dh = session.initialHeader;
    return JSON.stringify(wire);
  }

  async function decryptFromPeer(peerId: string, wire: string): Promise<string> {
    const parsed = JSON.parse(wire);
    if (parsed?.v !== 'dr1' || !parsed.env) throw new Error('e2ee: not a dr1 envelope');

    const id = await getIdentity();

    let session = await loadSession(peerId);
    let state: RatchetState;

    if (!session) {
      if (!parsed.x3dh) throw new Error('e2ee: no session and no X3DH header to bootstrap responder');
      const header: InitialHeader = {
        identityKey: unb64(parsed.x3dh.ik),
        ephemeralKey: unb64(parsed.x3dh.ek),
        oneTimePreKeyId: parsed.x3dh.opkId ?? null,
      };
      const me = identityKeyPairs(id);
      // Find + consume the one-time prekey the initiator used (if any).
      let myOpk: KeyPair | null = null;
      if (header.oneTimePreKeyId != null) {
        const idx = id.opks.findIndex((o) => o.id === header.oneTimePreKeyId);
        if (idx >= 0) {
          myOpk = { priv: hexToBytes(id.opks[idx].priv), pub: hexToBytes(id.opks[idx].pub) };
          id.opks.splice(idx, 1);     // consumed exactly once
          await saveIdentitySerial(id);
        }
      }
      const sk = x3dhResponder(me.ik, me.spk, myOpk, header);
      state = ratchetInitBob(sk, me.spk);
      session = { state: serializeState(state), role: 'responder', includeX3DH: false };
    } else {
      state = deserializeState(session.state);
    }

    const plaintextBytes = ratchetDecrypt(state, decodeEnvelope(parsed.env) as Envelope);
    // Initiator: receiving a reply proves the peer established the session →
    // stop attaching the X3DH header to future messages.
    if (session.role === 'initiator' && session.includeX3DH) session.includeX3DH = false;
    session.state = serializeState(state);
    await saveSession(peerId, session);
    return new TextDecoder().decode(plaintextBytes);
  }

  return { ensurePublished, encryptForPeer, decryptFromPeer, isEnvelope, hasSession };
}
