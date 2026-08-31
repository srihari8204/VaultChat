// lib/notesVaultCore.ts — the pure half of the notes vault.
//
// Split from lib/notesVault.ts for the same reason lib/family/leaveNow.ts is
// split from leaveNowAlarm.ts: this half has no React-Native import, so the
// EXACT code that ships runs under tsx in lib/notesVault.selftest.ts. The
// impure half (AsyncStorage, SecureStore, FileSystem) lives in notesVault.
//
// The crypto is services/security/vaultKeys — scrypt + AES-256-GCM, native
// accelerated — rather than a fourth KDF grown for this one feature.

import { Buffer } from 'buffer';
import { deriveVaultKeyAsync, newSalt, seal, open } from '../services/security/vaultKeys';

/** A DEK sealed under a passphrase-derived key. Safe to store or transmit. */
export interface KeyWrap { v: 1; salt: string; wrapped: string }

/** A self-contained export file. Every field is ciphertext. */
export interface NotesBundle {
  v: 1;
  kind: 'vaultchat-notes';
  createdAt: number;
  wrap: KeyWrap;
  /** The sealed notes blob, verbatim from storage. */
  notes: string | null;
  /** attachmentId -> its sealed envelope, verbatim from disk. */
  attachments: Record<string, string>;
}

/**
 * Seal `dekHex` under `passphrase`. A fresh salt every call — two wraps of the
 * same key must never produce the same bytes, or a pair of backups would
 * advertise that they share a key.
 */
export async function makeWrap(passphrase: string, dekHex: string): Promise<KeyWrap> {
  const salt = newSalt();
  const key = await deriveVaultKeyAsync(passphrase, salt);
  return { v: 1, salt: Buffer.from(salt).toString('base64'), wrapped: seal(key, dekHex) };
}

/**
 * Recover the DEK hex from a wrap, or null when the passphrase is wrong. The
 * GCM auth tag decides, so a wrong passphrase cannot yield a plausible-looking
 * key — the same fail-closed property the duress vault relies on.
 */
export async function openWrap(passphrase: string, wrap: KeyWrap): Promise<string | null> {
  if (!isWrap(wrap)) return null;
  const key = await deriveVaultKeyAsync(passphrase, new Uint8Array(Buffer.from(wrap.salt, 'base64')));
  const hex = open(key, wrap.wrapped);
  return hex && /^[0-9a-f]{64}$/i.test(hex) ? hex : null;
}

export function isWrap(o: any): o is KeyWrap {
  return !!o && o.v === 1 && typeof o.salt === 'string' && typeof o.wrapped === 'string';
}

/** True when `o` is a bundle this build can restore. */
export function isBundle(o: any): o is NotesBundle {
  return !!o && typeof o === 'object' && o.kind === 'vaultchat-notes' && o.v === 1 && isWrap(o.wrap)
    && (o.notes === null || typeof o.notes === 'string')
    && !!o.attachments && typeof o.attachments === 'object';
}

/**
 * Drop trashed notes whose recovery window has expired, and report which
 * attachments those notes owned so the caller can delete their files.
 *
 * Pure so the boundary is testable: TRASH_DAYS was declared in the notes screen
 * and never read, which left "30-Day Recovery" recovering forever — deleted
 * notes, and their encrypted attachments, sat on disk for the life of the
 * install.
 */
export function purgeExpired<T extends { isDeleted?: boolean; deletedAt?: number; attachments?: { id: string }[] }>(
  notes: T[], now: number, days = 30,
): { kept: T[]; purgedAttachmentIds: string[] } {
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const kept: T[] = [];
  const purgedAttachmentIds: string[] = [];
  for (const n of notes) {
    // Only a note that is BOTH trashed and stamped can expire. A trashed note
    // with no deletedAt is kept, not silently destroyed on the next launch.
    if (n.isDeleted && typeof n.deletedAt === 'number' && n.deletedAt < cutoff) {
      for (const a of n.attachments ?? []) purgedAttachmentIds.push(a.id);
      continue;
    }
    kept.push(n);
  }
  return { kept, purgedAttachmentIds };
}
