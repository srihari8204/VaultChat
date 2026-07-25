// services/crypto/parity.selftest.ts — TS↔Rust interop gate (Phase 1, Step 5).
//
// Drives the REAL Rust core (services/crypto/rust) through the vc-crypto-cli
// line-JSON REPL — the same dispatcher the Nitro binding calls — and proves,
// against the in-process TS reference:
//   • X3DH agreement both directions (TS initiator↔Rust responder + reverse)
//   • ratchet messages encrypted by one backend decrypt in the other, across
//     DH-ratchet steps AND the skipped-key cache
//   • a RatchetState serialized by one backend continues in the other
//   • group sender-keys: distribute/encrypt/decrypt across backends, with the
//     skipped cache written by one and consumed by the other
//   • Shamir: split in one, recover in the other (both directions)
//   • Ed25519 signatures verify cross-backend
//
// Requires the Rust toolchain once: the script builds vc-crypto-cli via
// `cargo build` if it's missing. If cargo is not installed at all it SKIPS
// with a loud warning (exit 0) so test:e2ee stays runnable on Rust-less
// machines — CI must run it with Rust installed (see DESIGN.md §7).
//
// Run:  npm run test:crypto:parity   (also part of npm run test:e2ee)

import { execSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  bytesToHex, hexToBytes, utf8, fromUtf8, randomBytes,
  generateDH, generateSigningKey, sign, verify,
  x3dhInitiator, x3dhResponder,
  ratchetInitAlice, ratchetEncrypt, ratchetDecrypt,
  serializeState, deserializeState, encodeEnvelope, decodeEnvelope,
} from './e2ee';
import type { PreKeyBundle } from './e2ee';
import {
  createSenderKey, distributionMessage, processDistribution, groupEncrypt, groupDecrypt,
} from './senderKey';
import { splitSecret, combineShares } from './shamir';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUST_DIR = path.join(HERE, 'rust');

// ── locate / build the Rust CLI ────────────────────────────────────────

function findCli(): string | null {
  const exe = process.platform === 'win32' ? 'vc-crypto-cli.exe' : 'vc-crypto-cli';
  for (const profile of ['debug', 'release']) {
    const p = path.join(RUST_DIR, 'target', profile, exe);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

let cliPath = findCli();
if (!cliPath) {
  try {
    execSync('cargo build', { cwd: RUST_DIR, stdio: 'inherit' });
    cliPath = findCli();
  } catch {
    console.warn(
      '\n⚠ parity SKIPPED: Rust toolchain not available (cargo not found and no ' +
        'prebuilt vc-crypto-cli). Install rustup and re-run `npm run test:crypto:parity`. ' +
        'CI must run this suite with Rust installed — the PR gate is NOT green without it.\n',
    );
    process.exit(0);
  }
}
if (!cliPath) {
  console.error('✗ parity: cargo build succeeded but vc-crypto-cli not found');
  process.exit(1);
}

// ── minimal line-JSON RPC over the CLI ─────────────────────────────────

class RustCore {
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
        if (resp.ok) resolve(resp.result);
        else reject(new Error(resp.error || 'rust: unknown error'));
      });
      this.proc.stdin.write(`${JSON.stringify({ op, args })}\n`);
    });
  }

  close(): void {
    this.proc.stdin.end();
  }
}

// ── harness ────────────────────────────────────────────────────────────

let failures = 0;
function check(cond: boolean, name: string): void {
  console.log(`  ${cond ? '✓' : '✗ FAIL'} ${name}`);
  if (!cond) failures += 1;
}
const utf8hex = (s: string): string => bytesToHex(utf8(s));
const hexUtf8 = (h: string): string => fromUtf8(hexToBytes(h));

