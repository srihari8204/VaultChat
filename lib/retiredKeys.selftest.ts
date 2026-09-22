// lib/retiredKeys.selftest.ts — run: npx tsx lib/retiredKeys.selftest.ts
//
// The check that makes the retired-key list safe to trust.
//
// A list of "keys nothing uses any more" is only as good as that claim. Get it
// wrong in the other direction — retire a key that live code still reads — and
// this does not fail loudly: it wipes working state on every launch, for
// everyone, and the feature simply forgets things. That is a far worse bug
// than the orphaned keys the list exists to clean up, so it gets a test that
// reads the source and proves the claim rather than restating it.

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { RETIRED_KEYS, purgeRetiredKeys } from './retiredKeys';

const ROOT = join(__dirname, '..');

let failed = 0;
function A(ok: boolean, what: string, detail?: string): void {
  if (ok) { console.log('  ok   ' + what); return; }
  failed++;
  console.log('  FAIL ' + what + (detail ? '  — ' + detail : ''));
}

console.log('\nretired storage keys\n');

// ── 1. the list itself is well formed ─────────────────────────────────
{
  A(RETIRED_KEYS.length > 0, '1. the list is not empty');
  const keys = RETIRED_KEYS.map(k => k.key);
  A(new Set(keys).size === keys.length, '1a. no key is listed twice',
    keys.filter((k, i) => keys.indexOf(k) !== i).join(', '));
  A(RETIRED_KEYS.every(k => k.key.trim().length > 0), '1b. no blank keys');
  A(RETIRED_KEYS.every(k => k.store === 'secure' || k.store === 'async'),
    '1c. every entry says which store holds it');
  // `why` is not decoration: the next reader decides whether deleting the key
  // is safe from it, and "" tells them nothing.
  A(RETIRED_KEYS.every(k => k.why.trim().length > 20),
    '1d. every entry explains what wrote it');
  A(RETIRED_KEYS.every(k => /^\d{4}-\d{2}-\d{2}$/.test(k.retired)),
    '1e. every entry carries the date its feature was removed');
}

// ── 2. THE ONE THAT MATTERS: no retired key is still in use ───────────
//
// Walks the source and fails if a retired key appears anywhere but this module
// and this test. If it does, the feature was not fully removed — or the key
// was never only that feature's — and purging it on launch would delete live
// state.
{
  const SKIP = new Set(['node_modules', '.git', 'android', 'ios', 'dist', '.expo', 'build']);
  const SELF = new Set(['retiredKeys.ts', 'retiredKeys.selftest.ts']);
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e)) continue;
      const p = join(dir, e);
      let s;
      try { s = statSync(p); } catch { continue; }
      if (s.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e) && !SELF.has(e)) files.push(p);
    }
  };
  for (const d of ['app', 'lib', 'components', 'services', 'constants', 'hooks', 'utils', 'db']) {
    walk(join(ROOT, d));
  }
  A(files.length > 100, '2. the scan actually found the source', `${files.length} files`);

  for (const { key } of RETIRED_KEYS) {
    const hits = files.filter(f => {
      try { return readFileSync(f, 'utf8').includes(key); } catch { return false; }
    });
    A(hits.length === 0, `2a. "${key}" is referenced by no live code`,
      hits.map(f => f.slice(ROOT.length + 1)).join(', '));
  }
}

// ── 3. the purge covers everything listed, and survives a hostile store ─
//
// Neither store exists under tsx, so every call throws — which is exactly the
// locked-device case. The function must swallow it and still report the full
// count, or a single SecureStore failure would skip the private key listed
// after it.
(async () => {
  const n = await purgeRetiredKeys();
  A(n === RETIRED_KEYS.length,
    '3. purge attempts every listed key even when both stores are unavailable',
    `attempted ${n}, listed ${RETIRED_KEYS.length}`);

  console.log(failed === 0 ? '\nretiredKeys: all checks passed' : `\nretiredKeys: ${failed} FAILED`);
  if (failed > 0) process.exit(1);
})();
