// lib/callCrypto.ts — E2EE call signaling (F6).
//
// WhatsApp model: the server must never read the SDP (it carries the DTLS-SRTP
// fingerprint that anchors call-media E2EE — a server that can read/replace it
// can MITM the call) nor the ICE candidates (they expose device IPs).
//
// Design — per-call key, ratchet-wrapped ONCE (mirrors lib/mediaAttachments):
//   • The caller mints a random 32-byte call key and wraps it a single time
//     with the proven per-peer Double Ratchet (services/crypto/e2eeSession.rn).
//   • Every signaling frame (offer/answer/each ICE candidate) is then sealed
//     with AES-256-GCM under that call key.
//   Why not ratchet every frame: signaling is LOSSY (the relay drops frames to
//   an offline peer) and bursty (dozens of ICE candidates). Dropped ratchet
//   frames would accumulate skipped keys in the persisted text session and can
//   eventually break TEXT decrypt (MAX_SKIP) — one wrap per call sidesteps the
//   whole class, and a replayed/dropped GCM frame is harmless (decrypt is
//   stateless + idempotent, so re-accepting a re-sent ring also just works).
//
// Wire shapes (plain JSON objects on purpose — they survive every existing
// JSON.stringify/parse hop in _layout → incoming-call → videocall unchanged):
//   offer  = { v:'sig1', h:<ratchet envelope>, p:<frame> }
//   frame  = { v:'sig1f', p:'<b64 iv>.<b64 ct>' }
//   legacy = the raw plaintext object (no `v`) → passthrough, call stays
//            plaintext end-to-end (old-build peer), exactly as before.
//
// Self-heal: if the callee can't unwrap the call key (caller held a STALE
// session for a re-keyed/reinstalled callee — a one-shot offer has no follow-up
// to heal from, unlike text), the callee drops its dead session so the NEXT
// call/message re-runs X3DH, and this call fails cleanly instead of hanging.
//
// SCOPE: every call, 1:1 and group alike.
//
// This header used to say "1:1 only — group calls keep plaintext signaling",
// and that has not been true since the mesh landed. A mesh call is N pairwise
// links, and each one seals its own offer/answer/ICE through this module with
// its own per-link call key, so group signalling is E2EE by exactly the same
// mechanism as a 1:1 call — no SFU required, because there is no SFU to trust.
// (An SFU changes that calculus and is a separate design problem; nothing here
// is waiting on it.)
//
// Both wire layers are covered: media is DTLS-SRTP as always, and signalling is
// this. `plainCipher` remains the transparent passthrough that lets a peer on an
// older build still connect.

import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';
import { E2EE_ENABLED } from '../constants/flags';

export interface CallCipher {
  enc: boolean;
  /** Seal one signaling payload (SDP / ICE candidate) → sig1f frame. */
  seal(obj: any): any;
  /** Open a frame; passthrough for plaintext; null when undecryptable. */
  open(wire: any): any | null;
}

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

function gcmCipher(key: Uint8Array): CallCipher {
  return {
    enc: true,
    seal(obj: any) {
      const iv = randomBytes(12);
      const ct = gcm(key, iv).encrypt(new TextEncoder().encode(JSON.stringify(obj)));
      return { v: 'sig1f', p: `${b64(iv)}.${b64(ct)}` };
    },
    open(wire: any) {
      if (!wire || typeof wire !== 'object' || wire.v !== 'sig1f') return wire ?? null; // plaintext passthrough
      try {
        const [ivB64, ctB64] = String(wire.p).split('.');
        const pt = gcm(key, unb64(ivB64)).decrypt(unb64(ctB64));
        return JSON.parse(new TextDecoder().decode(pt));
      } catch { return null; }   // corrupt/foreign frame — skip, never teardown
    },
  };
}

export const plainCipher: CallCipher = {
  enc: false,
  seal: (obj: any) => obj,
  open: (wire: any) => (wire && typeof wire === 'object' && wire.v === 'sig1f' ? null : wire ?? null),
};
const passthrough = plainCipher;

/**
 * CALLER: mint a call key + build the encrypted offer wire. Returns null when
 * E2EE signaling isn't possible (flag off / peer has no key bundle yet) — the
 * caller then sends the classic plaintext offer, matching the old behaviour.
 */
export async function newCallCipher(
  peerId: string,
  offer: any,
): Promise<{ cipher: CallCipher; offerWire: any } | null> {
  if (!E2EE_ENABLED || !peerId) return null;
  try {
    const e2ee = await import('../services/crypto/e2eeSession.rn');
    const key = randomBytes(32);
    const header = await e2ee.e2eeEncrypt('', peerId, JSON.stringify({ v: 'sig1k', k: b64(key) }));
    const cipher = gcmCipher(key);
    return { cipher, offerWire: { v: 'sig1', h: header, p: cipher.seal(offer) } };
  } catch {
    return null;   // no session/bundle — legacy plaintext call
  }
}

// The ring loop re-sends the SAME offer wire every ~3s; the ratchet can only
// decrypt an envelope once, so cache the unwrapped key by its envelope.
const _keyCache = new Map<string, string>();

/**
 * CALLEE: given the received offer payload, return the cipher + decrypted
 * offer. Plaintext (legacy) offers pass through with a no-op cipher. Returns
 * offer:null when the wrapped key can't be opened (stale caller session) —
 * after dropping the dead session so the next attempt self-heals via X3DH.
 */
export async function openCallOffer(
  peerId: string,
  offerObj: any,
): Promise<{ cipher: CallCipher; offer: any | null }> {
  if (!offerObj || typeof offerObj !== 'object' || offerObj.v !== 'sig1') {
    return { cipher: passthrough, offer: offerObj ?? null };   // legacy plaintext
  }
  try {
    const e2ee = await import('../services/crypto/e2eeSession.rn');
    let keyB64 = _keyCache.get(offerObj.h);
    if (!keyB64) {
      const parsed = JSON.parse(await e2ee.e2eeDecrypt('', peerId, 0, offerObj.h));
      if (parsed?.v !== 'sig1k' || !parsed.k) throw new Error('bad call-key wrap');
      keyB64 = parsed.k as string;
      _keyCache.set(offerObj.h, keyB64);
      if (_keyCache.size > 32) { const first = _keyCache.keys().next().value; if (first) _keyCache.delete(first); }
    }
    const cipher = gcmCipher(unb64(keyB64));
    return { cipher, offer: cipher.open(offerObj.p) };
  } catch {
    // Dead/stale session (e.g. this device reinstalled after the caller last
    // ratcheted). Drop it so the NEXT call or message re-keys via X3DH.
    try {
      const e2ee = await import('../services/crypto/e2eeSession.rn');
      await e2ee.e2eeResetSession(peerId);
    } catch {}
    return { cipher: passthrough, offer: null };
  }
}

export default { newCallCipher, openCallOffer };