async function main(): Promise<void> {
  console.log('TS↔Rust parity self-test\n────────────────────────');
  const rust = new RustCore(cliPath as string);

  // ── Ed25519 cross-verify ─────────────────────────────────────────────
  const tsSigner = generateSigningKey();
  const msg = utf8('cross-backend signature');
  check(
    (await rust.call('verify', {
      sig: bytesToHex(sign(msg, tsSigner.priv)),
      msg: bytesToHex(msg),
      pub: bytesToHex(tsSigner.pub),
    })) === true,
    'TS signature verifies in Rust',
  );
  const rustSigner = await rust.call('generateSigningKey', {});
  const rustSig = await rust.call('sign', { msg: bytesToHex(msg), priv: rustSigner.priv });
  check(verify(hexToBytes(rustSig), msg, hexToBytes(rustSigner.pub)), 'Rust signature verifies in TS');

  // ── X3DH: TS initiator ↔ Rust responder ──────────────────────────────
  const bobId = await rust.call('generateDH', {});
  const bobSign = await rust.call('generateSigningKey', {});
  const bobSpk = await rust.call('generateDH', {});
  const spkSig = await rust.call('sign', { msg: bobSpk.pub, priv: bobSign.priv });
  const bundle: PreKeyBundle = {
    identityKey: hexToBytes(bobId.pub),
    signingKey: hexToBytes(bobSign.pub),
    signedPreKey: hexToBytes(bobSpk.pub),
    signedPreKeySig: hexToBytes(spkSig),
    oneTimePreKey: null,
    oneTimePreKeyId: null,
  };
  const aliceId = generateDH();
  const { sk, header } = x3dhInitiator(aliceId, bundle);
  const skBob = await rust.call('x3dhResponder', {
    myIdentity: bobId,
    mySignedPreKey: bobSpk,
    myOneTimePreKey: null,
    header: {
      identityKey: bytesToHex(header.identityKey),
      ephemeralKey: bytesToHex(header.ephemeralKey),
    },
  });
  check(bytesToHex(sk) === skBob, 'X3DH agrees (TS initiator, Rust responder)');

  // ── X3DH reverse: Rust initiator ↔ TS responder (with OTK) ───────────
  const tId = generateDH();
  const tSign = generateSigningKey();
  const tSpk = generateDH();
  const tOtk = generateDH();
  const init = await rust.call('x3dhInitiator', {
    myIdentity: await rust.call('generateDH', {}),
    bundle: {
      identityKey: bytesToHex(tId.pub),
      signingKey: bytesToHex(tSign.pub),
      signedPreKey: bytesToHex(tSpk.pub),
      signedPreKeySig: bytesToHex(sign(tSpk.pub, tSign.priv)),
      oneTimePreKey: bytesToHex(tOtk.pub),
      oneTimePreKeyId: 42,
    },
  });
  const skTs = x3dhResponder(tId, tSpk, tOtk, {
    identityKey: hexToBytes(init.header.identityKey),
    ephemeralKey: hexToBytes(init.header.ephemeralKey),
    oneTimePreKeyId: init.header.oneTimePreKeyId,
  });
  check(init.sk === bytesToHex(skTs), 'X3DH agrees (Rust initiator, TS responder, +OTK)');
  check(init.header.oneTimePreKeyId === 42, 'OTK id round-trips through the Rust header');

  // ── Double Ratchet: cross-backend conversation ───────────────────────
  const aliceState = ratchetInitAlice(sk, bundle.signedPreKey); // TS object
  let bobStateJson: string = await rust.call('ratchetInitBob', {
    sk: skBob,
    bobSignedPreKey: bobSpk,
  });

  // m1: TS alice encrypts → Rust bob decrypts
  const env1 = encodeEnvelope(ratchetEncrypt(aliceState, utf8('m1 from ts alice')));
  let r = await rust.call('ratchetDecrypt', { state: bobStateJson, envelope: env1 });
  bobStateJson = r.state;
  check(hexUtf8(r.plaintext) === 'm1 from ts alice', 'TS→Rust message decrypts');

  // m2: Rust bob replies (DH ratchet on his side) → TS alice decrypts
  r = await rust.call('ratchetEncrypt', { state: bobStateJson, plaintext: utf8hex('m2 from rust bob') });
  bobStateJson = r.state;
  check(
    fromUtf8(ratchetDecrypt(aliceState, decodeEnvelope(r.envelope))) === 'm2 from rust bob',
    'Rust→TS message decrypts (across a DH ratchet)',
  );

  // Alice CONTINUES IN RUST from her TS-serialized state.
  let aliceJson = serializeState(aliceState);
  r = await rust.call('ratchetEncrypt', { state: aliceJson, plaintext: utf8hex('m3 alice via rust') });
  aliceJson = r.state;
  const env3 = r.envelope;
  r = await rust.call('ratchetEncrypt', { state: aliceJson, plaintext: utf8hex('m4 alice via rust') });
  aliceJson = r.state;
  const env4 = r.envelope;

  // Bob CONTINUES IN TS from his Rust-produced state; m4 arrives before m3
  // (skipped-key cache written and consumed across the backend switch).
  const bobState = deserializeState(bobStateJson);
  check(
    fromUtf8(ratchetDecrypt(bobState, decodeEnvelope(env4))) === 'm4 alice via rust',
    'TS continues Rust bob state; out-of-order m4 decrypts',
  );
  check(
    fromUtf8(ratchetDecrypt(bobState, decodeEnvelope(env3))) === 'm3 alice via rust',
    'skipped m3 served from the cache (cross-backend)',
  );

  // Bob replies via TS; alice returns to TS from her Rust-produced state.
  const env5 = encodeEnvelope(ratchetEncrypt(bobState, utf8('m5 bob via ts')));
  const aliceBack = deserializeState(aliceJson);
  check(
    fromUtf8(ratchetDecrypt(aliceBack, decodeEnvelope(env5))) === 'm5 bob via ts',
    'TS continues Rust alice state and decrypts',
  );

  // ── Group sender keys across backends ────────────────────────────────
  // TS sender → Rust receiver, out-of-order, record ping-pongs backends.
  const own0 = createSenderKey();
  const peerRust = await rust.call('processDistribution', { skdm: distributionMessage(own0) });
  const g0 = groupEncrypt(own0, 'g0 from ts');
  const g1 = groupEncrypt(g0.next, 'g1 from ts');
  const g2 = groupEncrypt(g1.next, 'g2 from ts');
  let g = await rust.call('groupDecrypt', { rec: peerRust, cipher: g2.cipher });
  check(g.plaintext === 'g2 from ts', 'group: Rust decrypts TS msg #2 first');
  const tsDec = groupDecrypt(g.next, g0.cipher);
  check(tsDec.plaintext === 'g0 from ts', 'group: TS serves #0 from Rust-written cache');
  g = await rust.call('groupDecrypt', { rec: tsDec.next, cipher: g1.cipher });
  check(g.plaintext === 'g1 from ts', 'group: Rust serves #1 from TS-advanced record');

  // Rust sender → TS receiver.
  const ownR = await rust.call('createSenderKey', {});
  const distR = await rust.call('distributionMessage', { own: ownR });
  const encR = await rust.call('groupEncrypt', { own: ownR, plaintext: 'g0 from rust' });
  check(
    groupDecrypt(processDistribution(distR), encR.cipher).plaintext === 'g0 from rust',
    'group: TS decrypts Rust sender',
  );

  // ── Shamir cross-recovery ────────────────────────────────────────────
  const secret = randomBytes(32);
  const sharesTs = splitSecret(secret, { n: 5, k: 3 });
  check(
    (await rust.call('combineShares', { shares: sharesTs.slice(1, 4) })) === bytesToHex(secret),
    'shamir: TS split → Rust recovers (middle subset)',
  );
  check(
    (await rust.call('shareThreshold', { share: sharesTs[0] })) === 3,
    'shamir: Rust reads TS share threshold',
  );
  const sharesRust: string[] = await rust.call('splitSecret', {
    secret: bytesToHex(secret),
    n: 4,
    k: 2,
  });
  check(
    bytesToHex(combineShares([sharesRust[3], sharesRust[0]])) === bytesToHex(secret),
    'shamir: Rust split → TS recovers (2-of-4, reversed order)',
  );

  rust.close();
  console.log('────────────────────────');
  if (failures > 0) {
    console.error(`✗ ${failures} PARITY CHECK(S) FAILED`);
    process.exit(1);
  }
  console.log('ALL PARITY CHECKS PASSED ✓ (TS↔Rust interop proven)');
}

main().catch((e) => {
  console.error('✗ parity harness error:', e);
  process.exit(1);
});
