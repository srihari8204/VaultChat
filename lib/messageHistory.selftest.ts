/**
 * lib/messageHistory.selftest.ts
 *   run with: npx tsx lib/messageHistory.selftest.ts
 *
 * The rule: the SERVER IS NOT THE WHOLE HISTORY. delete-on-delivery nulls a
 * delivered body, so any screen that builds a view from getMessages() alone
 * silently loses everything past the retention window — and if it caches that
 * result, it erases a view that was previously correct.
 *
 * That mistake shipped four separate times and was reported as four unrelated
 * bugs (empty media gallery, incomplete chat export, notes losing their oldest
 * entries, a blank shared-media strip). It is invisible in review because the
 * code looks obviously right. So it gets a test.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

let n = 0;
const ok = (label: string, cond: boolean) => { assert.ok(cond, label); n++; };

// Screens that legitimately talk to the server only. Each needs a reason.
const EXEMPT = new Map<string, string>([
  // Reads only the newest handful for a "latest announcement" chip; anything
  // old enough to be reclaimed is old enough not to be a highlight.
  ['app/family.tsx', 'recency-scoped highlight strip'],
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.expo', 'dist', 'android', 'ios'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.tsx')) out.push(p.split(path.sep).join('/'));
  }
  return out;
}

const offenders: string[] = [];
for (const file of walk('app')) {
  const src = fs.readFileSync(file, 'utf8');
  if (!/\bgetMessages\s*\(/.test(src)) continue;
  if (EXEMPT.has(file)) continue;
  // chat.tsx is the local-first surface itself — it reads localDb directly.
  if (/getCachedMessages|unionWithLocalHistory/.test(src)) continue;
  offenders.push(file);
}

ok(
  offenders.length === 0
    ? 'every screen reading message history also reads the local cache'
    : 'screens whose history stops at the retention window:\n      ' + offenders.join('\n      '),
  offenders.length === 0,
);

// The carve-out is the subtle half and the easiest to "simplify" away later.
const src = fs.readFileSync('lib/messageHistory.ts', 'utf8');
ok(
  'the union keeps a local body when the server reclaimed its own',
  /mine\.content\s*&&\s*!m\.content/.test(src),
);
ok('both orderings are exported', /unionWithLocalHistoryAsc/.test(src) && /unionWithLocalHistory\b/.test(src));

for (const [f] of EXEMPT) ok(`exempt file still exists: ${f}`, fs.existsSync(f));

console.log(`messageHistory.selftest: ${n} assertions passed, ${EXEMPT.size} documented exemption(s)`);
