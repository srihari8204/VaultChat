// components/notes/useNoteEditor.ts — the note editor's field state for
// app/encrypted-notes.tsx (moved out of the screen in the round-4 split).

import { useState } from 'react';
import type { NoteAttachment } from '../../lib/notesAttachments';
import { DEFAULT_TAG_COLOR, type EditorFields } from './notesModel';

export function useNoteEditor() {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [category, setCategory] = useState('personal');
  const [tags, setTags] = useState<string[]>([]);
  const [tagColor, setTagColor] = useState(DEFAULT_TAG_COLOR);
  const [sensitive, setSensitive] = useState(false);
  const [locked, setLocked] = useState(false);
  const [attachments, setAttachments] = useState<NoteAttachment[]>([]);
  const [reminder, setReminder] = useState<number | undefined>(undefined);
  const [preview, setPreview] = useState(false);
  const [sel, setSel] = useState({ start: 0, end: 0 });

  const fields: EditorFields = { title, content, category, tags, tagColor, sensitive, locked, attachments, reminder };

  /** Fill every field (opening a note, a new note, or a restored draft). */
  const load = (f: EditorFields) => {
    setTitle(f.title); setContent(f.content); setCategory(f.category);
    setTags(f.tags); setTagColor(f.tagColor); setSensitive(f.sensitive);
    setLocked(f.locked); setAttachments(f.attachments); setReminder(f.reminder);
  };

  // ── Markdown formatting (#142) ────────────────────────────────────────────
  // Wrap the current selection (or insert at the cursor) with markdown markers.
  const wrapSelection = (before: string, after: string) => {
    const { start, end } = sel;
    const s0 = Math.max(0, Math.min(start, content.length));
    const s1 = Math.max(s0, Math.min(end, content.length));
    const selected = content.slice(s0, s1) || 'text';
    setContent(content.slice(0, s0) + before + selected + after + content.slice(s1));
  };
  // Prefix the line containing the selection start (headings, lists, quotes).
  const prefixLine = (prefix: string) => {
    const { start } = sel;
    const lineStart = content.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    setContent(content.slice(0, lineStart) + prefix + content.slice(lineStart));
  };

  return {
    fields, load,
    setTitle, setContent, setCategory, setTags, setTagColor, setSensitive, setLocked,
    setAttachments, setReminder, preview, setPreview, setSel, wrapSelection, prefixLine,
  };
}

export type NoteEditor = ReturnType<typeof useNoteEditor>;
