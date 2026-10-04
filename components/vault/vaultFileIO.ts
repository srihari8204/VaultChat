// components/vault/vaultFileIO.ts — disk-to-disk streaming for app/vault.tsx.
//
// New vault files are v3 (lib/vaultCrypto): sealed in 1 MiB chunks read
// straight from the picked file and written straight to the .enc file through
// expo-file-system's FileHandle, so a file is never held whole in JS memory.
// Files added before v3 (JSON v1/v2) still open through the old whole-file path.

import { File } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import {
  isV3, v3OpenStream, v3SealStream, vaultFileDecrypt, VaultKeyMissingError,
  type VaultKeys,
} from '../../lib/vaultCrypto';

type Handle = ReturnType<File['open']>;

// The handle's own read returns what it read, but Android's FileChannel-based
// read hands back the whole requested buffer even if the channel read less.
// Checking that the offset moved by exactly `n` catches a short read instead of
// sealing zero padding as if it were the file.
function reader(h: Handle) {
  let pos = 0;
  return (n: number): Uint8Array => {
    h.offset = pos;
    const b = n === 0 ? new Uint8Array(0) : h.readBytes(n);
    if (b.length !== n || (n > 0 && h.offset !== pos + n)) throw new Error('The file could not be read completely. Try again.');
    pos += n;
    return b;
  };
}
function writer(h: Handle) {
  let pos = 0;
  return (b: Uint8Array) => {
    if (b.length === 0) return;
    h.offset = pos;
    h.writeBytes(b);
    pos += b.length;
  };
}

function sizeOf(h: Handle, f: File): number {
  const n = Number(h.size ?? f.size);
  if (!Number.isFinite(n) || n < 0) throw new Error('The file size could not be read.');
  return n;
}

/**
 * Seal the file at `srcUri` (a file:// URI the pickers return with a cache
 * copy) into a new v3 file at `destUri`. Returns the plaintext size. Needs the
 * vault key: there is no weaker fallback. A partial output is deleted.
 */
export async function sealFileToVault(keys: VaultKeys | null, srcUri: string, destUri: string): Promise<number> {
  if (!keys) throw new VaultKeyMissingError();
  const src = new File(srcUri);
  const out = new File(destUri);
  const sh = src.open();
  let oh: Handle | null = null;
  try {
    const size = sizeOf(sh, src);
    out.create({ intermediates: true, overwrite: true });
    oh = out.open();
    await v3SealStream(keys.dek, size, reader(sh), writer(oh));
    return size;
  } catch (e) {
    try { oh?.close(); oh = null; } catch { /* closing a failed handle */ }
    try { if (out.exists) out.delete(); } catch { /* best effort */ }
    throw e;
  } finally {
    try { sh.close(); } catch { /* already closed */ }
    try { oh?.close(); } catch { /* already closed */ }
  }
}

/**
 * Decrypt the vault file at `encUri` into `outUri` (a cache path the caller
 * deletes). v3 streams chunk by chunk; v1/v2 (JSON) use the PIN-era whole-file
 * path, so every file ever added still opens.
 */
export async function openVaultFileTo(keys: VaultKeys | null, pin: string, encUri: string, outUri: string): Promise<void> {
  const enc = new File(encUri);
  const eh = enc.open();
  let v3 = false;
  try {
    eh.offset = 0;
    v3 = isV3(eh.readBytes(4));
    if (v3) {
      if (!keys) throw new Error('The vault key could not be opened with this PIN.');
      const size = sizeOf(eh, enc);
      const out = new File(outUri);
      out.create({ intermediates: true, overwrite: true });
      const oh = out.open();
      try { await v3OpenStream(keys.dek, size, reader(eh), writer(oh)); }
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
  const base64 = vaultFileDecrypt(keys, pin, payload);
  await FileSystem.writeAsStringAsync(outUri, base64, { encoding: 'base64' });
}
