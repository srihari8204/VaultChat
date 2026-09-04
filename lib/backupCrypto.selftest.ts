// lib/backupCrypto.selftest.ts — run: npx tsx lib/backupCrypto.selftest.ts
//
// Exercises the REAL lib/backupCrypto.ts against the REAL lib/vaultCrypto.ts —
// full encrypt → stamp → parse → re-derive → decrypt round trips, not shape
// assertions. This is the key path for end-to-end encrypted backups: if it is
// wrong, the failure mode is a user who turned on the protection we advertised
// and cannot open their own history afterwards.
//
// Only the react-native-get-random-values polyfill import is stripped (Node has
// globalThis.crypto already). Everything else — PBKDF2, AES-256-GCM, the
// envelope, the validators — is the shipping code.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
function throws(name: string, fn: () => unknown) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  check(name, threw, 'expected it to throw, it did not');
}

// Inside the repo, not the OS temp dir: these copies import @noble/hashes and
// @noble/ciphers for real, and Node resolves node_modules by walking UP from the
// importing file — from %TEMP% that walk never reaches this project. Removed at
// the end of every run, success or failure.
const WORK = join(HERE, '..', `.selftest-backupcrypto-${process.pid}`);
mkdirSync(WORK, { recursive: true });
writeFileSync(join(WORK, 'package.json'), '{"type":"module"}');

const POLYFILL = /^import 'react-native-get-random-values';$/m;
for (const f of ['vaultCrypto.ts', 'backupCrypto.ts']) {
  const src = readFileSync(join(HERE, f), 'utf8');
  if (!POLYFILL.test(src)) {
    console.log(`  ✗ selftest could not strip the RN polyfill import from ${f}`);
    failures++;
  }
  writeFileSync(join(WORK, f), src.replace(POLYFILL, ''));
}

