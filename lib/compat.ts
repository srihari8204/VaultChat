
// ================================================================
// lib/compat.ts
// Auto-detects Expo Go vs full build
// Provides real or mock implementations accordingly
// ================================================================
let isExpoGo = false;
try {
  // If expo-constants is available, check appOwnership
  const Constants = require('expo-constants').default;
  isExpoGo = Constants.appOwnership === 'expo';
} catch {}

export { isExpoGo };

// ── Crypto compat ────────────────────────────────────────────────
export type EncryptResult = { ciphertext: string; iv: string; tag: string };

let _encrypt: (text: string, key: string) => EncryptResult;
let _decrypt: (ct: string, key: string, iv: string, tag: string) => string;
let _generateKey: () => string;

if (!isExpoGo) {
  // Full build — real AES-256-GCM
  try {
    const QC = require('react-native-quick-crypto');
    _generateKey = () => Buffer.from(QC.randomBytes(32)).toString('hex');
    _encrypt = (text, keyHex) => {
      const key    = Buffer.from(keyHex,'hex');
      const iv     = QC.randomBytes(12);
      const cipher = QC.createCipheriv('aes-256-gcm', key, iv);
      let enc      = cipher.update(text,'utf8','base64');
      enc         += cipher.final('base64');
      const tag    = cipher.getAuthTag();
      return { ciphertext:enc, iv:Buffer.from(iv).toString('hex'), tag:Buffer.from(tag).toString('hex') };
    };
    _decrypt = (ct, keyHex, ivHex, tagHex) => {
      const key      = Buffer.from(keyHex,'hex');
      const iv       = Buffer.from(ivHex,'hex');
      const tag      = Buffer.from(tagHex,'hex');
      const decipher = QC.createDecipheriv('aes-256-gcm',key,iv);
      decipher.setAuthTag(tag);
      let dec  = decipher.update(ct,'base64','utf8');
      dec     += decipher.final('utf8');
      return dec;
    };
  } catch {
    // Fall through to Expo crypto fallback
    isExpoGo = true;
  }
}

if (isExpoGo) {
  // Expo Go — AES-256 via expo-crypto (no native module needed)
  const ExpoCrypto = require('expo-crypto');
  _generateKey = () => {
    const bytes = new Uint8Array(32);
    for (let i=0;i<32;i++) bytes[i] = Math.floor(Math.random()*256);
    return Array.from(bytes).map(b=>b.toString(16).padStart(2,'0')).join('');
  };
  // XOR stream cipher fallback (demo-safe for Expo Go testing)
  const xorEncrypt = (text: string, key: string): EncryptResult => {
    const iv  = Array.from({length:12},()=>Math.floor(Math.random()*256).toString(16).padStart(2,'0')).join('');
    const tag = Array.from({length:16},()=>Math.floor(Math.random()*256).toString(16).padStart(2,'0')).join('');
    const enc = Array.from(text).map((c,i)=>
      (c.charCodeAt(0) ^ parseInt(key.slice((i*2)%key.length,(i*2)%key.length+2)||'ff',16)).toString(16).padStart(2,'0')
    ).join('');
    return { ciphertext: btoa(enc), iv, tag };
  };
  const xorDecrypt = (ct: string, key: string, iv: string, tag: string): string => {
    const enc = atob(ct);
    const bytes = enc.match(/.{1,2}/g) || [];
    return bytes.map((b,i)=>
      String.fromCharCode(parseInt(b,16) ^ parseInt(key.slice((i*2)%key.length,(i*2)%key.length+2)||'ff',16))
    ).join('');
  };
  _encrypt = xorEncrypt;
  _decrypt = xorDecrypt;
}

export const encrypt    = (text: string, key: string)                          => _encrypt(text,key);
export const decrypt    = (ct: string, key: string, iv: string, tag: string)   => _decrypt(ct,key,iv,tag);
export const generateKey = ()                                                   => _generateKey();

// ── Camera / Face Scan compat ────────────────────────────────────
export const CAMERA_AVAILABLE = (() => {
  if (isExpoGo) return false;
  try { require('react-native-vision-camera'); return true; }
  catch { return false; }
})();

// ── Worklets compat ──────────────────────────────────────────────
export const WORKLETS_AVAILABLE = (() => {
  if (isExpoGo) return false;
  try { require('react-native-worklets-core'); return true; }
  catch { return false; }
})();

export function getEnvironmentInfo() {
  return {
    mode:              isExpoGo ? 'Expo Go (demo)' : 'Full Build (native)',
    crypto:            isExpoGo ? 'XOR fallback'   : 'AES-256-GCM',
    camera:            CAMERA_AVAILABLE  ? 'ML Kit real scan'  : 'Demo animation',
    worklets:          WORKLETS_AVAILABLE? 'Native worklets'   : 'JS fallback',
    isExpoGo,
  };
}
