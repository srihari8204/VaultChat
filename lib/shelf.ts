// lib/shelf.ts — the Bookshelf: every file ever shared, across every chat.
//
// Design: docs/design/screens/17-bookshelf (mobile m17-shelf).
//
// The index is derived from messages already in localDb — no new sync, no
// server change, nothing to keep consistent. A file row IS a message row that
// happens to carry meta.attachmentId, which is why the shelf works offline and
// is exactly as complete as the local cache.
//
// NOT implemented, deliberately: the design shows "Atlas-MSA-Contract.pdf ·
// page 9 of 14" and a reading-progress bar. Documents are handed to the OS
// viewer (app/file-viewer.tsx), so the app never learns a page count or a
// scroll position. Showing a progress bar we cannot populate would be a lie in
// the UI, so those affordances are left out until a real renderer exists.
//
// PURE — no react-native import — so classification and sorting are Node-tested
// (shelf.selftest.ts). The query lives in lib/localDb.ts.

export type ShelfKind = 'document' | 'image' | 'video' | 'audio' | 'archive' | 'code' | 'other';

export interface ShelfFile {
  attachmentId: string;
  chatId: string;
  messageId: number;
  senderId: string | null;
  filename: string;
  mime: string | null;
  size: number;
  /** ISO timestamp of the message that carried it. */
  createdAt: string;
  kind: ShelfKind;
  pinned?: boolean;
}

const EXT: Record<string, ShelfKind> = {};
const put = (kind: ShelfKind, ...exts: string[]) => exts.forEach(e => { EXT[e] = kind; });
put('image', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'svg', 'avif');
put('video', 'mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v', '3gp');
put('audio', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'wma', 'opus');
put('document', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'rtf', 'pages', 'epub');
put('archive', 'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz');
put('code', 'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'rb', 'php',
  'swift', 'kt', 'dart', 'sql', 'html', 'css', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'sh', 'md', 'txt', 'csv', 'log');

/** Classify by mime first (it is what the sender's OS reported), falling back to
 *  the extension. Unknown stays 'other' rather than being guessed into a bucket
 *  the user then cannot find it in. */
export function classify(filename: string | null | undefined, mime?: string | null): ShelfKind {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf') return 'document';
  if (m.includes('word') || m.includes('document') || m.includes('excel') || m.includes('spreadsheet')
    || m.includes('powerpoint') || m.includes('presentation')) return 'document';
  if (m.includes('zip') || m.includes('compressed') || m.includes('x-tar') || m.includes('x-7z')) return 'archive';

  const ext = (filename || '').split('.').pop()?.toLowerCase() || '';
  if (ext && EXT[ext]) return EXT[ext];
  if (m.startsWith('text/')) return 'code';
  return 'other';
}

export type ShelfSort = 'recent' | 'name' | 'size';
export interface ShelfQuery {
  kind?: ShelfKind | 'all';
  search?: string;
  sort?: ShelfSort;
  pinnedFirst?: boolean;
}

/** Filter + sort, pure and total. Pinned files float to the top when asked,
 *  which is what "4 files kept at the top of the shelf" means in the design. */
export function queryShelf(files: ShelfFile[], q: ShelfQuery = {}): ShelfFile[] {
  const { kind = 'all', search = '', sort = 'recent', pinnedFirst = true } = q;
  const needle = search.trim().toLowerCase();

  const out = files.filter(f => {
    if (kind !== 'all' && f.kind !== kind) return false;
    if (needle && !f.filename.toLowerCase().includes(needle)) return false;
    return true;
  });

  out.sort((a, b) => {
    if (pinnedFirst && !!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    switch (sort) {
      case 'name': return a.filename.localeCompare(b.filename);
      case 'size': return b.size - a.size;
      default: {
        const t = Date.parse(b.createdAt) - Date.parse(a.createdAt);
        // Same timestamp (a batch send) → newest message id wins, so the order
        // is stable instead of depending on the sort's implementation.
        return t !== 0 && Number.isFinite(t) ? t : b.messageId - a.messageId;
      }
    }
  });
  return out;
}

/** Per-kind counts for the shelf's filter chips. Always includes every kind, so
 *  a chip can render "0" rather than vanishing as files are filtered. */
export function countsByKind(files: ShelfFile[]): Record<ShelfKind | 'all', number> {
  const base: Record<ShelfKind | 'all', number> = {
    all: files.length, document: 0, image: 0, video: 0, audio: 0, archive: 0, code: 0, other: 0,
  };
  for (const f of files) base[f.kind]++;
  return base;
}

export function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

export default {};
