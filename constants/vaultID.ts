// constants/vaultID.ts — Cryptographic VaultID (Ethereum-format keypair, stored locally in SecureStore; real ECDSA signing, NOT registered on any blockchain)
//
// WHY NOT ethers (2026-09-18): this file was the only importer of `ethers` in
// the app, and it used four surfaces of it — Wallet.createRandom, new Wallet,
// wallet.signMessage, verifyMessage. The `ethers` barrel drags its providers,
// contract and ABI layers in with them: ~874KB of source in the Metro graph for
// key generation, EIP-191 signing and signature recovery. @noble/curves and
// @noble/hashes are already bundled (lib/decentralizedId.ts, lib/chatLock.ts,
// lib/localDb.ts, …) and are what ethers itself calls underneath, so the three
// primitives below are written against them directly and cost nothing new.
//
// The formats are byte-identical to ethers, not merely compatible — signatures,
// EIP-55 checksummed addresses and compressed public keys are all checked
// against ethers itself over 200 random keys in vaultID.selftest.ts. That
// matters because identities already on devices must keep verifying: the
// private key in SecureStore is a raw 32-byte key either way, and a signature
// made by an old build must still recover to the same address on a new one.
//
// ONE deliberate behaviour change: ethers' Wallet.createRandom() derived the key
// from a BIP-39 mnemonic (m/44'/60'/0'/0/0). Nothing in this repo ever read that
// mnemonic — it was not stored, shown or exported — so the key is now 32 random
// bytes directly. Existing keys are unaffected; only new ones take this path.
import 'react-native-get-random-values';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

// ── Ethereum primitives (EIP-55 addresses, EIP-191 "personal_sign") ──
// Kept here rather than in a lib/ module because this file is their only user;
// if a second one appears, move them out then.

// EIP-55: a hex digit of keccak(lowercase address) >= 8 means uppercase that
// nibble. Without it the address would still be valid but would not match the
// string ethers produced, and old records compare as strings.
const toChecksumAddress = (lowerHex40: string): string => {
  const h = bytesToHex(keccak_256(utf8ToBytes(lowerHex40)));
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? lowerHex40[i].toUpperCase() : lowerHex40[i];
  return out;
};

// Address = last 20 bytes of keccak256 over the uncompressed public key with
// its 0x04 prefix removed.
const addressFromPublicKey = (uncompressed: Uint8Array): string =>
  toChecksumAddress(bytesToHex(keccak_256(uncompressed.subarray(1)).subarray(12)));

