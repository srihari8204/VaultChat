/**
 * VaultChat group E2EE — Sender Keys (Signal-style), pure crypto core (W5).
 * ───────────────────────────────────────────────────────────────────────
 * Each member has, per group, a SENDER KEY: a symmetric hash ratchet (chain key)
 * plus an Ed25519 signing key. A member encrypts each message ONCE with the next
 * key off their own chain and signs the ciphertext; the same ciphertext fans out
 * to the whole group (efficient for large groups). Receivers hold a copy of each
 * sender's chain (delivered once as a Sender Key Distribution Message over the
 * existing pairwise Double Ratchet) and ratchet it forward to decrypt + verify.
 *
 * Forward secrecy: the chain ratchets one step per message (old keys unrecoverable).
 * Authenticity: the Ed25519 signature stops any member forging another's messages.
 * Membership change: the leaver's copy of everyone's chain goes stale once members
 * ROTATE (createSenderKey again + redistribute), so the leaver can't read new msgs.
 *
 * Pure (only @noble) → the EXACT code runs in Node (senderKey.selftest.ts) and
 * Hermes. JSON-serializable state (hex strings) so the RN layer can persist it.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';

const TE = new TextEncoder();
const TD = new TextDecoder();
const toB64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));
const INFO_MSG = TE.encode('VaultChat-SenderKey-Msg-v1');

// Cap how many skipped message keys we'll derive across a gap, to bound work if a
// peer sends a wildly large iteration (DoS guard). 2000 ≫ any real reordering.
const MAX_SKIP = 2000;

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = (n >>> 24) & 0xff; b[1] = (n >>> 16) & 0xff; b[2] = (n >>> 8) & 0xff; b[3] = n & 0xff;
  return b;
}
function concat(...arrs: Uint8Array[]): Uint8Array {
  let len = 0; for (const a of arrs) len += a.length;
  const out = new Uint8Array(len); let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

// Chain ratchet (Signal sender-key shape): messageKey = HMAC(CK, 0x01),
// nextChainKey = HMAC(CK, 0x02).
function deriveMessageKey(chainKey: Uint8Array): Uint8Array { return hmac(sha256, chainKey, Uint8Array.of(0x01)); }
function nextChainKey(chainKey: Uint8Array): Uint8Array { return hmac(sha256, chainKey, Uint8Array.of(0x02)); }
// AEAD key(32)+nonce(12) from a single-use message key.
function msgKeyMaterial(mk: Uint8Array): { key: Uint8Array; nonce: Uint8Array } {
  const out = hkdf(sha256, mk, new Uint8Array(32), INFO_MSG, 44);
  return { key: out.slice(0, 32), nonce: out.slice(32, 44) };
}

// ── State (JSON-serializable; persisted by the RN layer) ───────────────────────

/** The owner's own sending state for a group (private — never leaves the device). */
export interface OwnSenderKey {
  chainKeyHex: string;
  iteration: number;
  signPrivHex: string;
  signPubHex: string;
}

/** A received sender's state (one per (group, senderId)). */
export interface PeerSenderKey {
  chainKeyHex: string;
  iteration: number;
  signPubHex: string;
  skipped: Record<string, string>; // iteration → messageKey hex (out-of-order cache)
}

/** The Sender Key Distribution Message — handed to each member over pairwise E2EE. */
export interface SenderKeyDistribution {
  chainKeyHex: string;
  iteration: number;
  signPubHex: string;
}

/** An encrypted group message (the SAME object fans out to every member). */
export interface GroupCipher {
  iteration: number;
  ciphertext: string; // base64
  signature: string;  // base64 Ed25519 over (u32(iteration) || ciphertext)
}

// ── API ────────────────────────────────────────────────────────────────────────

/** Create a fresh sender key for a group (call on first send / on rotation). */
export function createSenderKey(): OwnSenderKey {
  const signPriv = ed25519.utils.randomSecretKey();
  return {
    chainKeyHex: bytesToHex(randomBytes(32)),
    iteration: 0,
    signPrivHex: bytesToHex(signPriv),
    signPubHex: bytesToHex(ed25519.getPublicKey(signPriv)),
  };
}

