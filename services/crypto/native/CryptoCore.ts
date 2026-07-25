/**
 * services/crypto/native/CryptoCore.ts — typed surface over the Rust core.
 *
 * SAME function signatures as e2ee.ts / senderKey.ts / shamir.ts, backed by
 * the Nitro HybridObject "CryptoCore" (one sync JSI method: call(op, argsJson)
 * → responseJson; bytes travel as hex, ratchet state as the canonical
 * serializeState JSON — see services/crypto/rust/DESIGN.md §4).
 *
 * Nothing imports this file except the facade (services/crypto/index.ts),
 * which owns backend selection + TS fallback. initNativeCrypto() never throws.
 *
 * Known, intentional divergence: on a FAILED decrypt the TS impl leaves
 * partial in-memory state mutations behind; this wrapper only applies native
 * state on SUCCESS (atomic — strictly safer, invisible to consumers, which
 * never persist state after a failed decrypt).
 */
import type { Envelope, InitialHeader, KeyPair, PreKeyBundle, RatchetState } from '../e2ee';
import {
  bytesToHex,
  decodeEnvelope,
  deserializeState,
  encodeEnvelope,
  hexToBytes,
  serializeState,
} from '../e2ee';
import type { GroupCipher, OwnSenderKey, PeerSenderKey, SenderKeyDistribution } from '../senderKey';
import type { SplitOptions } from '../shamir';

interface NativeCryptoCore {
  call(op: string, argsJson: string): string;
}

let native: NativeCryptoCore | null = null;
let initError: string | null = null;

/** Bind + self-check the native HybridObject. Never throws; safe to re-call. */
export function initNativeCrypto(): boolean {
  if (native) return true;
  if (initError !== null) return false;
  try {
    // Lazy require: Node test runs and TS-backend sessions never touch the
    // native module at all.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NitroModules } = require('react-native-nitro-modules');
    const obj = NitroModules.createHybridObject('CryptoCore') as unknown as NativeCryptoCore;
    const probe = JSON.parse(obj.call('selfCheck', '{}'));
    if (!probe.ok) throw new Error(probe.error || 'crypto-core: self-check failed');
    native = obj;
    return true;
  } catch (e) {
    initError = String((e as Error)?.message || e);
    return false;
  }
}

/** Why init failed (for the facade's Sentry breadcrumb), or null. */
export function nativeCryptoInitError(): string | null {
  return initError;
}

function invoke(op: string, args: unknown): any {
  if (!native) throw new Error('crypto-core: native module not initialised');
  const resp = JSON.parse(native.call(op, JSON.stringify(args)));
  if (!resp.ok) throw new Error(resp.error || 'crypto-core: unknown native error');
  return resp.result;
}

const kpIn = (k: KeyPair) => ({ priv: bytesToHex(k.priv), pub: bytesToHex(k.pub) });
const kpOut = (k: { priv: string; pub: string }): KeyPair => ({
  priv: hexToBytes(k.priv),
  pub: hexToBytes(k.pub),
});

// ── e2ee: primitives ───────────────────────────────────────────────────

export function generateDH(): KeyPair {
  return kpOut(invoke('generateDH', {}));
}
export function generateSigningKey(): KeyPair {
  return kpOut(invoke('generateSigningKey', {}));
}
export function sign(msg: Uint8Array, signingPriv: Uint8Array): Uint8Array {
  return hexToBytes(invoke('sign', { msg: bytesToHex(msg), priv: bytesToHex(signingPriv) }));
}
export function verify(sig: Uint8Array, msg: Uint8Array, signingPub: Uint8Array): boolean {
  return invoke('verify', {
    sig: bytesToHex(sig),
    msg: bytesToHex(msg),
    pub: bytesToHex(signingPub),
  });
}

// ── e2ee: X3DH ─────────────────────────────────────────────────────────

export function x3dhInitiator(
  myIdentity: KeyPair,
  bundle: PreKeyBundle,
): { sk: Uint8Array; ephemeral: KeyPair; header: InitialHeader } {
  const r = invoke('x3dhInitiator', {
    myIdentity: kpIn(myIdentity),
    bundle: {
      identityKey: bytesToHex(bundle.identityKey),
      signingKey: bytesToHex(bundle.signingKey),
      signedPreKey: bytesToHex(bundle.signedPreKey),
      signedPreKeySig: bytesToHex(bundle.signedPreKeySig),
      oneTimePreKey: bundle.oneTimePreKey ? bytesToHex(bundle.oneTimePreKey) : null,
      oneTimePreKeyId: bundle.oneTimePreKeyId ?? null,
    },
  });
  return {
    sk: hexToBytes(r.sk),
    ephemeral: kpOut(r.ephemeral),
    header: {
      identityKey: hexToBytes(r.header.identityKey),
      ephemeralKey: hexToBytes(r.header.ephemeralKey),
      oneTimePreKeyId: r.header.oneTimePreKeyId ?? null,
    },
  };
}

