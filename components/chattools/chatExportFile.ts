// components/chattools/chatExportFile.ts — write a chat export to a temporary
// file in chunks, and hand it to the share sheet.
//
// The export used to be built as ONE string (up to 100k messages) and then
// written; that string, the raw list and the decrypted list sat in memory
// together. Here each chunk is decrypted (`prepare`) and its lines appended as
// it is built, so only one chunk's plaintext exists at a time, and a cancelled
// export stops between chunks (and after each decrypt) and removes its file.

import * as RNFS from '@dr.pogodin/react-native-fs';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Share } from 'react-native';

const CHUNK = 500;

/** Thrown when the user cancels (or leaves) mid-export. Not an error to report. */
export class ExportCancelled extends Error {
  constructor() { super('Export cancelled'); }
}

/** Write head + one line per item + tail to a new cache file. Returns its file:// URI. */
export async function writeExportFile<T>(
  name: string, head: string, items: readonly T[], line: (item: T) => string, tail: string,
  opts: {
    cancelled: () => boolean; onProgress?: (written: number) => void;
    /** Turns a chunk (in order) into what `line` prints — e.g. decrypts it. */
    prepare?: (chunk: T[]) => Promise<T[]>;
  },
): Promise<string> {
  const path = `${RNFS.CachesDirectoryPath}/${name}`;
  await RNFS.writeFile(path, head, 'utf8');
  try {
    for (let i = 0; i < items.length; i += CHUNK) {
      if (opts.cancelled()) throw new ExportCancelled();
      const raw = items.slice(i, i + CHUNK);
      const chunk = opts.prepare ? await opts.prepare(raw) : raw;
      if (opts.cancelled()) throw new ExportCancelled();
      let buf = '';
      for (const it of chunk) buf += line(it);
      await RNFS.appendFile(path, buf, 'utf8');
      opts.onProgress?.(Math.min(i + CHUNK, items.length));
    }
    await RNFS.appendFile(path, tail, 'utf8');
  } catch (e) {
    await RNFS.unlink(path).catch(() => {});
    throw e;
  }
  return `file://${path}`;
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
