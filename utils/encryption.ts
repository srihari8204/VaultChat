/**
 * VaultChat — Real AES-256-GCM Encryption
 * Uses react-native-quick-crypto
 * Hardware-accelerated on device
 * Works ONLY in native build (npx expo run:android)
 */
import crypto from 'react-native-quick-crypto';
import * as SecureStore from 'expo-secure-store';

const KEY_PREFIX = 'vc_key_';

// -- Key generation ------------------------------------------------------------
export const generateKey = (): string => {
  const bytes = crypto.randomBytes(32);
  return Buffer.from(bytes).toString('base64');
};

// -- Key storage (hardware keystore) ------------------------------------------
export const storeKey = async (id: string, key: string): Promise<void> => {
  await SecureStore.setItemAsync(`${KEY_PREFIX}${id}`, key);
};

export const getKey = async (id: string): Promise<string | null> => {
  return SecureStore.getItemAsync(`${KEY_PREFIX}${id}`);
};

export const deleteKey = async (id: string): Promise<void> => {
  await SecureStore.deleteItemAsync(`${KEY_PREFIX}${id}`);
};

// -- Encrypt -------------------------------------------------------------------
export const encryptMessage = (plaintext: string, keyBase64: string): string => {
  try {
    const key = Buffer.from(keyBase64, 'base64');
    const iv  = crypto.randomBytes(12); // 96-bit IV for GCM

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc1   = cipher.update(plaintext, 'utf8', 'base64');
    const enc2   = cipher.final('base64');
    const tag    = (cipher as any).getAuthTag();

    // Format: iv:tag:ciphertext (all base64)
    return [
      Buffer.from(iv).toString('base64'),
      Buffer.from(tag).toString('base64'),
      enc1 + enc2,
    ].join(':');
  } catch (e) {
    console.error('Encrypt error:', e);
    return '';
  }
};

// -- Decrypt -------------------------------------------------------------------
export const decryptMessage = (ciphertext: string, keyBase64: string): string => {
  try {
    const [ivB64, tagB64, encrypted] = ciphertext.split(':');
    const key = Buffer.from(keyBase64, 'base64');
    const iv  = Buffer.from(ivB64,  'base64');
    const tag = Buffer.from(tagB64, 'base64');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    (decipher as any).setAuthTag(tag);

    const dec1 = decipher.update(encrypted, 'base64', 'utf8');
    const dec2 = decipher.final('utf8');
    return dec1 + dec2;
  } catch (e) {
    console.error('Decrypt error:', e);
    return '[Decryption failed]';
  }
};

// -- Hash ----------------------------------------------------------------------
export const sha256 = (input: string): string => {
  return crypto.createHash('sha256').update(input).digest('hex');
};

// -- HMAC ---------------------------------------------------------------------
export const hmac = (message: string, key: string): string => {
  return crypto.createHmac('sha256', key).update(message).digest('hex');
};

// -- Secure wipe (MemoryShield) ------------------------------------------------
export const secureWipe = async (id: string): Promise<void> => {
  const garbage = Buffer.from(crypto.randomBytes(32)).toString('base64');
  await SecureStore.setItemAsync(`${KEY_PREFIX}${id}`, garbage);
  await SecureStore.deleteItemAsync(`${KEY_PREFIX}${id}`);
};
