// components/notes/notesModel.ts — the data model behind app/encrypted-notes.tsx
// (moved out of the screen file in the round-4 split; behaviour unchanged).

import { BRAND_ACCENT } from '../../constants/theme';
import { encryptBytesToString, openSealedBytesStrict } from '../../lib/notesCrypto';
import type { NoteAttachment } from '../../lib/notesAttachments';

// Category and tag colours are NOT theme colours, so they are not tokens: a
// note stores its tag colour as this hex string (`tagColor`), and each category
// keeps one identity hue in both themes. They only ever tint a chip (at 20%
// alpha) or colour short label text, never body text on a fill.
// 9 Categories from PDF
export const CATEGORIES = [
  { key: 'passwords',    icon: '🔑', name: 'Passwords',     color: '#EF4444' },
  { key: 'ideas',        icon: '💡', name: 'Ideas',         color: '#F59E0B' },
  { key: 'personal',     icon: '📝', name: 'Personal',      color: '#3B82F6' },
  { key: 'bank',         icon: '💳', name: 'Bank/Cards',    color: BRAND_ACCENT },
  { key: 'medical',      icon: '🏥', name: 'Medical',       color: '#EC4899' },
  { key: 'documents',    icon: '📁', name: 'Documents',     color: '#8B5CF6' },
  { key: 'recovery',     icon: '🔐', name: 'Recovery Keys', color: BRAND_ACCENT },
  { key: 'bookmarks',    icon: '🔖', name: 'Bookmarks',     color: '#06B6D4' },
  { key: 'custom',       icon: '📂', name: 'Custom',        color: '#6B7280' },
];

export const TAG_COLORS = ['#EF4444', '#F59E0B', BRAND_ACCENT, '#3B82F6', '#8B5CF6', '#EC4899', '#06B6D4', '#6B7280'];
/** The tag colour of a note that never picked one (stored data, see above). */
export const DEFAULT_TAG_COLOR = '#3B82F6';

export interface Note {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string[];
  tagColor?: string;
  isSensitive: boolean;
  isLocked: boolean;     // per-note biometric
  createdAt: number;
  updatedAt: number;
  reminder?: number;     // timestamp
  isDeleted?: boolean;   // soft delete
  deletedAt?: number;
  attachments?: NoteAttachment[]; // encrypted files (lib/notesAttachments)
}

export const STORAGE_KEY = 'vc_encrypted_notes';
export const TRASH_DAYS = 30;
// An unsaved editor draft, sealed under the notes key, kept when the app goes
// to the background so the re-lock does not throw the user's typing away.
export const DRAFT_KEY = 'vc_encrypted_notes_draft';

/** What the editor holds. A Draft is these plus the note being edited. */
export interface EditorFields {
  title: string; content: string; category: string; tags: string[]; tagColor: string;
  sensitive: boolean; locked: boolean; attachments: NoteAttachment[]; reminder?: number;
}
export interface Draft extends EditorFields { editId: string | null }

/** Comparable snapshot of editor fields, to tell whether Cancel would discard anything. */
export const snapshotOf = (f: EditorFields) =>
  JSON.stringify([f.title, f.content, f.category, f.tags, f.tagColor, f.sensitive, f.locked, f.attachments.map(a => a.id), f.reminder]);

export const fieldsOf = (n: Note): EditorFields => ({
  title: n.title, content: n.content, category: n.category, tags: n.tags,
  tagColor: n.tagColor ?? DEFAULT_TAG_COLOR, sensitive: n.isSensitive, locked: n.isLocked,
  attachments: n.attachments ?? [], reminder: n.reminder,
});

export const emptyFields = (category: string): EditorFields => ({
  title: '', content: '', category, tags: [], tagColor: DEFAULT_TAG_COLOR,
  sensitive: false, locked: false, attachments: [], reminder: undefined,
});

export const sealDraft = async (d: Draft) => encryptBytesToString(new TextEncoder().encode(JSON.stringify(d)));
/** The sealed draft, or null when it can never open on this device (the key
 *  here did not seal it, or it is damaged). Throws when the key cannot be read
 *  right now or is missing, so the caller keeps the draft for a later try. */
export async function openDraft(raw: string): Promise<Draft | null> {
  const bytes = await openSealedBytesStrict(raw);
  if (!bytes) return null;
  try { return JSON.parse(new TextDecoder().decode(bytes)) as Draft; } catch { return null; }
}

/** What to tell the user when the server PIN check throws. A 423 is the
 *  server's attempt limit (written, not yet deployed — fixes/R4BE C1); today
 *  every throw is a network or server failure. */
export function pinCheckError(e: any): string {
  if (e?.status === 423) return e?.message || 'Too many attempts. Try again later.';
  return 'Could not verify. Check your connection.';
}
