// lib/docOpen.ts — ONE way to turn an attachment into an open document.
//
// WHY THIS EXISTS
// ---------------
// Three screens each resolved an attachment their own way, and only one of them
// was right:
//
//   components/chat/MessageBubble.tsx  getMedia(kind:'file', isMine, encrypted)
//                                      → copyToCache → /file-viewer.   Correct.
//   app/media-gallery.tsx (Files tab)  Linking.openURL(attachmentUrl(id)).
//                                      An https URL handed to the SYSTEM
//                                      BROWSER, which holds no bearer token —
//                                      so the Files tab answered 401, and a
//                                      VaultChat attachment URL left the app.
//                                      For encrypted files it passed a file://
//                                      path to Linking, which Android refuses
//                                      outright (FileUriExposedException).
//   app/media-viewer.tsx (Shelf path)  getMedia(kind: 'image') for EVERY
//                                      non-video attachment, with no `encrypted`
//                                      and no `isMine`. Two consequences:
//                                      a document landed in "VaultChat Images"
//                                      as IMG-<id>.pdf, and — because
//                                      `encrypted` was absent — getMedia could
//                                      not raise MediaKeyMissingError and
//                                      instead downloaded raw CIPHERTEXT into a
//                                      file with a .pdf extension. That is audit
//                                      F-8 re-entering through the shelf.
//
// The resolution logic itself was never the problem; having three copies of it
// was. This module is the one MessageBubble already proved, lifted out so the
// other callers stop inventing their own.
//
// It deliberately does NOT render anything and does NOT own a cache: getMedia
// (lib/mediaStore.ts) remains the single store, with its Sent/ folder for the
// sender's own copy and its decrypt path for E2EE attachments.

// NOT imported at module scope. lib/mediaStore pulls in react-native, and this
// module's routing half is asserted by a Node selftest (docOpen.selftest.ts) —
// the same reason lib/shelf.ts stays react-native-free. The import below is
// resolved when a document is actually opened, which is on a tap, off the
// startup path, and is the pattern app/file-viewer.tsx already uses for
// lib/docText.

/** Where a file of this name belongs. Pure — see docOpen.selftest.ts. */
export type ViewerRoute = '/archive-viewer' | '/file-viewer' | '/media-viewer' | 'handoff';

const ARCHIVE = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'];

/**
 * Documents the in-app viewers can actually render.
 *
 * Kept identical to the list app/file-viewer.tsx dispatches on, because a file
 * routed there that it cannot render shows the hand-off card — a worse outcome
 * than going straight to the OS. Extend BOTH or neither.
 */
const DOCUMENT = [
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'txt', 'json', 'csv', 'tsv', 'md', 'log', 'xml', 'yaml', 'yml', 'ini', 'conf',
  'js', 'ts', 'tsx', 'jsx', 'py', 'java', 'go', 'rs', 'sql', 'html', 'css', 'sh',
];

const MEDIA = [
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic',
  'mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi',
  'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac',
];

export function extOf(filename: string): string {
  // Only an extension the NAME actually carries. `split('.').pop()` on a file
  // called "statement" returns "statement", which then matches nothing and is
  // merely useless — but on "v1.2 report" it returns "2 report", and a stray
  // match there would route a document to the wrong screen.
  const m = /\.([A-Za-z0-9]+)$/.exec(filename || '');
  return m ? m[1].toLowerCase() : '';
}

/**
 * Pick the screen for a file. `mime` is consulted only when the name carries no
 * extension — the extension is what the viewers themselves dispatch on, and a
 * server-declared mime disagreeing with it is exactly the case where trusting
 * the mime sends the file somewhere that cannot read it.
 */
export function viewerRouteFor(filename: string, mime?: string | null): ViewerRoute {
  const ext = extOf(filename);
  if (ext) {
    if (ARCHIVE.includes(ext)) return '/archive-viewer';
    if (DOCUMENT.includes(ext)) return '/file-viewer';
    if (MEDIA.includes(ext)) return '/media-viewer';
    return 'handoff';
  }
  const m = (mime || '').toLowerCase();
  if (!m) return 'handoff';
  if (m === 'application/pdf' || m.startsWith('text/')
      || m.includes('word') || m.includes('document')
      || m.includes('spreadsheet') || m.includes('excel')
      || m.includes('presentation') || m.includes('powerpoint')) return '/file-viewer';
  if (m.startsWith('image/') || m.startsWith('video/') || m.startsWith('audio/')) return '/media-viewer';
  if (m.includes('zip') || m.includes('compressed')) return '/archive-viewer';
  return 'handoff';
}

export interface AttachmentRef {
  attachmentId: string;
  filename: string;
  mime?: string | null;
  /** The signed-in user sent this one. Selects the Sent/ copy, not a download. */
  isMine?: boolean;
  /** meta.encrypted — REQUIRED for E2EE attachments, see the F-8 note above. */
  encrypted?: boolean;
}

/**
 * Resolve an attachment to a file:// path the viewers can open, going through
 * the persistent media store (download-once, decrypt-once, sender's own copy
 * reused rather than re-fetched).
 *
 * Throws MediaKeyMissingError when the attachment is encrypted and this install
 * holds no key — callers render that as "can't decrypt on this device" rather
 * than showing a corrupt file.
 */
export async function resolveAttachmentFile(
  a: AttachmentRef,
  onProgress?: (pct: number) => void,
): Promise<string> {
  const { getMedia, copyToCache } = await import('./mediaStore');
  const local = await getMedia(a.attachmentId, {
    kind: 'file',
    isMine: a.isMine,
    mime: a.mime ?? undefined,
    filename: a.filename,
    encrypted: a.encrypted,
    onProgress,
  });
  // The OS FileProvider is configured over the cache directory, so a hand-off
  // (and Android's own PDF/Office apps) can only be given a file that lives
  // there. Harmless for the in-app viewers, which read either path.
  return copyToCache(local, a.filename || `file-${a.attachmentId}`, a.attachmentId);
}

export default { viewerRouteFor, resolveAttachmentFile, extOf };