/** The distribution message a member sends (encrypted pairwise) to each other member. */
export function distributionMessage(own: OwnSenderKey): SenderKeyDistribution {
  return { chainKeyHex: own.chainKeyHex, iteration: own.iteration, signPubHex: own.signPubHex };
}

/** Initialise a peer's sender-key record from their distribution message. */
export function processDistribution(skdm: SenderKeyDistribution): PeerSenderKey {
  return {
    chainKeyHex: skdm.chainKeyHex,
    iteration: skdm.iteration,
    signPubHex: skdm.signPubHex,
    skipped: {},
  };
}

/** Encrypt a plaintext with the owner's chain. Returns the cipher + advanced state. */
export function groupEncrypt(own: OwnSenderKey, plaintext: string): { cipher: GroupCipher; next: OwnSenderKey } {
  const ck = hexToBytes(own.chainKeyHex);
  const mk = deriveMessageKey(ck);
  const { key, nonce } = msgKeyMaterial(mk);
  const ad = u32(own.iteration);
  const ct = gcm(key, nonce, ad).encrypt(TE.encode(plaintext));
  const signed = concat(ad, ct);
  const signature = ed25519.sign(signed, hexToBytes(own.signPrivHex));
  return {
    cipher: { iteration: own.iteration, ciphertext: toB64(ct), signature: toB64(signature) },
    next: { ...own, chainKeyHex: bytesToHex(nextChainKey(ck)), iteration: own.iteration + 1 },
  };
}

/**
 * Decrypt a group message against a peer's record. Verifies the signature first,
 * ratchets forward (caching skipped keys for out-of-order delivery), and returns
 * the plaintext plus the advanced record. Throws on a bad signature / wrong key.
 */
export function groupDecrypt(rec: PeerSenderKey, cipher: GroupCipher): { plaintext: string; next: PeerSenderKey } {
  const ct = fromB64(cipher.ciphertext);
  const ad = u32(cipher.iteration);
  // Authenticate the sender BEFORE doing key work.
  if (!ed25519.verify(fromB64(cipher.signature), concat(ad, ct), hexToBytes(rec.signPubHex))) {
    throw new Error('senderKey: signature verification failed');
  }

  const skipped = { ...rec.skipped };
  let mkHex: string | undefined;

  if (cipher.iteration < rec.iteration) {
    // Older than our chain head — must be a cached skipped key.
    mkHex = skipped[String(cipher.iteration)];
    if (!mkHex) throw new Error('senderKey: message key unavailable (too old / already used)');
    delete skipped[String(cipher.iteration)];
    const plaintext = openWith(mkHex, ct, ad);
    return { plaintext, next: { ...rec, skipped } };
  }

  // Ratchet forward from our head to the target, caching the keys we pass.
  if (cipher.iteration - rec.iteration > MAX_SKIP) throw new Error('senderKey: iteration gap too large');
  let ck: Uint8Array = hexToBytes(rec.chainKeyHex);
  let iter = rec.iteration;
  while (iter < cipher.iteration) {
    skipped[String(iter)] = bytesToHex(deriveMessageKey(ck));
    ck = nextChainKey(ck);
    iter++;
  }
  mkHex = bytesToHex(deriveMessageKey(ck));
  const nck = nextChainKey(ck);
  const plaintext = openWith(mkHex, ct, ad);
  // Bound the skipped cache.
  const keys = Object.keys(skipped);
  if (keys.length > MAX_SKIP) for (const k of keys.slice(0, keys.length - MAX_SKIP)) delete skipped[k];
  return { plaintext, next: { chainKeyHex: bytesToHex(nck), iteration: cipher.iteration + 1, signPubHex: rec.signPubHex, skipped } };
}

function openWith(mkHex: string, ct: Uint8Array, ad: Uint8Array): string {
  const { key, nonce } = msgKeyMaterial(hexToBytes(mkHex));
  return TD.decode(gcm(key, nonce, ad).decrypt(ct)); // throws on auth failure
}
