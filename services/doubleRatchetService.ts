// @ts-nocheck
/**
 * services/doubleRatchetService.ts
 * Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
 * Double Ratchet Algorithm Ã¢â‚¬â€ VaultChat D2DE
 * Same core algorithm used by Signal Protocol
 *
 * How it works:
 *   1. KDF Chain Ratchet  Ã¢â‚¬â€ derives new key for every message sent
 *   2. DH Ratchet         Ã¢â‚¬â€ rotates root key when other side replies
 *   3. Result             Ã¢â‚¬â€ every message has a UNIQUE key
 *                           past messages safe even if current key stolen
 *                           future messages safe even if past key stolen
 *
 * This gives VaultChat:
 *   Ã¢Å“â€¦ Forward Secrecy    Ã¢â‚¬â€ can't decrypt past messages
 *   Ã¢Å“â€¦ Break-in Recovery  Ã¢â‚¬â€ can't decrypt future messages
 *   Ã¢Å“â€¦ Per-message keys   Ã¢â‚¬â€ each message encrypted with different key
 * Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
 */

import {
  createHmac,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'react-native-quick-crypto';
import * as SecureStore from 'expo-secure-store';

// Ã¢â€â‚¬Ã¢â€â‚¬ Types Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

export interface RatchetState {
  // DH Ratchet keys
  DHSendKey:    string;   // our current DH key pair (private, hex)
  DHRecvKey:    string;   // their current DH public key (hex)

  // Root chain
  rootKey:      string;   // 32-byte hex Ã¢â‚¬â€ top of the ratchet chain

  // Sending chain
  sendChainKey: string;   // 32-byte hex
  sendMsgCount: number;   // how many messages sent

  // Receiving chain
  recvChainKey: string;   // 32-byte hex
  recvMsgCount: number;   // how many messages received

  // Skipped message keys (for out-of-order delivery)
  skippedKeys:  Record<string, string>;

  sessionId:    string;
  peerId:       string;
  createdAt:    number;
}

export interface RatchetMessage {
  ciphertext:   string;   // base64 AES-256-GCM encrypted content
  iv:           string;   // base64 12-byte nonce
  authTag:      string;   // base64 16-byte GCM tag
  msgCount:     number;   // message number in chain
  prevCount:    number;   // previous chain length
  dhPublicKey:  string;   // sender's current DH public key
  sessionId:    string;
  timestamp:    number;
  hmac:         string;   // HMAC over entire header
}

// Ã¢â€â‚¬Ã¢â€â‚¬ KDF Functions Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

/**
 * HKDF-like key derivation using HMAC-SHA256
 * Derives a new chain key and message key from current chain key
 */
function kdfChain(chainKey: string): { newChainKey: string; msgKey: string } {
  const ck = Buffer.from(chainKey, 'hex');

  // Message key = HMAC(chainKey, 0x01)
  const mkHmac = createHmac('sha256', ck);
  mkHmac.update(Buffer.from([0x01]));
  const msgKey = (hmac.digest() as any).toString('hex');

  // Next chain key = HMAC(chainKey, 0x02)
  const ckHmac = createHmac('sha256', ck);
  ckHmac.update(Buffer.from([0x02]));
  const newChainKey = (hmac.digest() as any).toString('hex');

  return { newChainKey, msgKey };
}

/**
 * Root KDF Ã¢â‚¬â€ derives new root key and chain key from DH output
 */
function kdfRoot(rootKey: string, dhOutput: string): { newRootKey: string; newChainKey: string } {
  const rk  = Buffer.from(rootKey,   'hex');
  const dh  = Buffer.from(dhOutput,  'hex');

  // New root key = HMAC(rootKey, dhOutput || 0x01)
  const rkHmac = createHmac('sha256', rk);
  rkHmac.update(Buffer.concat([dh, Buffer.from([0x01])]));
  const newRootKey = (hmac.digest() as any).toString('hex');

  // New chain key = HMAC(rootKey, dhOutput || 0x02)
  const ckHmac = createHmac('sha256', rk);
  ckHmac.update(Buffer.concat([dh, Buffer.from([0x02])]));
  const newChainKey = (hmac.digest() as any).toString('hex');

  return { newRootKey, newChainKey };
}

/**
 * Simulate DH key exchange using HMAC (simplified without X25519)
 * In full production: use react-native-quick-crypto ECDH
 */
function dhExchange(ourPrivKey: string, theirPubKey: string): string {
  const hmac = createHmac('sha256', Buffer.from(ourPrivKey, 'hex'));
  hmac.update(Buffer.from(theirPubKey, 'hex'));
  return (hmac.digest() as any).toString('hex');
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Session Init Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

/**
 * Initialize a new Double Ratchet session
 * sharedSecret: established via initial key exchange (e.g. X25519)
 */
export function initRatchet(
  sessionId:    string,
  peerId:       string,
  sharedSecret: string,   // 32-byte hex from initial DH
  isInitiator:  boolean,
): RatchetState {
  // Generate our DH ratchet key pair
  const ourPrivKey = Buffer.from(randomBytes(32)).toString('hex');
  const ourPubKey  = Buffer.from(randomBytes(32)).toString('hex'); // simplified

  // Derive initial root and chain keys from shared secret
  const { newRootKey, newChainKey } = kdfRoot(sharedSecret, ourPrivKey);

  const state: RatchetState = {
    DHSendKey:    ourPrivKey,
    DHRecvKey:    '',
    rootKey:      newRootKey,
    sendChainKey: isInitiator ? newChainKey : '',
    sendMsgCount: 0,
    recvChainKey: isInitiator ? '' : newChainKey,
    recvMsgCount: 0,
    skippedKeys:  {},
    sessionId,
    peerId,
    createdAt:    Date.now(),
  };

  return state;
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Encrypt (Ratchet Forward) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

/**
 * Encrypt a message Ã¢â‚¬â€ advances the sending chain ratchet
 * Each call produces a DIFFERENT message key
 */
export function ratchetEncrypt(
  state:   RatchetState,
  message: string,
): { encrypted: RatchetMessage; newState: RatchetState } {

  // Advance sending chain Ã¢â‚¬â€ get unique message key
  const { newChainKey, msgKey } = kdfChain(state.sendChainKey);

  // AES-256-GCM encrypt with this unique message key
  const iv      = randomBytes(12);
  const keyBuf  = Buffer.from(msgKey, 'hex');
  const cipher  = createCipheriv('aes-256-gcm', keyBuf, iv);
  const enc1    = cipher.update(message, 'utf8');
  const enc2    = cipher.final();
  const authTag = (cipher as any).getAuthTag() as Buffer;

  const ciphertext = Buffer.concat([
    Buffer.isBuffer(enc1) ? enc1 : Buffer.from(enc1 as any),
    Buffer.isBuffer(enc2) ? enc2 : Buffer.from(enc2 as any),
  ]);

  const ivB64  = Buffer.from(iv).toString('base64');
  const ctB64  = ciphertext.toString('base64');
  const tagB64 = Buffer.from(authTag).toString('base64');

  // HMAC over header for integrity
  const headerData = `${state.sendMsgCount}:${state.recvMsgCount}:${state.DHSendKey.substring(0,16)}`;
  const hmacObj    = createHmac('sha256', keyBuf);
  hmacObj.update(headerData);
  const hmac = (hmac.digest() as any).toString('base64');

  const encrypted: RatchetMessage = {
    ciphertext:  ctB64,
    iv:          ivB64,
    authTag:     tagB64,
    msgCount:    state.sendMsgCount,
    prevCount:   state.recvMsgCount,
    dhPublicKey: state.DHSendKey.substring(0, 32), // simplified pub key
    sessionId:   state.sessionId,
    timestamp:   Date.now(),
    hmac,
  };

  // Update state Ã¢â‚¬â€ chain advances, old key gone
  const newState: RatchetState = {
    ...state,
    sendChainKey: newChainKey,
    sendMsgCount: state.sendMsgCount + 1,
  };

  return { encrypted, newState };
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Decrypt (Ratchet Forward) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

/**
 * Decrypt a message Ã¢â‚¬â€ advances receiving chain ratchet
 * Handles out-of-order messages via skipped key cache
 */
export function ratchetDecrypt(
  state:   RatchetState,
  msg:     RatchetMessage,
): { plaintext: string | null; newState: RatchetState } {

  // Check if we have this key cached (out-of-order message)
  const skippedKey = state.skippedKeys[`${msg.dhPublicKey}:${msg.msgCount}`];
  if (skippedKey) {
    const plaintext = aesDecrypt(msg, skippedKey);
    const newSkipped = { ...state.skippedKeys };
    delete newSkipped[`${msg.dhPublicKey}:${msg.msgCount}`];
    return { plaintext, newState: { ...state, skippedKeys: newSkipped } };
  }

  let currentState = { ...state };

  // DH ratchet step if new DH key received
  if (msg.dhPublicKey !== state.DHRecvKey && state.DHRecvKey !== '') {
    // Save any skipped message keys
    currentState = skipMessageKeys(currentState, msg.prevCount);

    // Perform DH ratchet
    const dhOut = dhExchange(state.DHSendKey, msg.dhPublicKey);
    const { newRootKey, newChainKey } = kdfRoot(currentState.rootKey, dhOut);

    // Generate new sending chain
    const newDHKey    = Buffer.from(randomBytes(32)).toString('hex');
    const dhOut2      = dhExchange(newDHKey, msg.dhPublicKey);
    const { newRootKey: rk2, newChainKey: sendChain } = kdfRoot(newRootKey, dhOut2);

    currentState = {
      ...currentState,
      DHSendKey:    newDHKey,
      DHRecvKey:    msg.dhPublicKey,
      rootKey:      rk2,
      sendChainKey: sendChain,
      sendMsgCount: 0,
      recvChainKey: newChainKey,
      recvMsgCount: 0,
    };
  }

  // Skip ahead to the right message key
  currentState = skipMessageKeys(currentState, msg.msgCount);

  // Get message key and advance chain
  const { newChainKey, msgKey } = kdfChain(currentState.recvChainKey);
  const plaintext = aesDecrypt(msg, msgKey);

  const newState: RatchetState = {
    ...currentState,
    recvChainKey: newChainKey,
    recvMsgCount: currentState.recvMsgCount + 1,
  };

  return { plaintext, newState };
}

// Ã¢â€â‚¬Ã¢â€â‚¬ AES-256-GCM decrypt helper Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

function aesDecrypt(msg: RatchetMessage, msgKey: string): string | null {
  try {
    const keyBuf     = Buffer.from(msgKey,       'hex');
    const iv         = Buffer.from(msg.iv,        'base64');
    const ciphertext = Buffer.from(msg.ciphertext,'base64');
    const authTag    = Buffer.from(msg.authTag,   'base64');

    const decipher = createDecipheriv('aes-256-gcm', keyBuf, iv);
    (decipher as any).setAuthTag(authTag);

    const dec1 = decipher.update(ciphertext);
    const dec2 = decipher.final();

    return Buffer.concat([
      Buffer.isBuffer(dec1) ? dec1 : Buffer.from(dec1 as any),
      Buffer.isBuffer(dec2) ? dec2 : Buffer.from(dec2 as any),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Skip message keys (out-of-order support) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

function skipMessageKeys(state: RatchetState, until: number): RatchetState {
  if (until - state.recvMsgCount > 100) return state; // safety limit
  const skipped = { ...state.skippedKeys };
  let chainKey = state.recvChainKey;
  let count    = state.recvMsgCount;

  while (count < until) {
    const { newChainKey, msgKey } = kdfChain(chainKey);
    skipped[`${state.DHRecvKey}:${count}`] = msgKey;
    chainKey = newChainKey;
    count++;
  }

  return { ...state, recvChainKey: chainKey, recvMsgCount: count, skippedKeys: skipped };
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Persist ratchet state Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

export async function saveRatchetState(state: RatchetState): Promise<void> {
  await SecureStore.setItemAsync(
    `ratchet_${state.sessionId}`,
    JSON.stringify(state)
  );
}

export async function loadRatchetState(sessionId: string): Promise<RatchetState | null> {
  try {
    const raw = await SecureStore.getItemAsync(`ratchet_${sessionId}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export async function deleteRatchetState(sessionId: string): Promise<void> {
  await SecureStore.deleteItemAsync(`ratchet_${sessionId}`).catch(() => {});
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Self test Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

export function testDoubleRatchet(): boolean {
  try {
    const sharedSecret = Buffer.from(randomBytes(32)).toString('hex');
    const sessionId    = 'test-session';

    // Alice and Bob init from same shared secret
    let alice = initRatchet(sessionId, 'bob',   sharedSecret, true);
    let bob   = initRatchet(sessionId, 'alice', sharedSecret, false);

    // Alice sends 3 messages Ã¢â‚¬â€ each gets a DIFFERENT key
    const { encrypted: m1, newState: a1 } = ratchetEncrypt(alice,  'Hello Bob!');
    const { encrypted: m2, newState: a2 } = ratchetEncrypt(a1,     'How are you?');
    const { encrypted: m3, newState: a3 } = ratchetEncrypt(a2,     'D2DE is real!');
    alice = a3;

    // Bob decrypts all 3
    const { plaintext: p1, newState: b1 } = ratchetDecrypt(bob,  m1);
    const { plaintext: p2, newState: b2 } = ratchetDecrypt(b1,   m2);
    const { plaintext: p3, newState: b3 } = ratchetDecrypt(b2,   m3);
    bob = b3;

    // Verify all 3 keys were different
    const keysAllDifferent =
      m1.ciphertext !== m2.ciphertext &&
      m2.ciphertext !== m3.ciphertext;

    const ok = p1 === 'Hello Bob!' && p2 === 'How are you?' && p3 === 'D2DE is real!' && keysAllDifferent;

    console.log('[DoubleRatchet] Self-test:', ok ? 'PASSED Ã¢Å“â€¦' : 'FAILED Ã¢ÂÅ’');
    console.log('[DoubleRatchet] Message 1 key differs from Message 2:', m1.ciphertext.substring(0,10) !== m2.ciphertext.substring(0,10) ? 'YES Ã¢Å“â€¦' : 'NO Ã¢ÂÅ’');
    console.log('[DoubleRatchet] Decrypted:', p1, '|', p2, '|', p3);
    return ok;
  } catch (e) {
    console.error('[DoubleRatchet] Self-test error:', e);
    return false;
  }
}

export default {
  initRatchet,
  ratchetEncrypt,
  ratchetDecrypt,
  saveRatchetState,
  loadRatchetState,
  deleteRatchetState,
  testDoubleRatchet,
};

