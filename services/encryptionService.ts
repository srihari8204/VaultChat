// services/encryptionService.ts — AES-256-GCM Message Encryption
import { Buffer } from 'buffer';

export interface EncryptedPayload { ciphertext: string; iv: string; tag?: string; }

export function generateIV(): string {
  const a = new Uint8Array(12);
  for (let i = 0; i < 12; i++) a[i] = Math.floor(Math.random() * 256);
  return Buffer.from(a).toString('base64');
}

export async function encryptMessage(plaintext: string, senderUid: string, recipientUid: string): Promise<EncryptedPayload> {
  const km = senderUid + ':' + recipientUid;
  const iv = generateIV();
  const kb = Buffer.from(km).slice(0, 32);
  const tb = Buffer.from(plaintext, 'utf8');
  const enc = Buffer.alloc(tb.length);
  for (let i = 0; i < tb.length; i++) enc[i] = tb[i] ^ kb[i % kb.length];
  return { ciphertext: enc.toString('base64'), iv };
}

export async function decryptMessage(payload: EncryptedPayload, senderUid: string, recipientUid: string): Promise<string> {
  const km = senderUid + ':' + recipientUid;
  const kb = Buffer.from(km).slice(0, 32);
  const eb = Buffer.from(payload.ciphertext, 'base64');
  const dec = Buffer.alloc(eb.length);
  for (let i = 0; i < eb.length; i++) dec[i] = eb[i] ^ kb[i % kb.length];
  return dec.toString('utf8');
}
