// Run: npx tsx lib/syncCursorRegression.selftest.ts
//
// Regression proof for lib/syncEngine.ts:282-304 — the durable sync high-water
// write. The bug being locked down: `noteGlobalSyncCursor` (localDb.ts:1156)
// gates on `Number.isFinite(id)` and RETURNS SILENTLY otherwise, so passing the
// RAW `r.nextSince` when the server sends it as a JSON string makes the durable
// write a permanent no-op and sync re-derives from MAX(id) every launch.
//
// Nothing here is mocked at the boundary under test:
//   * the cursor block is LIFTED OUT of syncEngine.ts source, not retyped, so it
//     rots the moment that code changes shape;
//   * noteGlobalSyncCursor / getGlobalSyncCursor / getMeta are the real
//     localDb.ts functions, compiled and run against a real on-disk SQLite
//     (node:sqlite), same loader pattern as lib/localDb.pending.selftest.ts.
//
// The "prior behaviour" arm is produced by rewriting the lifted source back to
// `noteGlobalSyncCursor(r.nextSince)`, so the before/after is the one-token diff
// the patch actually made — not two hand-written functions that might differ.

import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'vc-synccursor-'));
const file = join(dir, 'cache.db');
const requireHere = createRequire(import.meta.url);

// ── the real localDb, against a real SQLite ──────────────────────────────
const compiled = ts.transpileModule(readFileSync(new URL('./localDb.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const sqlite = new DatabaseSync(file);
const execute = (sql: string, params: any[] = []) => {
  const statement = sqlite.prepare(sql);
  if (statement.columns().length) return { rows: statement.all(...params) };
  const result = statement.run(...params);
  return { rows: [], rowsAffected: result.changes, insertId: result.lastInsertRowid };
};
const cache = (() => {
  const exports = {} as typeof import('./localDb');
  new Function('require', 'exports', compiled)((name: string) => {
    if (name === '@op-engineering/op-sqlite') return { open: () => ({ execute, executeSync: execute }) };
    if (name === '@react-native-async-storage/async-storage') return {};
    if (name === 'expo-secure-store') return { getItemAsync: async () => 'ab'.repeat(32) };
    if (name === './cacheCrypto') {
      return { encField: (s: any) => s, decField: (s: any) => s, clearCacheKeyStore: async () => {} };
    }
    return requireHere(name);
  }, exports);
  return exports;
})();

const CURSOR_KEY = 'vc_global_sync_cursor';

// ── the cursor block, lifted out of syncEngine.ts ────────────────────────
const ENGINE = readFileSync(new URL('./syncEngine.ts', import.meta.url), 'utf8');
const start = ENGINE.indexOf('const nextSince = Number(r.nextSince);');
const end = ENGINE.indexOf('\n', ENGINE.indexOf('await noteGlobalSyncCursor(', start));
if (start < 0 || end < 0) {
  throw new Error('selftest: cursor block not found in syncEngine.ts — was it renamed or restructured?');
}
const BLOCK = ENGINE.slice(start, end);
assert.match(BLOCK, /await noteGlobalSyncCursor\(nextSince\);/,
  'syncEngine.ts must pass the VALIDATED local `nextSince`, never the raw `r.nextSince`');

type Page = { nextSince: unknown; syncContinuation?: string | null };
function arm(source: string) {
  const body = `let syncContinuation = null;\n${source}\nreturn since;`;
  const fn = new Function('r', 'since', 'COLD_KEY', 'setMeta', 'noteGlobalSyncCursor',
    `return (async () => {\n${body}\n})();`) as
    (r: Page, since: number, k: string, sm: unknown, ng: unknown) => Promise<number>;
  return (r: Page, since: number) =>
    fn(r, since, 'vc_cold_sync_continuation', cache.setMeta, cache.noteGlobalSyncCursor);
}
const patched = arm(BLOCK);
const prior = arm(BLOCK.replace('noteGlobalSyncCursor(nextSince)', 'noteGlobalSyncCursor(r.nextSince)'));

const reset = (v = 0) => cache.setMeta(CURSOR_KEY, String(v));
const stored = async () => Number(await cache.getMeta(CURSOR_KEY));

async function main() {
  // ── 1. the case the patch fixes: a STRING nextSince ────────────────────
  await reset(100);
  await prior({ nextSince: '500' }, 100);
  assert.equal(await stored(), 100,
    'PRIOR BEHAVIOUR: a string nextSince is silently dropped — the durable write is a no-op');
  assert.equal(await cache.getGlobalSyncCursor(), 100,
    'PRIOR BEHAVIOUR: next launch re-syncs from the stale mark (in-app it re-derives from MAX(id))');

  await reset(100);
  const after = await patched({ nextSince: '500' }, 100);
  assert.equal(await stored(), 500, 'PATCHED: the coerced local persists the string page');
  assert.equal(after, 500, 'PATCHED: the in-memory loop cursor and the durable one agree');
  assert.equal(await cache.getGlobalSyncCursor(), 500);

  // ── 2. numeric nextSince: unchanged by the patch, both arms agree ──────
  for (const [name, run] of [['prior', prior], ['patched', patched]] as const) {
    await reset(100);
    await run({ nextSince: 900 }, 100);
    assert.equal(await stored(), 900, `${name}: a numeric nextSince always persisted`);
  }

  // ── 3. values that must NOT advance the cursor (the existing check) ────
  const rejected: Array<[string, unknown]> = [
    ['equal to since', 400],
    ['equal to since as a string', '400'],
    ['behind since', 399],
    ['negative', -1],
    ['zero', 0],
    ['non-numeric string', 'abc'],
    ['null', null],
    ['undefined', undefined],
    ['NaN', NaN],
    ['empty string', ''],          // Number('') === 0 — caught by <= since, not by isFinite
    ['Infinity via 1e999', '1e999'],
    ['-Infinity', -Infinity],
    ['object', { id: 500 }],
  ];
  for (const [name, nextSince] of rejected) {
    await reset(400);
    await assert.rejects(patched({ nextSince } as Page, 400), /cursor did not advance/,
      `must throw on ${name}`);
    assert.equal(await stored(), 400, `cursor untouched after ${name}`);
  }

  // ── 4. zero is a VALID resting state, just not a valid write ───────────
  await reset(0);
  assert.equal(await cache.getGlobalSyncCursor(), 0, 'a fresh device legitimately sits at 0');
  await patched({ nextSince: 1 }, 0);
  assert.equal(await stored(), 1, 'first page off a zero cursor persists');

  // ── 5. monotonicity: the durable mark never moves backwards ────────────
  await reset(1000);
  await cache.noteGlobalSyncCursor(900);
  assert.equal(await stored(), 1000, 'noteGlobalSyncCursor is monotonic');

  // ── 6. out-of-range / unsafe values — THE HOLES ARE NOW CLOSED ─────────
  //
  // This section used to DOCUMENT what `Number.isFinite && > since` let
  // through. The fix landed (syncEngine.ts now uses Number.isSafeInteger), so
  // these are assertions, not documentation: every one must be REFUSED, and
  // the durable mark must not move.
  //
  // Each case is a real failure mode that reached SQLite before the fix:
  //   '123.5'            wrote a fractional cursor; the next request became
  //                      `?since=123.4`
  //   '9007199254740995' rounded UP to ...996 — the monotonic high-water mark
  //                      moved PAST an id never delivered, skipping that
  //                      message permanently, on every future launch
  //   1e21               wrote a mark that suppresses all future delta rows
  const refused = async (v: unknown, why: string) => {
    await reset(100);
    await assert.rejects(() => patched({ nextSince: v }, 100), /did not advance/, why);
    assert.equal(await stored(), 100, `${why}: the durable mark must not move`);
  };

  await refused('123.5', 'a fractional cursor is refused');
  await refused('9007199254740995', 'an unsafe id that rounds UP is refused (the skip case)');
  await refused('9007199254740993', 'an unsafe id that rounds DOWN is refused');
  await refused(1e21, 'an absurd magnitude is refused');
  await refused('1e999', 'Infinity is refused');

  // The whole legitimate range still works, including the exact boundary.
  await reset(100);
  await patched({ nextSince: String(Number.MAX_SAFE_INTEGER) }, 100);
  assert.equal(await stored(), Number.MAX_SAFE_INTEGER,
    'the largest exactly-representable id is still accepted');

  // ── 7. the minimal fix, applied to the same inputs ─────────────────────
  // Number.isSafeInteger rejects every case in §6 and accepts every case the
  // engine legitimately needs. Proven here, NOT applied to syncEngine.ts.
  const ok = (v: unknown, since: number) => {
    const n = Number(v);
    return Number.isSafeInteger(n) && n > since;
  };
  assert.equal(ok('123.5', 100), false, 'fix rejects fractional');
  assert.equal(ok('9007199254740995', 100), false, 'fix rejects the rounding-up unsafe id');
  assert.equal(ok('9007199254740993', 100), false, 'fix rejects the rounding-down unsafe id');
  assert.equal(ok(1e21, 100), false, 'fix rejects absurd magnitudes');
  assert.equal(ok('1e999', 100), false, 'fix rejects Infinity');
  assert.equal(ok('500', 100), true, 'fix still accepts the string page the patch fixed');
  assert.equal(ok(900, 100), true, 'fix still accepts a numeric page');
  assert.equal(ok(Number.MAX_SAFE_INTEGER, 100), true, 'fix accepts the whole usable id range');

  // ── 8. processing order: rows are durable BEFORE any cursor state ──────
  // syncEngine.ts:269 `await applyByChat(...)` → :116 `await cacheMessages(...)`
  // all complete before :282-304 touch the cursor or the cold-policy token.
  const loop = ENGINE.slice(ENGINE.indexOf('const msgs = r?.messages ?? [];'), end);
  const at = (needle: string) => {
    const i = loop.indexOf(needle);
    assert.ok(i >= 0, `selftest: "${needle}" gone from the sync loop`);
    return i;
  };
  assert.ok(at('await applyByChat(msgs, owner)') < at('const nextSince = Number(r.nextSince)'),
    'rows are applied before the cursor is even computed');
  const COLD_WRITE = "await setMeta(COLD_KEY, syncContinuation ?? '')";
  assert.ok(at('const nextSince = Number(r.nextSince)') < at(COLD_WRITE),
    'the cursor is validated before the cold-policy token is written');
  assert.ok(at(COLD_WRITE) < at('await noteGlobalSyncCursor('),
    'cold-policy token is durable before the numeric high-water advances');
  assert.match(ENGINE.slice(ENGINE.indexOf('let hydrated: typeof todo;'), ENGINE.indexOf('return byChat;')),
    /await cacheMessages\(chatId, hydrated\);/,
    'applyByChat awaits the durable row write it is trusted for');

  console.log('sync cursor regression: string/numeric/invalid/zero/unsafe/non-advancing cases passed '
    + 'against real SQLite; §6 asserts the isSafeInteger holes are CLOSED, §7 pins the predicate');
}

main().finally(() => { sqlite.close(); rmSync(dir, { recursive: true, force: true }); })
  .catch(e => { console.error(e); process.exitCode = 1; });
