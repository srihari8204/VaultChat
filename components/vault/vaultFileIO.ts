// components/vault/vaultFileIO.ts — disk-to-disk streaming for app/vault.tsx.
//
// New vault files are v4 (lib/vaultCrypto): sealed in 1 MiB chunks read
// straight from the picked file and written straight to the .enc file through
// expo-file-system's FileHandle, so a file is never held whole in JS memory,
// and bound to their file id. Files added before (JSON v1/v2, chunked v3)
// still open. Tested by components/vault/vaultFileIO.selftest.ts with an
// in-memory stand-in for expo-file-system.

import { Directory, File } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import {
  isV3, v3OpenStream, v3SealedSize, v3SealStream, vaultFileDecrypt, VaultCopyError, VaultKeyMissingError,
  type V3StreamOptions, type VaultKeys,
} from '../../lib/vaultCrypto';

type Handle = ReturnType<File['open']>;

/** A seal writes here first and is renamed to `<id>.enc` only once complete,
 *  so a seal the OS killed leaves a `.part` file the next unlock deletes. */
const PART = '.part';
// Seals running in this JS context: the sweep never deletes their .part files.
let sealsInFlight = 0;

// The handle's own read returns what it read, but Android's FileChannel-based
// read hands back the whole requested buffer even if the channel read less.
// Checking that the offset moved by exactly `n` catches a short read instead of
// sealing zero padding as if it were the file.
function reader(h: Handle) {
  let pos = 0;
  return (n: number): Uint8Array => {
    h.offset = pos;
    const b = n === 0 ? new Uint8Array(0) : h.readBytes(n);
    if (b.length !== n || (n > 0 && h.offset !== pos + n)) throw new VaultCopyError('The file could not be read completely. Try again.');
    pos += n;
    return b;
  };
}
// Same check on the way out: the offset must move by exactly what was written.
function writer(h: Handle) {
  let pos = 0;
  return (b: Uint8Array) => {
    if (b.length === 0) return;
    h.offset = pos;
    h.writeBytes(b);
    if (h.offset !== pos + b.length) throw new VaultCopyError('The file could not be written completely. Check the free space and try again.');
    pos += b.length;
  };
}

function sizeOf(h: Handle, f: File): number {
  const n = Number(h.size ?? f.size);
  if (!Number.isFinite(n) || n < 0) throw new VaultCopyError('The file size could not be read.');
  return n;
}

/** The id a `.enc` file was sealed for: its name without the extension. */
export const vaultFileIdOf = (uri: string) => (uri.split('/').pop() ?? '').replace(/\.enc$/, '');

/**
 * Seal the file at `srcUri` (a file:// URI the pickers return with a cache
 * copy) into a new v4 file at `destUri` (`<dir>/<fileId>.enc`), bound to that
 * file id. Returns the plaintext size. Needs the vault key: there is no weaker
 * fallback. `expectedSize` is what the picker reported (0 if it did not say).
 * The output is written to `<destUri>.part`, its length checked, and only then
 * renamed into place; any failure or cancel deletes it.
 */
export async function sealFileToVault(
  keys: VaultKeys | null, srcUri: string, destUri: string, expectedSize: number, opts: V3StreamOptions = {},
): Promise<number> {
  if (!keys) throw new VaultKeyMissingError();
  const src = new File(srcUri);
  // Android's File.open() is RandomAccessFile "rw": it would CREATE a vanished
  // source as an empty file, which would then be sealed as a 0-byte file.
  if (!src.exists) throw new VaultCopyError('The picked file is no longer there. Pick it again.');
  const part = new File(destUri + PART);
  const name = destUri.split('/').pop() ?? '';
  const sh = src.open();
  sealsInFlight++;
  let oh: Handle | null = null;
  try {
    const size = sizeOf(sh, src);
    if (size === 0 && expectedSize > 0) throw new VaultCopyError('The picked file could not be read (it is empty). Pick it again.');
    part.create({ intermediates: true, overwrite: true });
    oh = part.open();
    await v3SealStream(keys.dek, size, reader(sh), writer(oh), vaultFileIdOf(destUri), opts);
    oh.close(); oh = null;
    // Read the length back from disk before the file is listed.
    if (new File(part.uri).size !== v3SealedSize(size)) throw new VaultCopyError('The encrypted copy was not written completely. Check the free space and try again.');
    part.rename(name);
    return size;
  } catch (e) {
    try { oh?.close(); oh = null; } catch { /* closing a failed handle */ }
    try { const p = new File(destUri + PART); if (p.exists) p.delete(); } catch { /* best effort */ }
    throw e;
  } finally {
    sealsInFlight--;
    try { sh.close(); } catch { /* already closed */ }
    try { oh?.close(); } catch { /* already closed */ }
  }
}

