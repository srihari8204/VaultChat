// lib/notesAttachments.ts — encrypted file attachments for Encrypted Notes.
//
// Each attachment's bytes are sealed with the notes DEK (lib/notesCrypto) and
// written to <documentDirectory>/note_attachments/<id>.enc as a JSON envelope.
// Nothing is ever written to disk in the clear. Opening decrypts to a temp file
// in the cache directory (which the OS may purge) so an image can be previewed
// or the file handed to the OS share sheet.

import * as FileSystem from 'expo-file-system/legacy';
import { Buffer } from 'buffer';
import { decryptStringToBytes, encryptBytesToString } from './notesCrypto';

const DIR = FileSystem.documentDirectory + 'note_attachments/';

export interface NoteAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;       // plaintext byte length
  createdAt: number;
}

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(DIR, { intermediates: true });
}

function extFor(mime: string, name: string): string {
  const fromName = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  if (fromName) return fromName;
  if (mime.startsWith('image/')) return '.' + mime.slice(6);
  if (mime === 'application/pdf') return '.pdf';
  return '';
}

// Encrypt the file at `srcUri` and store it. Returns its metadata for the note.
export async function addAttachment(srcUri: string, name: string, mime: string): Promise<NoteAttachment> {
  await ensureDir();
  const b64 = await FileSystem.readAsStringAsync(srcUri, { encoding: FileSystem.EncodingType.Base64 });
  const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
  const blob = await encryptBytesToString(bytes);
  const id = `${Date.now()}_${Math.floor(Math.random() * 1e9).toString(36)}`;
  await FileSystem.writeAsStringAsync(DIR + id + '.enc', blob, { encoding: FileSystem.EncodingType.UTF8 });
  return { id, name, mime, size: bytes.length, createdAt: Date.now() };
}

// Decrypt to a temp cache file; returns its uri, or null if it can't be opened.
export async function openAttachment(att: NoteAttachment): Promise<string | null> {
  try {
    const blob = await FileSystem.readAsStringAsync(DIR + att.id + '.enc', { encoding: FileSystem.EncodingType.UTF8 });
    const bytes = await decryptStringToBytes(blob);
    if (!bytes) return null;
    const tmp = FileSystem.cacheDirectory + att.id + extFor(att.mime, att.name);
    await FileSystem.writeAsStringAsync(tmp, Buffer.from(bytes).toString('base64'), { encoding: FileSystem.EncodingType.Base64 });
    return tmp;
  } catch {
    return null;
  }
}

// Best-effort delete of the encrypted file (call when removing an attachment/note).
export async function deleteAttachment(id: string): Promise<void> {
  try { await FileSystem.deleteAsync(DIR + id + '.enc', { idempotent: true }); } catch { /* ignore */ }
}

/** Ids of every stored attachment (names only, nothing is read or decrypted).
 *  Throws when the folder exists but cannot be listed. */
export async function listAttachmentIds(): Promise<string[]> {
  const info = await FileSystem.getInfoAsync(DIR);
  if (!info.exists) return [];
  return (await FileSystem.readDirectoryAsync(DIR)).filter((n) => n.endsWith('.enc')).map((n) => n.slice(0, -4));
}

// ── Backup transfer (lib/notesVault) ────────────────────────────────────────
// Attachments are already sealed on disk, so a backup moves the envelopes
// verbatim. Decrypting to copy them would put every attachment in the clear in
// the export path for no gain whatsoever.

/** Every stored attachment as id -> sealed envelope. */
export async function listAttachmentBlobs(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const info = await FileSystem.getInfoAsync(DIR);
    if (!info.exists) return out;
    for (const name of await FileSystem.readDirectoryAsync(DIR)) {
      if (!name.endsWith('.enc')) continue;
      try {
        out[name.slice(0, -4)] = await FileSystem.readAsStringAsync(DIR + name, { encoding: FileSystem.EncodingType.UTF8 });
      } catch {}
    }
  } catch {}
  return out;
}

/** Write a sealed envelope back under its original id (restore). */
export async function writeAttachmentBlob(id: string, blob: string): Promise<void> {
  if (!/^[A-Za-z0-9_]+$/.test(id)) throw new Error('Bad attachment id'); // no path traversal out of DIR
  await ensureDir();
  await FileSystem.writeAsStringAsync(DIR + id + '.enc', blob, { encoding: FileSystem.EncodingType.UTF8 });
}

export function isImage(att: NoteAttachment): boolean {
  return att.mime.startsWith('image/');
}

export function prettySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
