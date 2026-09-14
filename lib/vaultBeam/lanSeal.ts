// lib/vaultBeam/lanSeal.ts — seal the sender's LAN endpoint.
//
// WHY THIS EXISTS AT ALL
// ----------------------
// The P3 LAN tier advertises `{lanIp, lanPort}` over the vaultbeam_ready
// signalling relay so the receiver can open a TCP socket straight to the
// sender. That went to the server IN THE CLEAR — the sender's device IP — in
// the very same function that carefully buffers ICE candidates until they can
// be sealed (lib/vaultBeamDirect.ts). A device IP is exactly what the ICE
// buffering exists to withhold, so withholding one and volunteering the other
// was not a policy, it was an oversight.
//
// NO NEW KEY AGREEMENT. Both peers already hold the transfer's AES-256 key: it
// travels inside the VaultBeam manifest, which rides the E2EE chat message, so
// the server never sees it. A domain-separated subkey of it seals the endpoint.
// A subkey rather than the key itself because the chunk cipher uses the raw key
// with its own nonce scheme (lib/vaultBeamStreamNative) and two independent
// nonce spaces under one key is how a GCM key gets reused.
//
// PURE AND RN-FREE on purpose — lib/vaultBeamDirect.ts pulls in react-native
// and cannot be loaded under Node, so the crypto that matters lives here where
// lib/vaultBeam/signalSealed.selftest.ts can actually execute it.

import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Buffer } from 'buffer';

const b64ToU8 = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, 'base64'));
const u8ToB64 = (u8: Uint8Array): string => Buffer.from(u8).toString('base64');

const LABEL = new TextEncoder().encode('vaultbeam-lan-v1');

function lanKey(keyB64: string): Uint8Array {
  const k = b64ToU8(keyB64);
  const buf = new Uint8Array(k.length + LABEL.length);
  buf.set(k, 0);
  buf.set(LABEL, k.length);
  return sha256(buf);
}

/** Seal `{lanIp, lanPort}` for the peer. Returns `"<b64 iv>.<b64 ct>"`. */
export function sealLan(keyB64: string, obj: unknown): string {
  const iv = randomBytes(12);
  const ct = gcm(lanKey(keyB64), iv).encrypt(new TextEncoder().encode(JSON.stringify(obj)));
  return `${u8ToB64(iv)}.${u8ToB64(ct)}`;
}

/** Open a sealed endpoint; null for anything we cannot authenticate. */
export function openLan(keyB64: string, wire: unknown): any | null {
  try {
    const [iv, ct] = String(wire).split('.');
    if (!iv || !ct) return null;
    return JSON.parse(new TextDecoder().decode(gcm(lanKey(keyB64), b64ToU8(iv)).decrypt(b64ToU8(ct))));
  } catch { return null; }
}

export default { sealLan, openLan };
