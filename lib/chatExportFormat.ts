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

// ── File text, one message at a time ─────────────────────────────────
// The export is written to its file in chunks (components/chattools/
// chatExportFile.ts), so the file text is built per message rather than as
// one string for the whole chat.

export interface ExportMsg extends HistoryMsg { createdAt: string; editedAt?: string | null }

export interface ExportLineCtx<M extends ExportMsg> {
  /** "You", the member's name, or the peer name. */
  label: (m: M) => string;
  mine: (m: M) => boolean;
  time: (iso: string) => string;
  body: (m: M) => string;
}

export function escHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function exportTextHead(peerName: string, count: number, exportedAt: string): string {
  return 'crazzychat Export - ' + peerName + '\n'
    + 'Exported: ' + exportedAt + '\n'
    + 'Messages: ' + count + '\n' + '='.repeat(50) + '\n\n';
}

export function exportTextLine<M extends ExportMsg>(m: M, ctx: ExportLineCtx<M>): string {
  return '[' + ctx.time(m.createdAt) + '] ' + ctx.label(m) + ': ' + ctx.body(m) + '\n'
    + (m.editedAt ? '  (edited)\n' : '');
}

/** The exported HTML is a fixed dark document; `accent` is the brand accent hex. */
export function exportHtmlHead(peerName: string, count: number, exportedAt: string, accent: string): string {
  let html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">';
  html += '<title>crazzychat Export</title><style>';
  html += 'body{font-family:-apple-system,Segoe UI,sans-serif;background:#0A0A0F;color:#fff;max-width:600px;margin:0 auto;padding:16px}';
  html += '.header{text-align:center;padding:20px;border-bottom:1px solid #222;margin-bottom:20px}';
  html += `.header h1{color:${accent};margin:0}.header p{color:#888;font-size:12px}`;
  html += '.msg{margin:4px 0;padding:8px 12px;border-radius:14px;max-width:80%;word-wrap:break-word}';
  html += `.mine{background:${accent}22;margin-left:auto;border-bottom-right-radius:2px}`;
  html += '.peer{background:#1a1a22;margin-right:auto;border-bottom-left-radius:2px}';
  html += '.time{color:#666;font-size:10px;margin-top:4px;text-align:right}';
  html += '.sender{color:#06B6D4;font-size:11px;font-weight:700;margin-bottom:2px}';
  html += '.meta{color:#777;font-size:10px;font-style:italic}';
  html += '</style></head><body>';
  html += '<div class="header"><h1>crazzychat</h1><p>Chat with ' + escHtml(peerName) + '</p>';
  html += '<p>' + count + ' messages | Exported ' + exportedAt + '</p></div>';
  return html;
}

export function exportHtmlLine<M extends ExportMsg>(m: M, ctx: ExportLineCtx<M>): string {
  const isMine = ctx.mine(m);
  let html = '<div class="msg ' + (isMine ? 'mine' : 'peer') + '">';
  if (!isMine) html += '<div class="sender">' + escHtml(ctx.label(m)) + '</div>';
  html += '<div>' + escHtml(ctx.body(m)).replace(/\n/g, '<br>') + '</div>';
  html += '<div class="time">' + ctx.time(m.createdAt) + '</div>';
  if (m.editedAt) html += '<div class="meta">(edited)</div>';
  return html + '</div>';
}

export const EXPORT_HTML_TAIL = '</body></html>';
