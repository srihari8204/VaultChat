#!/usr/bin/env node
/**
 * scripts/test-all.js — run every test in the repository.
 *
 * WHY THIS DISCOVERS INSTEAD OF LISTING
 * -------------------------------------
 * This project had 20 *.selftest.ts files and 17 modules carrying an embedded
 * `require.main === module` self-check — 37 entry points in total — and the npm
 * scripts invoked 12 of them. The other 25 were written, correct, and never run
 * by anybody. (Checked before writing this: all 25 still pass. Nothing had
 * rotted; they were simply dark.)
 *
 * A hand-maintained list would decay back into exactly that state the first time
 * someone adds a test and forgets the script entry. So this finds them:
 *
 *   1. every **\/*.selftest.ts
 *   2. every module whose source contains `require.main === module`, which is
 *      this codebase's established idiom for "runnable self-check" (see
 *      lib/icePriority.ts, lib/nav/geo.ts, lib/family/geofence.ts)
 *
 * A new test is therefore picked up by existing, not by remembering.
 *
 * Usage:  npm test            all suites
 *         npm test -- crypto  only paths matching a substring
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SEARCH_DIRS = ['lib', 'services', 'utils', 'constants', 'db', 'hooks', 'components'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'android', 'ios', 'dist', 'rust', '__vectors__']);
// tsx boots per process; this is the sweet spot between spawn overhead and
// oversubscribing CI runners.
const CONCURRENCY = Number(process.env.TEST_CONCURRENCY || 6);
const TIMEOUT_MS = 180_000;

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function discover() {
  const files = SEARCH_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
  const suites = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    if (f.endsWith('.selftest.ts')) { suites.push({ rel, kind: 'selftest' }); continue; }
    let src = '';
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (src.includes('require.main === module')) suites.push({ rel, kind: 'embedded' });
  }
  return suites.sort((a, b) => a.rel.localeCompare(b.rel));
}

const tsxBin = path.join(ROOT, 'node_modules', '.bin', 'tsx');

function run(suite) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(tsxBin, [suite.rel], { cwd: ROOT, timeout: TIMEOUT_MS, maxBuffer: 16 << 20 },
      (err, stdout, stderr) => {
        resolve({
          ...suite,
          ok: !err,
          ms: Date.now() - started,
          output: `${stdout}\n${stderr}`.trim(),
        });
      });
  });
}

async function main() {
  const filter = process.argv.slice(2).filter((a) => !a.startsWith('-'))[0];
  let suites = discover();
  if (filter) suites = suites.filter((s) => s.rel.includes(filter));

  if (!suites.length) {
    console.error(filter ? `no suites match "${filter}"` : 'no suites found');
    process.exit(1);
  }
  console.log(`Running ${suites.length} suite(s)${filter ? ` matching "${filter}"` : ''}, ${CONCURRENCY} at a time\n`);

  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, suites.length) }, async () => {
    while (next < suites.length) {
      const r = await run(suites[next++]);
      results.push(r);
      console.log(`  ${r.ok ? '✓' : '✗'} ${r.rel}  ${r.ms}ms${r.kind === 'embedded' ? '  (embedded)' : ''}`);
    }
  }));

  const failed = results.filter((r) => !r.ok);
  for (const f of failed) {
    console.log(`\n─── ${f.rel} ───\n${f.output.split('\n').slice(-25).join('\n')}`);
  }

  const bySort = (a, b) => a.rel.localeCompare(b.rel);
  console.log(`\n${'─'.repeat(56)}`);
  console.log(`  selftest suites: ${results.filter((r) => r.kind === 'selftest').length}`);
  console.log(`  embedded checks: ${results.filter((r) => r.kind === 'embedded').length}`);
  console.log(`  passed: ${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    console.log(`  FAILED: ${failed.sort(bySort).map((f) => f.rel).join(', ')}`);
    process.exit(1);
  }
  console.log('\nALL SUITES PASSED ✓');
}

main().catch((e) => { console.error(e); process.exit(1); });
