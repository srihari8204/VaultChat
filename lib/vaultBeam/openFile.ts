// lib/vaultBeam/openFile.ts — hand a finished VaultBeam file to a real app.
//
// # THE DEFECT
//
// A transfer completed, the whole-file SHA-256 passed, and the file was still
// unusable: tapping the bubble ran `Sharing.shareAsync(path)` on
// `file:///data/user/0/<pkg>/files/VaultBeam/<name>`.
//
// Two things wrong with that. Android has refused to pass a `file://` URI for
// app-private storage to another app since API 24 (FileUriExposedException), so
// the call is rejected outright — the user saw "Cannot open". And even when
// sharing succeeds it is the wrong verb: a share sheet asks "send this
// somewhere", while the user asked to WATCH a video. Those are different
// intents and different app lists.
//
// # WHY THERE IS NO NEW FileProvider HERE
//
// `com.vaultchat.app.FileSystemFileProvider` (expo-file-system) already ships in
// the APK, and its `files-path "."` entry covers `files/VaultBeam/` — the
// receiver's copy, which is the only side that needs a provider at all. The
// SENDER's file is now a `content://` URI straight from DocumentPicker
// (copyToCacheDirectory:false, so a 12 GB pick is streamed in place instead of
// duplicated); it already carries its own read grant and is passed through
// untouched.
//
// A second, narrower provider was considered and rejected: it could not reduce
// what the existing one exposes — that entry comes from a library manifest and
// cannot be removed — so it would add a moving part and buy nothing. Note also
// that a FileProvider's declared paths only bound which URIs THIS app may mint;
// no other app can enumerate or request arbitrary files through it, and each
// grant here is read-only and per-URI.
//
// # BOTH ROLES
//
// The sender picked the file and should be able to reopen it; the receiver
// should be able to open what arrived. Same content-URI path for both — the
// only difference is which directory the file sits in, and the provider covers
// both. The sender's copy lives in the CACHE, though, so Android may evict it:
// FILE_MISSING is a normal outcome there, not a bug.
//
// # LARGE FILES
//
// Nothing here reads, copies or encodes the file. The content URI references
// the completed file in place, so a 780 MB video costs exactly one URI.
//
// The pure half (mime + verdict) runs under `npx tsx`; the open itself needs RN.

/** Why an open did not happen. Structured so the UI can say something true. */
export type OpenFailure = 'FILE_MISSING' | 'NO_HANDLER' | 'NOT_READY' | 'UNKNOWN_ERROR';

export interface OpenResult {
  ok: boolean;
  failure?: OpenFailure;
}

/** Extension → MIME. Lowercase keys; the table is the allow-list. */
const MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska',
  webm: 'video/webm', avi: 'video/x-msvideo', '3gp': 'video/3gpp',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', heic: 'image/heic',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  ogg: 'audio/ogg', flac: 'audio/flac',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv',
  json: 'application/json', xml: 'text/xml', html: 'text/html',
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar', gz: 'application/gzip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  apk: 'application/vnd.android.package-archive',
};

/**
 * MIME type for a filename.
 *
 * Derived from the extension only — never from a sender-supplied MIME string.
 * A peer that claims `text/plain` for an APK would otherwise choose which app
 * opens their bytes on someone else's phone. The local filename is already
 * sanitised; the extension is the one fact we control.
 *
 * Unknown ⇒ `application/octet-stream`, which makes Android show a chooser
 * rather than guessing wrong.
 */