export function x3dhResponder(
  myIdentity: KeyPair,
  mySignedPreKey: KeyPair,
  myOneTimePreKey: KeyPair | null,
  header: InitialHeader,
): Uint8Array {
  return hexToBytes(
    invoke('x3dhResponder', {
      myIdentity: kpIn(myIdentity),
      mySignedPreKey: kpIn(mySignedPreKey),
      myOneTimePreKey: myOneTimePreKey ? kpIn(myOneTimePreKey) : null,
      header: {
        identityKey: bytesToHex(header.identityKey),
        ephemeralKey: bytesToHex(header.ephemeralKey),
      },
    }),
  );
}

// ── e2ee: Double Ratchet ───────────────────────────────────────────────
// Native works on the canonical serialized state; we mutate the caller's
// object in place to preserve the TS API's mutation semantics.

function pullState(state: RatchetState, json: string): void {
  const s = deserializeState(json);
  state.DHs = s.DHs;
  state.DHr = s.DHr;
  state.RK = s.RK;
  state.CKs = s.CKs;
  state.CKr = s.CKr;
  state.Ns = s.Ns;
  state.Nr = s.Nr;
  state.PN = s.PN;
  state.MKSKIPPED = s.MKSKIPPED;
}

export function ratchetInitAlice(sk: Uint8Array, bobSignedPreKeyPub: Uint8Array): RatchetState {
  return deserializeState(
    invoke('ratchetInitAlice', {
      sk: bytesToHex(sk),
      bobSignedPreKeyPub: bytesToHex(bobSignedPreKeyPub),
    }),
  );
}

export function ratchetInitBob(sk: Uint8Array, bobSignedPreKey: KeyPair): RatchetState {
  return deserializeState(
    invoke('ratchetInitBob', { sk: bytesToHex(sk), bobSignedPreKey: kpIn(bobSignedPreKey) }),
  );
}

export function ratchetEncrypt(state: RatchetState, plaintext: Uint8Array): Envelope {
  const r = invoke('ratchetEncrypt', {
    state: serializeState(state),
    plaintext: bytesToHex(plaintext),
  });
  pullState(state, r.state);
  return decodeEnvelope(r.envelope);
}

export function ratchetDecrypt(state: RatchetState, env: Envelope): Uint8Array {
  const r = invoke('ratchetDecrypt', {
    state: serializeState(state),
    envelope: encodeEnvelope(env),
  });
  pullState(state, r.state);
  return hexToBytes(r.plaintext);
}

// ── sender keys (records already travel as TS-shaped JSON) ─────────────

export function createSenderKey(): OwnSenderKey {
  return invoke('createSenderKey', {});
}
export function distributionMessage(own: OwnSenderKey): SenderKeyDistribution {
  return invoke('distributionMessage', { own });
}
export function processDistribution(skdm: SenderKeyDistribution): PeerSenderKey {
  return invoke('processDistribution', { skdm });
}
export function groupEncrypt(
  own: OwnSenderKey,
  plaintext: string,
): { cipher: GroupCipher; next: OwnSenderKey } {
  return invoke('groupEncrypt', { own, plaintext });
}
export function groupDecrypt(
  rec: PeerSenderKey,
  cipher: GroupCipher,
): { plaintext: string; next: PeerSenderKey } {
  return invoke('groupDecrypt', { rec, cipher });
}

// ── shamir ─────────────────────────────────────────────────────────────

export function splitSecret(secret: Uint8Array, { n, k }: SplitOptions): string[] {
  return invoke('splitSecret', { secret: bytesToHex(secret), n, k });
}
export function combineShares(rawShares: string[]): Uint8Array {
  return hexToBytes(invoke('combineShares', { shares: rawShares }));
}
export function shareThreshold(raw: string): number {
  return invoke('shareThreshold', { share: raw });
}
export function splitString(secret: string, opts: SplitOptions): string[] {
  return splitSecret(new TextEncoder().encode(secret), opts);
}
export function combineString(rawShares: string[]): string {
  return new TextDecoder().decode(combineShares(rawShares));
}
