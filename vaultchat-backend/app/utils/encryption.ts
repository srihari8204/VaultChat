
import QuickCrypto from 'react-native-quick-crypto';

// ── Key derivation ────────────────────────────────────────────────
// Derives a 256-bit AES key from a VaultID + shared secret using PBKDF2
export async function deriveKey(vaultId: string, secret: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    QuickCrypto.pbkdf2(
      vaultId + secret,          // password
      'VaultChat-Salt-2025',     // salt
      100000,                    // iterations
      32,                        // keylen (256 bits)
      'sha256',                  // digest
      (err: any, key: Buffer) => {
        if (err) reject(err);
        else resolve(key);
      }
    );
  });
}

// ── AES-256-GCM encrypt ───────────────────────────────────────────
// Returns base64 string: IV(12) + AuthTag(16) + Ciphertext
export function encryptMessage(plaintext: string, key: Buffer): string {
  // Generate random 12-byte IV
  const iv = QuickCrypto.randomBytes(12);

  // Create cipher
  const cipher = QuickCrypto.createCipheriv('aes-256-gcm', key, iv);

  // Encrypt
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8') as Buffer,
    cipher.final() as Buffer,
  ]);

  // Get auth tag (16 bytes — prevents tampering)
  const authTag = (cipher as any).getAuthTag();

  // Combine: IV + AuthTag + Ciphertext → base64
  const combined = Buffer.concat([iv, authTag, encrypted]);
  return combined.toString('base64');
}

// ── AES-256-GCM decrypt ───────────────────────────────────────────
export function decryptMessage(encryptedBase64: string, key: Buffer): string {
  const combined = Buffer.from(encryptedBase64, 'base64');

  // Extract components
  const iv       = combined.slice(0, 12);
  const authTag  = combined.slice(12, 28);
  const ciphertext = combined.slice(28);

  // Create decipher
  const decipher = QuickCrypto.createDecipheriv('aes-256-gcm', key, iv);
  (decipher as any).setAuthTag(authTag);

  // Decrypt
  const decrypted = Buffer.concat([
    decipher.update(ciphertext) as Buffer,
    decipher.final() as Buffer,
  ]);

  return decrypted.toString('utf8');
}

// ── ECDH key exchange ─────────────────────────────────────────────
// Each user generates an ECDH keypair on first install
// Public keys are exchanged via server, private keys never leave device
export function generateKeyPair(): { publicKey: string; privateKey: string } {
  const ecdh = QuickCrypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey:  ecdh.getPublicKey('base64') as string,
    privateKey: ecdh.getPrivateKey('base64') as string,
  };
}

// Compute shared secret from your private key + their public key
export function computeSharedSecret(
  myPrivateKeyBase64: string,
  theirPublicKeyBase64: string
): Buffer {
  const ecdh = QuickCrypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(myPrivateKeyBase64, 'base64'));
  return ecdh.computeSecret(
    Buffer.from(theirPublicKeyBase64, 'base64')
  ) as Buffer;
}

// ── Vault file encryption ─────────────────────────────────────────
// Encrypts the full .vault backup payload
export function encryptVaultFile(jsonData: object, vaultId: string): string {
  const key       = QuickCrypto.randomBytes(32); // ephemeral key
  const iv        = QuickCrypto.randomBytes(12);
  const plaintext = JSON.stringify(jsonData);
  const cipher    = QuickCrypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8') as Buffer,
    cipher.final() as Buffer,
  ]);
  const authTag = (cipher as any).getAuthTag();

  return JSON.stringify({
    header:  'VAULTCHAT_BACKUP_v2_AES256GCM',
    vaultId,
    iv:      iv.toString('base64'),
    authTag: authTag.toString('base64'),
    key:     key.toString('base64'), // in prod: encrypt key with VaultID-derived key
    data:    encrypted.toString('base64'),
    ts:      Date.now(),
  });
}

export function decryptVaultFile(raw: string, vaultId: string): object {
  const obj = JSON.parse(raw);
  if (obj.header !== 'VAULTCHAT_BACKUP_v2_AES256GCM') throw new Error('Invalid backup format');
  if (obj.vaultId !== vaultId) throw new Error('VaultID mismatch');

  const key      = Buffer.from(obj.key,     'base64');
  const iv       = Buffer.from(obj.iv,      'base64');
  const authTag  = Buffer.from(obj.authTag, 'base64');
  const ciphered = Buffer.from(obj.data,    'base64');

  const decipher = QuickCrypto.createDecipheriv('aes-256-gcm', key, iv);
  (decipher as any).setAuthTag(authTag);

  const dec = Buffer.concat([
    decipher.update(ciphered) as Buffer,
    decipher.final() as Buffer,
  ]);
  return JSON.parse(dec.toString('utf8'));
}

// ── Random secure token (for VaultID, session tokens) ────────────
export function generateSecureToken(length: number = 32): string {
  return QuickCrypto.randomBytes(length).toString('hex');
}

// ── Hash (SHA-256, for checksums/VaultID anchoring) ──────────────
export function sha256(input: string): string {
  return QuickCrypto.createHash('sha256')
    .update(input)
    .digest('hex') as string;
}