/**
 * Decrypt the vault file at `encUri` into `outUri` (a cache path the caller
 * deletes). v3/v4 stream chunk by chunk, trying `keys` then `older`; v1/v2
 * (JSON) use the PIN-era whole-file path, so every file ever added still opens.
 */
export async function openVaultFileTo(
  keys: VaultKeys | null, older: VaultKeys[], pin: string, encUri: string, outUri: string, opts: V3StreamOptions = {},
): Promise<void> {
  const enc = new File(encUri);
  if (!enc.exists) throw new VaultCopyError('This file is missing from the vault folder.');
  const eh = enc.open();
  let v3 = false;
  try {
    eh.offset = 0;
    v3 = isV3(eh.readBytes(4));
    if (v3) {
      const deks = (keys ? [keys, ...older] : older).map((k) => k.dek);
      if (!deks.length) throw new VaultCopyError('The vault key could not be opened with this PIN.');
      const size = sizeOf(eh, enc);
      const out = new File(outUri);
      out.create({ intermediates: true, overwrite: true });
      const oh = out.open();
      try { await v3OpenStream(deks, size, reader(eh), writer(oh), vaultFileIdOf(encUri), opts); }
      catch (e) {
        // Chunks before the damaged one were authentic and already written:
        // never leave a partial plaintext copy behind.
        try { oh.close(); } catch { /* already closed */ }
        try { if (out.exists) out.delete(); } catch { /* best effort */ }
        throw e;
      }
      finally { try { oh.close(); } catch { /* already closed */ } }
    }
  } finally {
    try { eh.close(); } catch { /* already closed */ }
  }
  if (v3) return;
  // ponytail: v1/v2 files are one sealed base64 string, so opening one still
  // holds it in memory several times over. They are never rewritten (the
  // data-loss rule in lib/vaultKeyStore); only files added from v3 on stream.
  const payload = JSON.parse(await FileSystem.readAsStringAsync(encUri, { encoding: 'utf8' }));
  const base64 = vaultFileDecrypt(keys, pin, payload, older);
  await FileSystem.writeAsStringAsync(outUri, base64, { encoding: 'base64' });
}

const V1_HEAD = [0x7b, 0x22, 0x76, 0x22, 0x3a, 0x31];   // '{"v":1'

export interface VaultDirScan {
  /** Ids of complete `.enc` files in the folder. */
  ids: string[];
  /** How many of them need a vault key (v2 JSON, v3/v4, or unrecognised — counted to be safe). */
  keyed: number;
}

/** What is in the vault folder. A missing folder is an empty vault; a folder
 *  that cannot be listed throws (the caller must not assume it is empty). */
export function scanVaultDir(dirUri: string): VaultDirScan {
  const dir = new Directory(dirUri);
  if (!dir.exists) return { ids: [], keyed: 0 };
  const ids: string[] = [];
  let keyed = 0;
  for (const entry of dir.list()) {
    if (!(entry instanceof File) || !entry.uri.endsWith('.enc')) continue;
    ids.push(vaultFileIdOf(entry.uri));
    let head = new Uint8Array(0);
    try {
      const h = entry.open();
      try { h.offset = 0; head = h.readBytes(Math.min(6, Number(h.size ?? 6))); } finally { h.close(); }
    } catch { /* unreadable: counted as keyed below */ }
    // v1 is `{"v":1,…` (sealed from the PIN, no key needed); anything else may need the key.
    if (!(head.length === V1_HEAD.length && V1_HEAD.every((x, i) => head[i] === x))) keyed++;
  }
  return { ids, keyed };
}

/** Delete `.part` files a killed seal left behind (never while a seal runs). */
export function sweepPartialSeals(dirUri: string): number {
  if (sealsInFlight > 0) return 0;
  const dir = new Directory(dirUri);
  if (!dir.exists) return 0;
  let n = 0;
  for (const entry of dir.list()) {
    if (entry instanceof File && entry.uri.endsWith(PART)) {
      try { entry.delete(); n++; } catch { /* next unlock tries again */ }
    }
  }
  return n;
}
