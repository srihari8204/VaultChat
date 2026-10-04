// components/chattools/chatExportFile.ts — write a chat export to a temporary
// file in chunks, and hand it to the share sheet.
//
// The export used to be built as ONE string (up to 100k messages) and then
// written; that string, the raw list and the decrypted list sat in memory
// together. Here chunks arrive one at a time, each is decrypted (`prepare`) and
// its lines appended as it is built, so only one chunk exists at a time, and a
// cancelled export stops between chunks (and after each decrypt) and removes
// its file.

import * as RNFS from '@dr.pogodin/react-native-fs';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Share } from 'react-native';

// Exports are written into their own cache folder, so a sweep can remove every
// leftover without guessing at names.
const EXPORT_DIR = `${RNFS.CachesDirectoryPath}/chat-export`;
const LEGACY_PREFIX = 'crazzychat_';   // older builds wrote to the cache root

/**
 * Remove plaintext export files a crash or a killed app left behind (a thrown
 * error already removes its own; a process death does not). Call it when no
 * export is running — app/chat-export does on open, and app/_layout once per
 * cold start (deferred until after first interactions).
 */
export async function sweepExportFiles(): Promise<void> {
  await RNFS.unlink(EXPORT_DIR).catch(() => {});
  try {
    for (const f of await RNFS.readDir(RNFS.CachesDirectoryPath)) {
      if (f.isFile() && f.name.startsWith(LEGACY_PREFIX)) await RNFS.unlink(f.path).catch(() => {});
    }
  } catch { /* best effort */ }
}

/** Thrown when the user cancels (or leaves) mid-export. Not an error to report. */
export class ExportCancelled extends Error {
  constructor() { super('Export cancelled'); }
}

/**
 * Write head + one line per item + tail(count) to a new cache file. Returns its
 * file:// URI and the number of lines written. `chunks` arrive in order (for a
 * chat export, lib/messageHistory streams them from the server and the cache),
 * so no more than one chunk is held, raw or prepared.
 */
export async function writeExportFile<T>(
  name: string, head: string, chunks: AsyncIterable<T[]>, line: (item: T) => string, tail: (count: number) => string,
  opts: {
    cancelled: () => boolean; onProgress?: (written: number) => void;
    /** Turns a chunk (in order) into what `line` prints — e.g. decrypts it. */
    prepare?: (chunk: T[]) => Promise<T[]>;
  },
): Promise<{ uri: string; count: number }> {
  await RNFS.mkdir(EXPORT_DIR).catch(() => {});
  const path = `${EXPORT_DIR}/${name}`;
  await RNFS.writeFile(path, head, 'utf8');
  let count = 0;
  try {
    for await (const raw of chunks) {
      if (opts.cancelled()) throw new ExportCancelled();
      const chunk = opts.prepare ? await opts.prepare(raw) : raw;
      if (opts.cancelled()) throw new ExportCancelled();
      let buf = '';
      for (const it of chunk) buf += line(it);
      await RNFS.appendFile(path, buf, 'utf8');
      count += chunk.length;
      opts.onProgress?.(count);
    }
    if (opts.cancelled()) throw new ExportCancelled();
    await RNFS.appendFile(path, tail(count), 'utf8');
  } catch (e) {
    await RNFS.unlink(path).catch(() => {});
    throw e;
  }
  return { uri: `file://${path}`, count };
}

/**
 * The plaintext file is a temporary hand-off to the share sheet, not an
 * archive: deleted once the sheet returns (shareAsync resolves after the
 * receiving app has taken its copy). Without expo-sharing the file's own text
 * goes to the plain share sheet, as the export did before it was chunked.
 */
export async function shareExportFile(uri: string, mime: string): Promise<void> {
  try {
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: mime });
    else await Share.share({ message: await FileSystem.readAsStringAsync(uri) });
  } finally {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
  }
}
