// components/fileviewer/fileTypes.ts — what kind of file app/file-viewer.tsx
// is looking at, and how to name it to a person. PURE (no react-native import):
// fileTypes.selftest.ts runs it under Node.

export type FileKind = 'image' | 'video' | 'audio' | 'pdf' | 'office' | 'text' | 'unknown';

// ── File type detection ──────────────────────────────────────────
const EXT_MAP: Record<string, FileKind> = {};
['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'svg'].forEach(e => (EXT_MAP[e] = 'image'));
['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v'].forEach(e => (EXT_MAP[e] = 'video'));
['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'wma'].forEach(e => (EXT_MAP[e] = 'audio'));
['pdf'].forEach(e => (EXT_MAP[e] = 'pdf'));
['ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx'].forEach(e => (EXT_MAP[e] = 'office'));
// tsv and conf are in lib/docOpen.ts's DOCUMENT list, which routes them HERE.
// They were missing from this map, so detectType returned 'unknown' and a file
// the router had just promised to render showed the hand-off card instead —
// exactly the mismatch docOpen's "extend BOTH or neither" note warns about.
['txt', 'json', 'js', 'jsx', 'ts', 'tsx', 'py', 'md', 'csv', 'tsv', 'xml', 'html', 'css', 'sql', 'sh', 'yaml', 'yml', 'toml', 'ini', 'conf', 'log', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'swift', 'kt', 'dart', 'php'].forEach(e => (EXT_MAP[e] = 'text'));

/**
 * MIME for the Android VIEW intent, derived from the extension.
 *
 * An intent carrying a content:// URI and NO type resolves to no activity on
 * most devices: Android matches on the type, not the file name. The hand-off
 * then does nothing at all — no chooser, no error, no crash — which is exactly
 * how "open in another app" appeared broken.
 *
 * The caller does not reliably supply one. Chat bubbles pass whatever mime the
 * attachment row carried, and for anything sent before that was recorded (or
 * sent by a client that never set it) that is empty. Guessing from the
 * extension is what every file manager does, and it costs one lookup.
 */
const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', csv: 'text/csv', json: 'application/json',
  xml: 'application/xml', html: 'text/html', md: 'text/markdown',
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', heic: 'image/heic', svg: 'image/svg+xml',
  mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg',
};

/** The caller's mime if it gave one, else guessed from the name. */
export function resolveMime(filename: string, mimeType?: string): string | undefined {
  if (mimeType) return mimeType;
  const ext = (filename.split('.').pop() || '').toLowerCase();
  // Last resort: */* still shows a chooser, which beats silently doing nothing.
  return MIME_BY_EXT[ext] ?? (ext ? '*/*' : undefined);
}

export function detectType(filename: string, mimeType?: string): FileKind {
  if (mimeType) {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType === 'application/pdf') return 'pdf';
    if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return 'office';
    if (mimeType.includes('document') || mimeType.includes('word')) return 'office';
    if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return 'office';
    if (mimeType.startsWith('text/')) return 'text';
  }
  const ext = (filename || '').split('.').pop()?.toLowerCase() || '';
  return EXT_MAP[ext] || 'unknown';
}

// ── Helpers ──────────────────────────────────────────────────────
export function formatBytes(b: number): string {
  if (!b || b <= 0) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}

export function formatDuration(ms: number): string {
  if (!ms) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec < 10 ? '0' : ''}${sec}`;
}

const FILE_ICONS: Record<FileKind, string> = {
  image: '🖼️', video: '🎬', audio: '🎵', pdf: '📄',
  office: '📊', text: '📝', unknown: '📎',
};

/**
 * What the USER calls this file, and an icon that matches it.
 *
 * `fileType` above is an internal bucket for choosing a renderer — 'office'
 * covers Word, Excel and PowerPoint alike. Printing it raw put "36.1 KB · OFFICE"
 * under a Word document and gave all three the same bar-chart icon, so a report
 * and a spreadsheet were indistinguishable at a glance. The bucket is right for
 * picking code paths and wrong for showing a person.
 *
 * Keyed by extension because that is what actually determines the format; the
 * bucket is the fallback for everything with no specific name.
 */
const FORMAT: Record<string, { label: string; icon: string }> = {
  docx: { label: 'Word',       icon: '📘' },
  doc:  { label: 'Word',       icon: '📘' },
  xlsx: { label: 'Excel',      icon: '📗' },
  xls:  { label: 'Excel',      icon: '📗' },
  csv:  { label: 'CSV',        icon: '📗' },
  pptx: { label: 'PowerPoint', icon: '📙' },
  ppt:  { label: 'PowerPoint', icon: '📙' },
  pdf:  { label: 'PDF',        icon: '📕' },
};

export function formatOf(filename: string, fileType: FileKind): { label: string; icon: string } {
  const ext = (filename || '').split('.').pop()?.toLowerCase() || '';
  return FORMAT[ext] ?? {
    label: (ext || fileType).toUpperCase(),
    icon: FILE_ICONS[fileType] ?? '📎',
  };
}

export default {};
