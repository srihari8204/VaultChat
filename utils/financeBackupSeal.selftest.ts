// utils/financeBackupSeal.selftest.ts — run: npx tsx utils/financeBackupSeal.selftest.ts
//
// Round-trips a finance backup through the REAL lib/vaultCrypto +
// lib/backupCrypto envelope. As in lib/backupCrypto.selftest.ts, only the
// react-native-get-random-values polyfill import is stripped (Node has
// globalThis.crypto); the copies live inside the repo so @noble resolves.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const WORK = join(ROOT, `.selftest-financeseal-${process.pid}`);
const POLYFILL = /^import 'react-native-get-random-values';$/m;

mkdirSync(join(WORK, 'lib'), { recursive: true });
mkdirSync(join(WORK, 'utils'), { recursive: true });
writeFileSync(join(WORK, 'package.json'), '{"type":"module"}');
for (const f of ['lib/vaultCrypto.ts', 'lib/backupCrypto.ts', 'utils/financeBackupSeal.ts']) {
  const src = readFileSync(join(ROOT, f), 'utf8');
  if (f.startsWith('lib/')) assert.ok(POLYFILL.test(src), `could not strip the RN polyfill from ${f}`);
  writeFileSync(join(WORK, f), src.replace(POLYFILL, ''));
}

async function main() {
  const S: any = await import(pathToFileURL(join(WORK, 'utils', 'financeBackupSeal.ts')).href);
  const BC: any = await import(pathToFileURL(join(WORK, 'lib', 'backupCrypto.ts')).href);
  let n = 0;
  const ok = (label: string, cond: boolean) => { assert.ok(cond, label); n++; };
  const throws = async (label: string, fn: () => unknown, msg?: RegExp) => {
    let err: any = null;
    try { await fn(); } catch (e) { err = e; }
    ok(label, !!err && (!msg || msg.test(String(err?.message))));
  };

  const JSONTXT = JSON.stringify({ version: 1, ledgers: [{ id: 'L1', name: 'Ramesh', mobile: '9876543210' }], groups: [] });
  const cheap = { ...BC.newHeader('password'), iter: 1000 };   // fast; the real cost is asserted below

  const sealed = await S.sealFinanceBackup(JSONTXT, 'vault2026', cheap);
  ok('the sealed file does not contain the plaintext', !sealed.includes('Ramesh') && !sealed.includes('9876543210'));
  ok('it is recognised as sealed', S.isSealedFinanceBackup(sealed));
  ok('it round-trips with the right password', await S.openFinanceBackup(sealed, 'vault2026') === JSONTXT);
  await throws('a wrong password is refused, not decoded to garbage', () => S.openFinanceBackup(sealed, 'vault2025'), /WRONG_PASSWORD/);
  const tampered = JSON.stringify({ ...JSON.parse(sealed), ct: JSON.parse(sealed).ct.replace(/^./, (c: string) => (c === 'A' ? 'B' : 'A')) });
  await throws('a tampered file is refused', () => S.openFinanceBackup(tampered, 'vault2026'));

  // Old backups were plain JSON: they must still be recognised as NOT sealed,
  // so the restore path reads them exactly as before.
  ok('a plain (old) backup is not sealed', !S.isSealedFinanceBackup(JSONTXT));
  ok('garbage is not sealed', !S.isSealedFinanceBackup('not json'));
  await throws('opening a plain file as sealed is refused', () => S.openFinanceBackup(JSONTXT, 'x'));

  // Each file gets its own salt, at the shipping KDF cost.
  const real = BC.newHeader('password');
  ok('default header uses the shipping PBKDF2 cost', real.iter >= 210_000);
  ok('two headers get different salts', real.salt !== BC.newHeader('password').salt);
  await throws('a recovery-key header is refused for finance', () => S.sealFinanceBackup(JSONTXT, 'x', BC.newHeader('key')));
  ok('weak passwords are flagged', S.passwordProblem('abc') !== null && S.passwordProblem('vault2026') === null);

  // The async KDF is the same function: identical bytes to the sync one.
  const VC: any = await import(pathToFileURL(join(WORK, 'lib', 'vaultCrypto.ts')).href);
  const salt = new Uint8Array(16).fill(7);
  ok('pbkdf2BytesAsync derives exactly what pbkdf2Bytes does',
    Buffer.from(await VC.pbkdf2BytesAsync('pw', salt, 1000)).equals(Buffer.from(VC.pbkdf2Bytes('pw', salt, 1000))));
  ok('backupSecretAsync matches backupSecret', await BC.backupSecretAsync(cheap, 'vault2026') === BC.backupSecret(cheap, 'vault2026'));

  console.log(`financeBackupSeal selftest: ${n} assertions passed`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => rmSync(WORK, { recursive: true, force: true }));
