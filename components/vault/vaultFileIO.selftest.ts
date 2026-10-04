// components/vault/vaultFileIO.selftest.ts — run: npx tsx components/vault/vaultFileIO.selftest.ts
//
// The vault's disk I/O against an in-memory expo-file-system that behaves like
// Android's (File.open() CREATES a missing file, as RandomAccessFile "rw" does):
//   • a seal writes `<id>.enc.part`, checks the length, then renames it into place,
//   • a vanished or emptied source is refused instead of sealed as 0 bytes,
//   • a short write, a failure or a cancel leaves neither .part nor .enc behind,
//   • two .enc files swapped on disk do not open under each other's entry,
//   • archived keys open old files; the dir scan counts key-dependent files;
//     the sweep deletes only .part files.

import assert from 'node:assert/strict';

const disk = new Map<string, Uint8Array>();
let shortWrite = false;

class FakeHandle {
  offset: number | null = 0;
  constructor(private uri: string) {}
  get size() { return disk.get(this.uri)!.length; }
  readBytes(n: number) {
    const d = disk.get(this.uri)!;
    const b = d.slice(this.offset!, this.offset! + n);
    this.offset! += b.length;
    return b;
  }
  writeBytes(b: Uint8Array) {
    const take = shortWrite ? b.subarray(0, Math.max(0, b.length - 1)) : b;
    const d = disk.get(this.uri)!;
    const end = this.offset! + take.length;
    const out = new Uint8Array(Math.max(d.length, end));
    out.set(d, 0); out.set(take, this.offset!);
    disk.set(this.uri, out);
    this.offset = end;
  }
  close() {}
}
class FakeFile {
  constructor(public uri: string) {}
  get exists() { return disk.has(this.uri); }
  get size() { return disk.get(this.uri)?.length ?? 0; }
  create() { disk.set(this.uri, new Uint8Array(0)); }
  open() { if (!disk.has(this.uri)) disk.set(this.uri, new Uint8Array(0)); return new FakeHandle(this.uri); }
  delete() { disk.delete(this.uri); }
  rename(name: string) {
    const to = this.uri.slice(0, this.uri.lastIndexOf('/') + 1) + name;
    disk.set(to, disk.get(this.uri)!); disk.delete(this.uri); this.uri = to;
  }
}
class FakeDirectory {
  constructor(public uri: string) {}
  get exists() { return [...disk.keys()].some((k) => k.startsWith(this.uri)); }
  list() { return [...disk.keys()].filter((k) => k.startsWith(this.uri)).map((k) => new FakeFile(k)); }
}

const Module = require('module');
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]) {
  if (request === 'react-native-get-random-values') return {};
  if (request === 'react-native-quick-crypto') return require('node:crypto');
  if (request === 'expo-file-system') return { File: FakeFile, Directory: FakeDirectory };
  if (request === 'expo-file-system/legacy') {
    return {
      readAsStringAsync: async (u: string) => Buffer.from(disk.get(u)!).toString('utf8'),
      writeAsStringAsync: async (u: string, s: string) => { disk.set(u, new Uint8Array(Buffer.from(s, 'base64'))); },
    };
  }
  return origLoad.call(this, request, ...rest);
};
const io = require('./vaultFileIO') as typeof import('./vaultFileIO');
const vc = require('../../lib/vaultCrypto') as typeof import('../../lib/vaultCrypto');

const DIR = 'file:///doc/vault/';
const SRC = 'file:///cache/pick.bin';
const keys = vc.newVaultKeys('1357');
const other = vc.newVaultKeys('2468');
const bytes = (n: number) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 13 + 1) & 0xff; return b; };
const only = (prefix: string) => [...disk.keys()].filter((k) => k.startsWith(prefix)).sort();

