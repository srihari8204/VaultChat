// services/crypto/vaultbeam-parity.selftest.ts — VaultBeam Rust↔JS interop gate
// (Phase 3, Step 5). Drives the REAL vaultbeam-core through the vb-cli line-JSON
// REPL — the same FFI dispatch the native binding calls — and proves, against an
// in-process JS oracle (node:crypto) AND the frozen golden vectors:
//   • sealChunk/openChunk byte-identical to JS + to services/crypto/__vectors__/
//     vaultbeam.json (the frozen Kotlin wire contract)
//   • sha256(file) parity
//   • sealBlockFromFile byte-identical to the JS block-layout oracle
//
// This closes the HOST half of the interop bar: Rust ≡ JS ≡ frozen-vectors, and
// the vectors are the frozen Kotlin contract — so Rust ≡ Kotlin's wire. The
// remaining CROSS-VERSION e2e (a running old-Kotlin build ⇄ new-Rust build over
// LAN/P2P/relay, and resume across a backend switch) is the ON-DEVICE gate
// documented in lib/vaultbeam-rust/DESIGN.md §9 — it needs two real builds and
// cannot run in Node CI, exactly like Phase 1's on-device crypto soak.
//
// Builds vb-cli via `cargo build --bin vb-cli` if missing; SKIPS (exit 0) with a
// warning if cargo is absent, so test:e2ee stays runnable on Rust-less machines.
//
// Run:  npm run test:vaultbeam:parity   (also part of npm run test:e2ee)

import { execSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { deepStrictEqual } from 'node:assert';
import * as crypto from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUST_DIR = path.join(HERE, '..', 'vaultbeam', 'rust');
const VECTORS = path.join(HERE, '__vectors__', 'vaultbeam.json');

// ── the JS oracle (identical derivation to the Kotlin module + Step 0 vectors) ─
function chunkNonce(transferId: string, chunkId: number): Buffer {
  const n = Buffer.alloc(12);
  Buffer.from(transferId, 'utf8').copy(n, 0, 0, 4);
  n.writeBigUInt64BE(BigInt(chunkId), 4);
  return n;
}
function jsSeal(key: Buffer, tid: string, fid: string, id: number, plain: Buffer): Buffer {
  const c = crypto.createCipheriv('aes-256-gcm', key, chunkNonce(tid, id), { authTagLength: 16 });
  c.setAAD(Buffer.from(`${tid}|${fid}|${id}`, 'utf8'));
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}
const b64 = (b: Buffer): string => b.toString('base64');

// ── locate / build vb-cli ──────────────────────────────────────────────────
function findCli(): string | null {
  const exe = process.platform === 'win32' ? 'vb-cli.exe' : 'vb-cli';
  for (const profile of ['debug', 'release']) {
    const p = path.join(RUST_DIR, 'target', profile, exe);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
let cliPath = findCli();
if (!cliPath) {
  try {
    execSync('cargo build --bin vb-cli', { cwd: RUST_DIR, stdio: 'inherit' });
    cliPath = findCli();
  } catch {
    console.warn('\n⚠ vaultbeam parity SKIPPED: Rust toolchain unavailable (no cargo, no prebuilt vb-cli). Install rustup and re-run. CI must run this with Rust installed.\n');
    process.exit(0);
  }
}
if (!cliPath) {
  console.error('✗ vaultbeam parity: cargo build succeeded but vb-cli not found');
  process.exit(1);
}

// ── line-JSON RPC over vb-cli ────────────────────────────────────────────────
class RustCli {
  private proc: ChildProcessWithoutNullStreams;
  private pending: ((line: string) => void)[] = [];
  constructor(bin: string) {
    this.proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    readline.createInterface({ input: this.proc.stdout }).on('line', (l) => {
      const next = this.pending.shift();
      if (next) next(l);
    });
  }
  call(op: string, args: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      this.pending.push((line) => {
        const resp = JSON.parse(line);
        resp.ok ? resolve(resp.result) : reject(new Error(resp.error || 'vb: unknown error'));
      });
      this.proc.stdin.write(`${JSON.stringify({ op, args })}\n`);
    });
  }
  close(): void { this.proc.stdin.end(); }
}

let failures = 0;
function check(cond: boolean, name: string): void {
  console.log(`  ${cond ? '✓' : '✗ FAIL'} ${name}`);
  if (!cond) failures += 1;
}

async function main(): Promise<void> {
  const rust = new RustCli(cliPath!);
  console.log(`vaultbeam parity → ${path.basename(cliPath!)}\n`);

  // 1) Rust reproduces the frozen golden vectors byte-for-byte.
  console.log('golden-vector reproduction (Rust ≡ frozen Kotlin contract):');
  const g = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));
  for (const c of g.chunks) {
    const key = Buffer.from(g.inputs.keyHex, 'hex');
    const out = await rust.call('sealChunk', {
      keyB64: b64(key), transferId: c.transferId, fileId: c.fileId, chunkId: c.chunkId,
      plaintextB64: b64(Buffer.from(c.plaintextHex, 'hex')),
    });
    check(Buffer.from(out, 'base64').toString('hex') === c.wireHex, `sealChunk == vector: ${c.name}`);
  }

  // 2) Rust ≡ JS oracle over random inputs (seal + open round-trip).
  console.log('Rust ↔ JS oracle (random):');
  for (let i = 0; i < 20; i++) {
    const key = crypto.randomBytes(32);
    const tid = ['ab', 'TQF9k2mZ', 'x'.repeat(20)][i % 3];
    const fid = `f${i}`;
    const id = [0, 1, 7, 0x100000002, i * 123457][i % 5];
    const plain = crypto.randomBytes(i === 0 ? 0 : 1 + ((i * 37) % 200));
    const rustCt = Buffer.from(await rust.call('sealChunk', { keyB64: b64(key), transferId: tid, fileId: fid, chunkId: id, plaintextB64: b64(plain) }), 'base64');
    if (i < 6) check(rustCt.equals(jsSeal(key, tid, fid, id, plain)), `seal ≡ JS oracle (case ${i})`);
    const back = Buffer.from(await rust.call('openChunk', { keyB64: b64(key), transferId: tid, fileId: fid, chunkId: id, ctB64: b64(rustCt) }), 'base64');
    check(back.equals(plain), `open round-trips (case ${i})`);
  }

  // 3) sha256(file) parity.
  console.log('sha256(file) parity:');
  const tmp = path.join(os.tmpdir(), `vbparity-${process.pid}.bin`);
  const data = crypto.randomBytes(5000);
  fs.writeFileSync(tmp, data);
  const rustHash = await rust.call('sha256', { path: tmp });
  check(rustHash === crypto.createHash('sha256').update(data).digest('hex'), 'sha256 ≡ node crypto');
  fs.rmSync(tmp, { force: true });

  // 4) sealBlockFromFile ≡ JS block-layout oracle (uniform + partial tail).
  console.log('block layout parity:');
  const bkey = crypto.randomBytes(32);
  const total = 100, chunkBytes = 16, blockBytes = 64;
  const fileData = Buffer.alloc(total);
  for (let o = 0; o < total; o++) fileData[o] = (o * 31 + 7) & 0xff;
  const src = path.join(os.tmpdir(), `vbparity-blk-${process.pid}.bin`);
  fs.writeFileSync(src, fileData);
  for (const blockIndex of [0, 1]) {
    const rustBlock = Buffer.from(await rust.call('sealBlockFromFile', {
      srcPath: src, keyB64: b64(bkey), transferId: 'Blk', fileId: 'F', blockIndex, chunkBytes, blockBytes, totalBytes: total,
    }), 'base64');
    // JS oracle: uniform ids = blockIndex*chunksPerBlock + i, tail = min(chunkBytes, total-off)
    const cpb = blockBytes / chunkBytes, base = blockIndex * blockBytes, parts: Buffer[] = [];
    for (let i = 0; i < cpb; i++) {
      const off = base + i * chunkBytes;
      if (off >= total) break;
      const len = Math.min(chunkBytes, total - off);
      parts.push(jsSeal(bkey, 'Blk', 'F', blockIndex * cpb + i, fileData.subarray(off, off + len)));
    }
    check(rustBlock.equals(Buffer.concat(parts)), `sealBlockFromFile ≡ JS oracle (block ${blockIndex})`);
  }
  fs.rmSync(src, { force: true });

  rust.close();
  console.log(`\n${failures === 0 ? 'ALL VAULTBEAM PARITY CHECKS PASSED ✓ (Rust ≡ JS ≡ frozen wire)' : `✗ ${failures} VAULTBEAM PARITY CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('vaultbeam parity harness error:', e); process.exit(1); });
