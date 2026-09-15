// lib/decentralizedId.ts — a real self-custodied identity.
//
// This is NOT a blockchain. It's a W3C `did:key` derived from an Ed25519
// keypair generated on this device. The private key lives in the OS keystore
// (expo-secure-store) and never leaves the device; the public `did:key` is the
// portable identifier anyone can use to verify signatures you produce.
//
// did:key spec: did:key:z<base58btc(0xed01 ‖ ed25519-pubkey)>
//   0xed01 is the unsigned-varint multicodec prefix for "ed25519-pub".

import 'react-native-get-random-values';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';

const PRIV_KEY = 'vc_did_ed25519_priv';   // SecureStore — the secret, hex
const REC_KEY  = 'vc_did_record';          // AsyncStorage — public metadata

export interface DidRecord {
  did:           string;   // did:key:z...
  displayName:   string;
  publicKeyHex:  string;
  fingerprint:   string;   // short human-checkable hash of the pubkey
  createdAt:     number;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58btc(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '';
  for (let i = 0; i < zeros; i++) out += '1';
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

function didKeyFromPub(pub: Uint8Array): string {
  const prefixed = new Uint8Array(2 + pub.length);
  prefixed[0] = 0xed; prefixed[1] = 0x01;     // multicodec ed25519-pub varint
  prefixed.set(pub, 2);
  return 'did:key:z' + base58btc(prefixed);
}

function fingerprintOf(pub: Uint8Array): string {
  const h = bytesToHex(sha256(pub)).slice(0, 16).toUpperCase();
  return h.match(/.{1,4}/g)!.join('-');     // e.g. 9F2A-1C77-...
}

/** Create a brand-new identity. Overwrites any existing one. */
export async function createDid(displayName: string): Promise<DidRecord> {
  const priv = ed25519.utils.randomSecretKey();
  const pub  = ed25519.getPublicKey(priv);
  await SecureStore.setItemAsync(PRIV_KEY, bytesToHex(priv));
  const record: DidRecord = {
    did:          didKeyFromPub(pub),
    displayName:  displayName.trim(),
    publicKeyHex: bytesToHex(pub),
    fingerprint:  fingerprintOf(pub),
    createdAt:    Date.now(),
  };
  await AsyncStorage.setItem(REC_KEY, JSON.stringify(record));
  return record;
}

export async function getDidRecord(): Promise<DidRecord | null> {
  try {
    const raw = await AsyncStorage.getItem(REC_KEY);
    return raw ? JSON.parse(raw) as DidRecord : null;
  } catch { return null; }
}

/**
 * Prove the device still holds the private key for the stored DID by signing a
 * fresh random challenge and verifying it against the public key. Returns true
 * only if the keypair matches the stored identity and its public fingerprint.
 */
export async function proveControl(): Promise<boolean> {
  try {
    const privHex = await SecureStore.getItemAsync(PRIV_KEY);
    if (!privHex) return false;
    const priv = hexToBytes(privHex);
    const pub  = ed25519.getPublicKey(priv);
    const record = await getDidRecord();
    if (!record || typeof record !== 'object' ||
        typeof record.publicKeyHex !== 'string' ||
        !/^[0-9a-fA-F]{64}$/.test(record.publicKeyHex) ||
        record.publicKeyHex.toLowerCase() !== bytesToHex(pub) ||
        record.did !== didKeyFromPub(pub) ||
        record.fingerprint !== fingerprintOf(pub) ||
        typeof record.displayName !== 'string' ||
        !Number.isFinite(record.createdAt) || record.createdAt <= 0) return false;
    const challenge = randomBytes(32);
    const sig = ed25519.sign(challenge, priv);
    return ed25519.verify(sig, challenge, pub);
  } catch { return false; }
}

/** Sign an arbitrary message with the DID's private key (hex signature). */
export async function signWithDid(message: string): Promise<string | null> {
  const privHex = await SecureStore.getItemAsync(PRIV_KEY);
  if (!privHex) return null;
  const sig = ed25519.sign(new TextEncoder().encode(message), hexToBytes(privHex));
  return bytesToHex(sig);
}

export async function revokeDid(): Promise<void> {
  await SecureStore.deleteItemAsync(PRIV_KEY);
  await AsyncStorage.removeItem(REC_KEY);
}

export default {};
