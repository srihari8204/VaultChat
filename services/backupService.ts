// services/backupService.ts
// Export all chat messages as an AES-256-GCM encrypted JSON file
// The encryption password is the user's own PIN â€” server never sees it

import 'react-native-get-random-values';
import { Buffer } from 'buffer';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

// Derive a key from the user's PIN (PBKDF2)
async function deriveBackupKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc  = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), { name: 'PBKDF2' }, false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 200_000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Export all chats + messages to an encrypted file
export async function exportEncryptedBackup(pin: string, onProgress?: (msg: string) => void): Promise<void> {
  const myUid = auth().currentUser!.uid;
  onProgress?.('Loading chatsâ€¦');

  const chatsSnap = await firestore()
    .collection('chats')
    .where('participants', 'array-contains', myUid)
    .get();

  const backup: Record<string, any> = { version: 1, uid: myUid, exportedAt: new Date().toISOString(), chats: {} };

  for (const chatDoc of chatsSnap.docs) {
    onProgress?.(`Backing up ${chatDoc.data().name ?? 'chat'}â€¦`);
    const msgs = await firestore()
      .collection('chats').doc(chatDoc.id)
      .collection('messages').orderBy('createdAt', 'asc').get();
    backup.chats[chatDoc.id] = {
      meta:     chatDoc.data(),
      messages: msgs.docs.map(m => ({ id: m.id, ...m.data() })),
    };
  }

  onProgress?.('Encryptingâ€¦');
  const json      = JSON.stringify(backup);
  const enc       = new TextEncoder();
  const salt      = crypto.getRandomValues(new Uint8Array(16));
  const iv        = crypto.getRandomValues(new Uint8Array(12));
  const key       = await deriveBackupKey(pin, salt);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, enc.encode(json));

  // Pack: salt(16) + iv(12) + ciphertext
  const combined = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
  combined.set(salt, 0);
  combined.set(iv, 16);
  combined.set(new Uint8Array(encrypted), 28);

  const b64      = Buffer.from(combined).toString('base64');
  const filename = `vaultchat-backup-${new Date().toISOString().split('T')[0]}.vcbak`;
  const path     = `${FileSystem.documentDirectory}${filename}`;

  await FileSystem.writeAsStringAsync(path, b64, { encoding: FileSystem.EncodingType.UTF8 });

  onProgress?.('Sharing fileâ€¦');
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(path, { mimeType: 'application/octet-stream', dialogTitle: 'Save VaultChat Backup' });
  }
}

// Import and decrypt a backup file
export async function importEncryptedBackup(fileUri: string, pin: string): Promise<Record<string, any>> {
  const b64      = await FileSystem.readAsStringAsync(fileUri, { encoding: FileSystem.EncodingType.UTF8 });
  const combined = Buffer.from(b64, 'base64');

  const salt       = combined.slice(0, 16);
  const iv         = combined.slice(16, 28);
  const ciphertext = combined.slice(28);

  const key       = await deriveBackupKey(pin, salt);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(decrypted));
}