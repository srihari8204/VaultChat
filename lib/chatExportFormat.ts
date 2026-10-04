// lib/chatExportFormat.ts — pure rules for building a chat export.
//
// Kept free of React Native / storage imports so lib/chatExportFormat.selftest.ts
// can run them under plain Node.

export interface HistoryMsg {
  id: number;
  type: string;
  content: string | null;
  deletedAt?: string | null;
  meta?: { viewOnce?: boolean; invisibleInk?: boolean } | null;
}

/** One line of export text for a message. Never emits ciphertext. */
export function exportBody(m: HistoryMsg, isCipher: (s: string) => boolean): string {
  if (m.deletedAt) return '[deleted]';
  // View-once and Invisible Ink are seen in place only: Forward and Copy refuse
  // them, so a shared export file must not carry their text either.
  if (m.meta?.viewOnce || m.meta?.invisibleInk) return '[Protected message]';
  const c = m.content && isCipher(m.content) ? null : m.content;
  if (m.content && c == null) return '[Encrypted message — not readable on this device]';
  switch (m.type) {
    case 'text': return c || '';
    case 'image': return '[Image]' + (c ? ' ' + c : '');
    case 'video': return '[Video]' + (c ? ' ' + c : '');
    case 'audio': return '[Voice message]';
    case 'file': return '[File]' + (c ? ' ' + c : '');
    case 'location': return '[Location]';
    case 'sticker': return '[Sticker ' + (c || '') + ']';
    case 'poll': return '[Poll] ' + (c || '');
    default: return '[' + m.type + ']';
  }
}