async function main() {
const BC: any = await import(pathToFileURL(join(WORK, 'backupCrypto.ts')).href);
const VC: any = await import(pathToFileURL(join(WORK, 'vaultCrypto.ts')).href);

// Real iteration counts make each derive ~0.2s of pure-JS PBKDF2; the round
// trips below use a cheap header so the suite stays fast. The shipping cost is
// asserted separately, because that is the number that actually protects a
// password-derived key.
const cheap = (mode: 'password' | 'key') => ({ ...BC.newHeader(mode), iter: 1000 });
const BUNDLE = JSON.stringify({ v: 4, messages: [{ id: 1, content: 'hello' }] });

console.log('\nThe shipping KDF cost is not negotiable downward:');
check('default iterations meet the OWASP floor for PBKDF2-SHA256',
  BC.KDF_ITERATIONS >= 210_000, `got ${BC.KDF_ITERATIONS}`);
check("newHeader stamps the real cost, not a test one",
  BC.newHeader('password').iter === BC.KDF_ITERATIONS);

// ── account-managed blobs must stay distinguishable ───────────────────────
// This is what tells a restore whether to ask for a secret. If an account blob
// ever parsed as e2ee, every restore would prompt for a password that does not
// exist; if an e2ee blob parsed as account-managed, the restore would silently
// try the server key and report the backup as corrupt.
console.log('\nAn account-managed blob is unambiguously not end-to-end:');
const accountBlob = JSON.stringify(VC.vaultEncrypt('server-dek', BUNDLE));
check('no header on an unstamped blob', BC.readE2EEHeader(accountBlob) === null);
check('and it still decrypts with the account key',
  VC.vaultDecrypt('server-dek', JSON.parse(accountBlob)) === BUNDLE);
check('garbage is not mistaken for a header', BC.readE2EEHeader('not json') === null);
check('a blob with a junk mode is rejected',
  BC.readE2EEHeader(JSON.stringify({ v: 1, iv: 'x', ct: 'y', vcE2EE: { mode: 'nope' } })) === null);

// ── password mode ─────────────────────────────────────────────────────────
console.log('\nPassword mode round-trips, and only with the right password:');
const pwHeader = cheap('password');
const pwSecret = BC.backupSecret(pwHeader, 'correct horse 9');
const pwBlob = BC.stampE2EEHeader(VC.vaultEncrypt(pwSecret, BUNDLE), pwHeader);

const parsed = BC.readE2EEHeader(pwBlob);
check('the header survives the round trip', parsed?.mode === 'password' && parsed?.salt === pwHeader.salt);
check('re-deriving from the password reproduces the key',
  BC.backupSecret(parsed, 'correct horse 9') === pwSecret);
check('and it opens the blob',
  VC.vaultDecrypt(BC.backupSecret(parsed, 'correct horse 9'), JSON.parse(pwBlob)) === BUNDLE);
throws('a wrong password does NOT open it',
  () => VC.vaultDecrypt(BC.backupSecret(parsed, 'correct horse 8'), JSON.parse(pwBlob)));
throws('and neither does the server key',
  () => VC.vaultDecrypt('server-dek', JSON.parse(pwBlob)));

// THE reason the salt is per-user. With one shared salt, a single precomputed
// table would cover every account in the app at once.
console.log('\nThe salt is per-backup, so one table cannot cover every user:');
const other = cheap('password');
check('two headers get different salts', other.salt !== pwHeader.salt);
check('the same password derives a DIFFERENT key under a different salt',
  BC.backupSecret(other, 'correct horse 9') !== pwSecret);

// ── recovery-key mode ─────────────────────────────────────────────────────
console.log('\n64-digit key mode round-trips:');
const keyHeader = cheap('key');
const rk = BC.generateRecoveryKey();
check('the generated key is 64 hex digits', /^[0-9a-f]{64}$/.test(rk), rk);
check('two keys are not the same', BC.generateRecoveryKey() !== BC.generateRecoveryKey());
const keyBlob = BC.stampE2EEHeader(VC.vaultEncrypt(BC.backupSecret(keyHeader, rk), BUNDLE), keyHeader);
check('the key opens the blob',
  VC.vaultDecrypt(BC.backupSecret(BC.readE2EEHeader(keyBlob), rk), JSON.parse(keyBlob)) === BUNDLE);

// A user reads the key back off a screen that groups it in fours; typing it in
// with those spaces must work, or the recovery path fails for the people who
// followed the instructions exactly.
const spaced = BC.formatRecoveryKey(rk);
check('the displayed key is grouped for transcription', spaced.includes(' '));
check('and the spaced form is accepted verbatim',
  VC.vaultDecrypt(BC.backupSecret(keyHeader, spaced), JSON.parse(keyBlob)) === BUNDLE);
check('as is an upper-case transcription',
  VC.vaultDecrypt(BC.backupSecret(keyHeader, spaced.toUpperCase()), JSON.parse(keyBlob)) === BUNDLE);
throws('a different key does not open it', () =>
  VC.vaultDecrypt(BC.backupSecret(keyHeader, BC.generateRecoveryKey()), JSON.parse(keyBlob)));
throws('a malformed key is rejected before any decrypt', () => BC.backupSecret(keyHeader, 'abc123'));

console.log('\nKey validation:');
check('rejects short input', BC.isValidRecoveryKey('abc') === false);
check('rejects non-hex', BC.isValidRecoveryKey('z'.repeat(64)) === false);
check('accepts the real thing', BC.isValidRecoveryKey(rk) === true);

// ── password rules ────────────────────────────────────────────────────────
// There is no server-side attempt limiting behind an e2ee backup, so the
// password's own entropy is the entire defence for anyone holding the blob.
console.log('\nPassword rules (the only defence against an offline guess):');
check('too short is refused', BC.passwordProblem('ab1') !== null);
check('letters-only is refused', BC.passwordProblem('abcdefghij') !== null);
check('digits-only is refused', BC.passwordProblem('1234567890') !== null);
check('a reasonable one passes', BC.passwordProblem('vaultchat99') === null);

// ── forward/backward compatibility ────────────────────────────────────────
// The header is additive precisely so a build that predates it still reads
// today's blobs. If this breaks, an older install restoring a newer backup
// fails on a file it could have opened.
console.log('\nThe envelope is additive, so old builds still read new blobs:');
const raw = JSON.parse(pwBlob);
check('v/iv/ct remain at the top level', raw.v === 1 && !!raw.iv && !!raw.ct);
check('an old reader ignoring vcE2EE still decrypts',
  VC.vaultDecrypt(pwSecret, { v: raw.v, iv: raw.iv, ct: raw.ct }) === BUNDLE);

rmSync(WORK, { recursive: true, force: true });
}

main().then(() => {
  console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}).catch((err) => {
  console.log('  ✗ harness threw:', err?.message ?? err);
  rmSync(WORK, { recursive: true, force: true });
  process.exit(1);
});