export function mimeFor(name: string): string {
  if (typeof name !== 'string') return 'application/octet-stream';
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return 'application/octet-stream';
  const ext = name.slice(dot + 1).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

/**
 * Should this play INSIDE the app rather than being handed to another one?
 *
 * Not merely nicer: the root layout calls preventScreenCaptureAsync(), so
 * FLAG_SECURE covers every screen in this single-Activity app — including the
 * player. A video played in-app cannot be screen-recorded; the moment it goes
 * out through ACTION_VIEW that protection is gone, because the file is then
 * being rendered by someone else's window. For a received file that arrived
 * end-to-end encrypted, handing it straight to a third-party player undoes a
 * good deal of the point.
 *
 * Video only. Images, PDFs and documents keep the external path — there is no
 * in-app viewer for them here, and inventing one would be a bigger change than
 * the request.
 */
export function isVideo(name: string): boolean {
  return mimeFor(name).startsWith('video/');
}

/** `file:///a/b` → `/a/b`. Anything already bare is returned unchanged. */
export function fsPath(p: string): string {
  if (typeof p !== 'string') return '';
  return p.startsWith('file://') ? decodeURIComponent(p.slice(7)) : p;
}

/**
 * May this transfer be opened at all?
 *
 * Opening is a completed-transfer action. A partially received file is a
 * prealloc'd sparse file of the FINAL size with holes where chunks have not
 * landed, so it would open as a plausible-looking but corrupt video — the worst
 * possible failure, because it looks like the transfer lied rather than like it
 * is still running.
 */
export function canOpen(status: string | undefined, path: string | undefined): boolean {
  return (status === 'complete' || status === 'sent') && typeof path === 'string' && path.length > 0;
}

/** User-facing text. Never a native exception string. */
export function messageFor(f: OpenFailure): string {
  switch (f) {
    case 'NO_HANDLER':   return 'No app on this phone can open this file type.';
    case 'FILE_MISSING': return 'This file is no longer available on this device.';
    case 'NOT_READY':    return 'This file is still transferring.';
    default:             return 'Unable to open this file.';
  }
}

/**
 * Open a completed local file in whatever app handles its type.
 *
 * file -> FileProvider content:// -> ACTION_VIEW with read-only grant.
 * Never throws: every path returns a structured result the UI can render.
 */
export async function openLocalFile(path: string, name?: string): Promise<OpenResult> {
  if (!path) return { ok: false, failure: 'FILE_MISSING' };
  try {
    let contentUri: string;

    if (path.startsWith('content://')) {
      // ALREADY a content URI — the sender's picked file, since DocumentPicker
      // now runs with copyToCacheDirectory:false so a 12 GB pick is streamed in
      // place rather than duplicated. It carries its own read grant, so it must
      // NOT be wrapped: `file://content://…` is not a path, and running it
      // through the FileProvider would try to mint a URI for a file we do not
      // own. Also skipped: getInfoAsync, which cannot stat a content URI.
      contentUri = path;
    } else {
      const FileSystem = await import('expo-file-system/legacy');

      // Exists AND non-empty. A zero-byte file means the transfer never wrote.
      const info: any = await FileSystem.getInfoAsync(path).catch(() => null);
      if (!info?.exists || info.isDirectory || (typeof info.size === 'number' && info.size <= 0)) {
        return { ok: false, failure: 'FILE_MISSING' };
      }

      // The FileProvider content:// URI. Requires a file:// input.
      const fileUri = path.startsWith('file://') ? path : `file://${path}`;
      contentUri = await FileSystem.getContentUriAsync(fileUri);
    }

    const IntentLauncher = await import('expo-intent-launcher');
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: contentUri,
      type: mimeFor(name || path),
      flags: 1,                       // FLAG_GRANT_READ_URI_PERMISSION — read only, no write
    });
    return { ok: true };
  } catch (e: any) {
    const m = String(e?.message ?? e ?? '');
    // ActivityNotFoundException is "nothing installed handles this", which is a
    // normal outcome for an exotic extension, not an error worth alarming about.
    if (/ActivityNotFound|No Activity found|no app|resolve/i.test(m)) {
      return { ok: false, failure: 'NO_HANDLER' };
    }
    if (/ENOENT|not exist|No such file/i.test(m)) return { ok: false, failure: 'FILE_MISSING' };
    return { ok: false, failure: 'UNKNOWN_ERROR' };
  }
}

export default { mimeFor, isVideo, fsPath, canOpen, messageFor, openLocalFile };