// EIP-191 personal_sign preimage. The length is the BYTE length, not the
// character count — they differ for anything non-ASCII, and a certificate
// payload can contain one.
const hashMessage = (message: string): Uint8Array => {
  const body = utf8ToBytes(message);
  const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${body.length}`);
  const buf = new Uint8Array(prefix.length + body.length);
  buf.set(prefix, 0);
  buf.set(body, prefix.length);
  return keccak_256(buf);
};

const normalizeKey = (privateKey: string): Uint8Array => hexToBytes(privateKey.replace(/^0x/, ''));

// Returns ethers' 65-byte layout: r || s || v, v = 27 + recovery id. noble's
// 'recovered' format puts the recovery byte FIRST, so it is moved, not dropped.
// Signing is RFC-6979 deterministic with canonical low-s (noble's default),
// which is what makes the bytes match ethers exactly.
const signHash = (privateKey: string, message: string): string => {
  const sig = secp256k1.sign(hashMessage(message), normalizeKey(privateKey), {
    prehash: false,
    format: 'recovered',
  });
  return `0x${bytesToHex(sig.subarray(1))}${(27 + sig[0]).toString(16).padStart(2, '0')}`;
};

const recoverAddress = (message: string, signature: string): string => {
  const raw = hexToBytes(signature.replace(/^0x/, ''));
  if (raw.length !== 65) throw new Error('bad signature length');
  const v = raw[64] < 27 ? raw[64] + 27 : raw[64];
  if (v !== 27 && v !== 28) throw new Error('bad recovery id');
  const recovered = new Uint8Array(65);
  recovered[0] = v - 27;
  recovered.set(raw.subarray(0, 64), 1);
  const compressed = secp256k1.recoverPublicKey(recovered, hashMessage(message), { prehash: false });
  return addressFromPublicKey(secp256k1.Point.fromBytes(compressed).toBytes(false));
};

export interface VaultID {
  vaultTag: string;        // @username like @vault_abc123
  publicKey: string;       // public key (Ethereum-format)
  privateKeyHash: string;  // hashed private key (never stored plain)
  walletAddress: string;   // ethereum-style address
  createdAt: number;
  avatar: string;          // emoji avatar
  displayName: string;
  trustScore: number;      // 0-100
  isVerified: boolean;
  bio: string;
}

const VAULT_ID_KEY = 'vaultchat_vault_id';
const PRIVATE_KEY_SECURE = 'vaultchat_private_key';

// Generate a new VaultID � no phone number needed!
export const generateVaultID = async (displayName: string, avatar: string, bio: string): Promise<VaultID> => {
  // Create real ethereum keypair (Ethereum-format, local, not on-chain).
  // randomSecretKey() rejects out-of-range scalars, so the key is always valid.
  const secret = secp256k1.utils.randomSecretKey();
  const privateKey = `0x${bytesToHex(secret)}`;
  // Compressed (33 bytes, 0x02/0x03) — the same form ethers' wallet.publicKey
  // returned, so a VaultID shared by QR still parses on older builds.
  const publicKey = `0x${bytesToHex(secp256k1.getPublicKey(secret, true))}`;
  const walletAddress = addressFromPublicKey(secp256k1.getPublicKey(secret, false));

  // Generate unique VaultTag
  const randomBytes = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    walletAddress + Date.now().toString()
  );
  const vaultTag = '@vault_' + randomBytes.substring(0, 8).toLowerCase();

  // Hash the private key for verification (never store plain)
  const privateKeyHash = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    privateKey
  );

  // Store private key in secure enclave
  await SecureStore.setItemAsync(PRIVATE_KEY_SECURE, privateKey);

  const vaultID: VaultID = {
    vaultTag,
    publicKey,
    privateKeyHash,
    walletAddress,
    createdAt: Date.now(),
    avatar,
    displayName,
    trustScore: 50,
    isVerified: false,
    bio,
  };

  await AsyncStorage.setItem(VAULT_ID_KEY, JSON.stringify(vaultID));
  return vaultID;
};

// Load existing VaultID
export const loadVaultID = async (): Promise<VaultID | null> => {
  const data = await AsyncStorage.getItem(VAULT_ID_KEY);
  return data ? JSON.parse(data) : null;
};

// Save updated VaultID
export const saveVaultID = async (vaultID: VaultID): Promise<void> => {
  await AsyncStorage.setItem(VAULT_ID_KEY, JSON.stringify(vaultID));
};

// Delete VaultID — removes the stored identity and its private key.
export const destroyVaultID = async (): Promise<void> => {
  await AsyncStorage.removeItem(VAULT_ID_KEY);
  await SecureStore.deleteItemAsync(PRIVATE_KEY_SECURE);
};

// Sign a message with private key (proves key ownership (off-chain))
export const signMessage = async (message: string): Promise<string> => {
  const privateKey = await SecureStore.getItemAsync(PRIVATE_KEY_SECURE);
  if (!privateKey) throw new Error('No private key found');
  return signHash(privateKey, message);
};

// Verify a signed message
export const verifySignature = (message: string, signature: string, expectedAddress: string): boolean => {
  try {
    const recovered = recoverAddress(message, signature);
    return recovered.toLowerCase() === expectedAddress.toLowerCase();
  } catch { return false; }
};

// Generate signed identity certificate (proof of identity)
export const generateIdentityCertificate = async (vaultID: VaultID): Promise<string> => {
  const payload = JSON.stringify({
    vaultTag: vaultID.vaultTag,
    walletAddress: vaultID.walletAddress,
    publicKey: vaultID.publicKey,
    createdAt: vaultID.createdAt,
    timestamp: Date.now(),
  });
  const signature = await signMessage(payload);
  return Buffer.from(JSON.stringify({ payload, signature })).toString('base64');
};

// Update trust score
export const updateTrustScore = async (delta: number): Promise<number> => {
  const vaultID = await loadVaultID();
  if (!vaultID) return 0;
  vaultID.trustScore = Math.max(0, Math.min(100, vaultID.trustScore + delta));
  await saveVaultID(vaultID);
  return vaultID.trustScore;
};

// Format wallet address for display
export const shortAddress = (address: string): string => {
  return address.substring(0, 6) + '...' + address.substring(address.length - 4);
};

// Generate QR data for sharing VaultID
export const getShareableVaultID = (vaultID: VaultID): string => {
  return JSON.stringify({
    vaultTag: vaultID.vaultTag,
    walletAddress: vaultID.walletAddress,
    publicKey: vaultID.publicKey,
    displayName: vaultID.displayName,
    avatar: vaultID.avatar,
    trustScore: vaultID.trustScore,
    isVerified: vaultID.isVerified,
  });
};
