import 'react-native-get-random-values';
import { Buffer } from 'buffer';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

async function deriveBackupKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc  = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), { name: 'PBKDF2' }, false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations: 200_000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function exportEncryptedBackup(pin: string, onProgress?: (msg: string) => void): Promise<void> {
  const myUid = auth().currentUser!.uid;
  onProgress?.('Loading chats...');

  const chatsSnap = await firestore().collection('chats')
    .where('participants', 'array-contains', myUid).get();

  const backup: Record<string, any> = {
    version: 1, uid: myUid, exportedAt: new Date().toISOString(), chats: {},
  };

  for (const chatDoc of chatsSnap.docs) {
    onProgress?.(`Backing up ${chatDoc.data().name ?? 'chat'}...`);
    const msgs = await firestore().collection('chats').doc(chatDoc.id)
      .collection('messages').orderBy('createdAt', 'asc').get();
    backup.chats[chatDoc.id] = {
      meta: chatDoc.data(),
      messages: msgs.docs.map(m => ({ id: m.id, ...m.data() })),
    };
  }

  onProgress?.('Encrypting...');
  const json      = JSON.stringify(backup);
  const enc       = new TextEncoder();
  const salt      = crypto.getRandomValues(new Uint8Array(16));
  const iv        = crypto.getRandomValues(new Uint8Array(12));
  const key       = await deriveBackupKey(pin, salt);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource, tagLength: 128 },
    key, enc.encode(json)
  );

  const combined = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
  combined.set(salt, 0);
  combined.set(iv, 16);
  combined.set(new Uint8Array(encrypted), 28);

  const b64      = Buffer.from(combined).toString('base64');
  const filename = `vaultchat-backup-${new Date().toISOString().split('T')[0]}.vcbak`;
  const FS       = FileSystem as any;
  const docDir   = (FS.documentDirectory as string) ?? '';
  const path     = `${docDir}${filename}`;

  await FS.writeAsStringAsync(path, b64, { encoding: 'utf8' });

  onProgress?.('Sharing file...');
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(path, { mimeType: 'application/octet-stream', dialogTitle: 'Save VaultChat Backup' });
  }
}

export async function importEncryptedBackup(fileUri: string, pin: string): Promise<Record<string, any>> {
  const FS       = FileSystem as any;
  const b64      = await FS.readAsStringAsync(fileUri, { encoding: 'utf8' });
  const combined = Buffer.from(b64, 'base64');

  const salt       = combined.slice(0, 16);
  const iv         = combined.slice(16, 28);
  const ciphertext = combined.slice(28);
  const key        = await deriveBackupKey(pin, new Uint8Array(salt));

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv) as unknown as BufferSource, tagLength: 128 },
    key, ciphertext
  );
  return JSON.parse(new TextDecoder().decode(decrypted));
}