// ── self-check ────────────────────────────────────────────────────
if (require.main === module) {
  let failures = 0;
  const A = (ok: boolean, what: string): void => {
    if (!ok) { failures++; console.error('  FAIL', what); } else console.log('  ok  ', what);
  };

  console.log('\nVaultBeam open received/sent file\n');

  // ── MIME ─────────────────────────────────────────────────────────
  A(mimeFor('movie.mp4') === 'video/mp4', '1. mp4 → video/mp4');
  A(mimeFor('a.MP4') === 'video/mp4', '2. extension match is case-insensitive');
  A(mimeFor('scan.pdf') === 'application/pdf', '3. pdf → application/pdf');
  A(mimeFor('p.jpg') === 'image/jpeg' && mimeFor('p.jpeg') === 'image/jpeg', '4. jpg/jpeg → image/jpeg');
  A(mimeFor('a.png') === 'image/png', '5. png → image/png');
  A(mimeFor('d.docx') === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '6. docx → its Office type');
  A(mimeFor('a.zip') === 'application/zip', '7. zip → application/zip');
  A(mimeFor('n.txt') === 'text/plain', '8. txt → text/plain');
  for (const n of ['file.qqq', 'noextension', 'trailingdot.', '', '.hidden']) {
    A(mimeFor(n) === 'application/octet-stream', `9. "${n}" → octet-stream (Android shows a chooser)`);
  }
  A(mimeFor(undefined as any) === 'application/octet-stream', '10. a non-string name is safe');
  A(mimeFor('DC (2026) Telugu DVDScr - x264 - AAC - 700MB.mkv') === 'video/x-matroska',
    '11. spaces and punctuation do not defeat extension lookup');

  // The sender must not choose the viewer on the receiver's phone.
  A(mimeFor('payload.apk') === 'application/vnd.android.package-archive',
    '12. mime comes from the local filename only, never a peer-supplied string');

  // ── in-app vs external ───────────────────────────────────────────
  for (const n of ['a.mp4', 'b.MKV', 'c.mov', 'd.webm', 'e.avi', 'f.3gp', 'g.m4v'])
    A(isVideo(n), `12b. ${n} plays in-app (stays under FLAG_SECURE)`);
  for (const n of ['a.jpg', 'b.pdf', 'c.docx', 'd.zip', 'e.mp3', 'f.qqq', 'noext'])
    A(!isVideo(n), `12c. ${n} does NOT claim the video player`);

  // ── path normalisation ───────────────────────────────────────────
  A(fsPath('file:///data/user/0/x/files/VaultBeam/a.mp4') === '/data/user/0/x/files/VaultBeam/a.mp4',
    '13. file:// is stripped');
  A(fsPath('/data/a.mp4') === '/data/a.mp4', '14. a bare path is unchanged');
  A(fsPath('file:///a/my%20file.mp4') === '/a/my file.mp4', '15. percent-encoding is decoded');
  A(fsPath(undefined as any) === '', '16. a non-string path is safe');
  A(fsPath('content://com.android.providers.media/1') === 'content://com.android.providers.media/1',
    '16b. a content:// URI is returned untouched — it is not a filesystem path');

  // ── only a finished transfer may be opened ───────────────────────
  A(canOpen('complete', '/a/b.mp4'), '17. a completed receive can be opened');
  A(canOpen('sent', '/a/b.mp4'), '18. and a completed send, so the SENDER can reopen its file');
  for (const s of ['receiving', 'uploading', 'queued', 'failed', 'cancelled', undefined]) {
    A(!canOpen(s as any, '/a/b.mp4'),
      `19. status "${s}" cannot open — a partial file is sparse and would look corrupt`);
  }
  A(!canOpen('complete', undefined), '20. no path ⇒ nothing to open');
  A(!canOpen('complete', ''), '21. an empty path ⇒ nothing to open');

  // ── user-facing messages ─────────────────────────────────────────
  A(messageFor('NO_HANDLER').includes('No app'), '22. missing-handler message names the real cause');
  A(messageFor('FILE_MISSING').includes('no longer available'), '23. missing-file message is honest');
  A(!/Exception|android\.|at com\./.test(Object.values(['NO_HANDLER', 'FILE_MISSING', 'NOT_READY', 'UNKNOWN_ERROR'] as OpenFailure[]).map(messageFor).join(' ')),
    '24. no native exception text ever reaches the user');

  // NOTE: the "never reads the file / uses the FileProvider" source assertions
  // live in openFileWiring.selftest.ts, NOT here. This module is imported by the
  // app, and Metro cannot tree-shake a `require.main === module` block — so a
  // `require('fs')` in this file is bundled into the APK and fails the release
  // build with "Unable to resolve module fs". Source-scanning belongs in a
  // *.selftest.ts, which nothing imports and Metro therefore never sees.

  console.log(failures === 0
    ? '\nALL OPEN-FILE CHECKS PASSED ✓  (device open still required)\n'
    : `\n${failures} FAILED ✗\n`);
  process.exit(failures === 0 ? 0 : 1);
}
