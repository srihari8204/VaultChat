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
  const throws = (label: string, fn: () => unknown, msg?: RegExp) => {
    let err: any = null;
    try { fn(); } catch (e) { err = e; }
    ok(label, !!err && (!msg || msg.test(String(err?.message))));
  };

  const JSONTXT = JSON.stringify({ version: 1, ledgers: [{ id: 'L1', name: 'Ramesh', mobile: '9876543210' }], groups: [] });
  const cheap = { ...BC.newHeader('password'), iter: 1000 };   // fast; the real cost is asserted below

  const sealed = S.sealFinanceBackup(JSONTXT, 'vault2026', cheap);
  ok('the sealed file does not contain the plaintext', !sealed.includes('Ramesh') && !sealed.includes('9876543210'));
  ok('it is recognised as sealed', S.isSealedFinanceBackup(sealed));
  ok('it round-trips with the right password', S.openFinanceBackup(sealed, 'vault2026') === JSONTXT);
  throws('a wrong password is refused, not decoded to garbage', () => S.openFinanceBackup(sealed, 'vault2025'), /WRONG_PASSWORD/);
  const tampered = JSON.stringify({ ...JSON.parse(sealed), ct: JSON.parse(sealed).ct.replace(/^./, (c: string) => (c === 'A' ? 'B' : 'A')) });
  throws('a tampered file is refused', () => S.openFinanceBackup(tampered, 'vault2026'));

  // Old backups were plain JSON: they must still be recognised as NOT sealed,
  // so the restore path reads them exactly as before.
  ok('a plain (old) backup is not sealed', !S.isSealedFinanceBackup(JSONTXT));
  ok('garbage is not sealed', !S.isSealedFinanceBackup('not json'));
  throws('opening a plain file as sealed is refused', () => S.openFinanceBackup(JSONTXT, 'x'));

  // Each file gets its own salt, at the shipping KDF cost.
  const real = BC.newHeader('password');
  ok('default header uses the shipping PBKDF2 cost', real.iter >= 210_000);
  ok('two headers get different salts', real.salt !== BC.newHeader('password').salt);
  throws('a recovery-key header is refused for finance', () => S.sealFinanceBackup(JSONTXT, 'x', BC.newHeader('key')));
  ok('weak passwords are flagged', S.passwordProblem('abc') !== null && S.passwordProblem('vault2026') === null);

  console.log(`financeBackupSeal selftest: ${n} assertions passed`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => rmSync(WORK, { recursive: true, force: true }));
