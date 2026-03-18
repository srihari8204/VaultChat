// constants/vaultID.ts — Blockchain VaultID System
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ethers } from 'ethers';

export interface VaultID {
  vaultTag: string;        // @username like @vault_abc123
  publicKey: string;       // blockchain public key
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

// Generate a new VaultID — no phone number needed!
export const generateVaultID = async (displayName: string, avatar: string, bio: string): Promise<VaultID> => {
  // Create real ethereum wallet (blockchain keypair)
  const wallet = ethers.Wallet.createRandom();

  // Generate unique VaultTag
  const randomBytes = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    wallet.address + Date.now().toString()
  );
  const vaultTag = '@vault_' + randomBytes.substring(0, 8).toLowerCase();

  // Hash the private key for verification (never store plain)
  const privateKeyHash = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    wallet.privateKey
  );

  // Store private key in secure enclave
  await SecureStore.setItemAsync(PRIVATE_KEY_SECURE, wallet.privateKey);

  const vaultID: VaultID = {
    vaultTag,
    publicKey: wallet.publicKey,
    privateKeyHash,
    walletAddress: wallet.address,
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

// Delete VaultID (MemoryShield — complete destruction)
export const destroyVaultID = async (): Promise<void> => {
  await AsyncStorage.removeItem(VAULT_ID_KEY);
  await SecureStore.deleteItemAsync(PRIVATE_KEY_SECURE);
};

// Sign a message with private key (proves identity on blockchain)
export const signMessage = async (message: string): Promise<string> => {
  const privateKey = await SecureStore.getItemAsync(PRIVATE_KEY_SECURE);
  if (!privateKey) throw new Error('No private key found');
  const wallet = new ethers.Wallet(privateKey);
  return await wallet.signMessage(message);
};

// Verify a signed message
export const verifySignature = (message: string, signature: string, expectedAddress: string): boolean => {
  try {
    const recovered = ethers.verifyMessage(message, signature);
    return recovered.toLowerCase() === expectedAddress.toLowerCase();
  } catch { return false; }
};

// Generate blockchain certificate (proof of identity)
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