(async () => {
  // A good seal: one .enc, no .part, and it opens back to the same bytes.
  const plain = bytes(vc.V3_CHUNK + 99);
  disk.set(SRC, plain);
  const progress: number[] = [];
  const n = await io.sealFileToVault(keys, SRC, DIR + 'vault_a.enc', plain.length, { onProgress: (d) => progress.push(d) });
  assert.equal(n, plain.length);
  assert.deepEqual(only(DIR), [DIR + 'vault_a.enc']);
  assert.deepEqual(progress, [1, 2]);
  await io.openVaultFileTo(keys, [], '1357', DIR + 'vault_a.enc', 'file:///cache/out');
  assert.deepEqual(disk.get('file:///cache/out'), plain);

  // Swapped on disk: vault_b's entry pointing at vault_a's bytes does not open.
  disk.set(DIR + 'vault_b.enc', disk.get(DIR + 'vault_a.enc')!);
  await assert.rejects(io.openVaultFileTo(keys, [], '1357', DIR + 'vault_b.enc', 'file:///cache/out2'), /could not be opened/);
  assert.equal(disk.has('file:///cache/out2'), false, 'no partial plaintext');
  disk.delete(DIR + 'vault_b.enc');

  // Archived keys: a file under another key opens only with it in `older`.
  disk.set(SRC, bytes(10));
  await io.sealFileToVault(other, SRC, DIR + 'vault_c.enc', 10);
  await assert.rejects(io.openVaultFileTo(keys, [], '1357', DIR + 'vault_c.enc', 'file:///cache/o3'), /another key/);
  await io.openVaultFileTo(keys, [other], '1357', DIR + 'vault_c.enc', 'file:///cache/o3');
  assert.deepEqual(disk.get('file:///cache/o3'), bytes(10));
  await io.openVaultFileTo(null, [other], '1357', DIR + 'vault_c.enc', 'file:///cache/o4');
  assert.deepEqual(disk.get('file:///cache/o4'), bytes(10), 'old files open even while the current key is missing');

  // A vanished source is refused and NOT created by open().
  disk.delete(SRC);
  await assert.rejects(io.sealFileToVault(keys, SRC, DIR + 'vault_d.enc', 500), /no longer there/);
  assert.equal(disk.has(SRC), false);
  // An emptied source the picker said had bytes is refused.
  disk.set(SRC, new Uint8Array(0));
  await assert.rejects(io.sealFileToVault(keys, SRC, DIR + 'vault_d.enc', 500), /empty/);
  // A genuinely empty file (picker said 0 or nothing) is fine.
  assert.equal(await io.sealFileToVault(keys, SRC, DIR + 'vault_e.enc', 0), 0);

  // A short write fails and leaves nothing.
  disk.set(SRC, bytes(64));
  shortWrite = true;
  await assert.rejects(io.sealFileToVault(keys, SRC, DIR + 'vault_f.enc', 64), /written completely/);
  shortWrite = false;
  // A cancel leaves nothing.
  await assert.rejects(io.sealFileToVault(keys, SRC, DIR + 'vault_g.enc', 64, { cancelled: () => true }),
    (e: any) => e instanceof vc.VaultCancelledError);
  // Without the key nothing is written.
  await assert.rejects(io.sealFileToVault(null, SRC, DIR + 'vault_h.enc', 64), (e: any) => e instanceof vc.VaultKeyMissingError);
  assert.deepEqual(only(DIR), [DIR + 'vault_a.enc', DIR + 'vault_c.enc', DIR + 'vault_e.enc']);

  // A seal the OS killed leaves a .part: the sweep removes it and nothing else.
  disk.set(DIR + 'vault_k.enc.part', bytes(5));
  // A v1 file (sealed from the PIN, needs no key) and a v2 file.
  disk.set(DIR + 'vault_v1.enc', new TextEncoder().encode(JSON.stringify(vc.vaultEncrypt('1357', 'eA=='))));
  disk.set(DIR + 'vault_v2.enc', new TextEncoder().encode(JSON.stringify(vc.vaultFileEncrypt(keys, '1357', 'eA=='))));
  const scan = io.scanVaultDir(DIR);
  assert.deepEqual(scan.ids.sort(), ['vault_a', 'vault_c', 'vault_e', 'vault_v1', 'vault_v2']);
  assert.equal(scan.keyed, 4, 'v2/v3/v4 need the key; v1 does not; .part is ignored');
  assert.equal(io.scanVaultDir('file:///nowhere/').keyed, 0);
  assert.equal(io.sweepPartialSeals(DIR), 1);
  assert.equal(disk.has(DIR + 'vault_k.enc.part'), false);
  assert.equal(only(DIR).length, 5);

  // v1/v2 still open through the whole-file path, with archived keys too.
  await io.openVaultFileTo(null, [keys], '0000', DIR + 'vault_v2.enc', 'file:///cache/o5');
  assert.deepEqual(disk.get('file:///cache/o5'), new Uint8Array([0x78]));
  assert.equal(io.vaultFileIdOf(DIR + 'vault_a.enc'), 'vault_a');

  // The screen shows only copy written for people (rerate7/J flaw 5): every
  // failure above is a VaultCopyError; a library's own text gets the fallback.
  const shown = async (p: Promise<unknown>) => { try { await p; return 'resolved'; } catch (e) { return vc.vaultErrorText(e, 'FALLBACK'); } };
  disk.delete(SRC);
  assert.match(await shown(io.sealFileToVault(keys, SRC, DIR + 'vault_x.enc', 5)), /no longer there/);
  assert.match(await shown(io.sealFileToVault(null, SRC, DIR + 'vault_x.enc', 5)), /vault key is not open/);
  assert.match(await shown(io.openVaultFileTo(keys, [], '1357', DIR + 'vault_c.enc', 'file:///cache/o6')), /another key/);
  assert.match(await shown(io.openVaultFileTo(keys, [], '1357', DIR + 'vault_zz.enc', 'file:///cache/o6')), /missing from the vault folder/);
  assert.equal(vc.vaultErrorText(new Error('setAAD failed (native call returned false)'), 'FALLBACK'), 'FALLBACK');
  assert.equal(vc.vaultErrorText(new SyntaxError('Unexpected token'), 'FALLBACK'), 'FALLBACK');
  assert.equal(vc.vaultErrorText('x', 'FALLBACK'), 'FALLBACK');

  console.log('vaultFileIO.selftest: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
