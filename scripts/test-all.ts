#!/usr/bin/env node
// @ts-nocheck
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
// 'scripts' is here so acceptance.selftest.ts is actually discovered. It was
// written, passing, and silently not run by `npm test` — a suite nobody runs
// is a suite that quietly stops being true.
const SEARCH_DIRS = ['lib', 'services', 'utils', 'constants', 'db', 'hooks', 'components', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'android', 'ios', 'dist', 'rust', '__vectors__']);
// scripts/coldstart.ts matches the `require.main === module` idiom, but what it
// guards is a BENCHMARK, not a self-check: main() drives `adb`, force-stops the
// app on every attached handset and measures launch times. With no device it
// exits 1 ("no devices attached"), which is the right answer for a benchmark
// (npm run bench:coldstart) and a false failure for npm test. Its pure parsers
// are the part worth testing and they have their own suite,
// scripts/coldstart.selftest.ts, which this runner discovers and which passes —
// so skipping the CLI loses no coverage.
const SKIP_FILES = new Set([
  'scripts/audit-regression.ts',
  'scripts/test-all.ts',
  'scripts/coldstart.ts',
]);
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
    const posixRel = rel.split(path.sep).join('/');
    if (SKIP_FILES.has(posixRel)) continue;
    if (f.endsWith('.selftest.ts')) { suites.push({ rel, kind: 'selftest' }); continue; }
    let src = '';
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (src.includes('require.main === module')) suites.push({ rel, kind: 'embedded' });
  }
  return suites.sort((a, b) => a.rel.localeCompare(b.rel));
}

// Run tsx's CLI through THIS node binary rather than through node_modules/.bin.
// On Windows the extensionless `.bin/tsx` is a POSIX shell shim CreateProcess
// cannot execute (execFile failed instantly with no output — every suite was
// reported FAILED while each passed when run by hand), and since Node 20 the
// `.cmd` shim can only be spawned with shell:true, which then needs argument
// quoting. Resolving the CLI module sidesteps both, on every platform.
const tsxCli = require.resolve('tsx/cli');

function run(suite) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(process.execPath, [tsxCli, suite.rel], { cwd: ROOT, timeout: TIMEOUT_MS, maxBuffer: 16 << 20 },
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
    // Say WHY, when the why is the runtime rather than the code.
    //
    // The sqlite-backed suites do not fail here, they SEGFAULT (exit 139) or
    // die on an unknown builtin, and neither says anything about the cause.
    // Both come from one thing: better-sqlite3@13 declares `"node": ">=22"`
    // and node:sqlite only exists from 22.5, so on an older Node the prebuilt
    // N-API binary loads happily and then crashes the process the moment a
    // database is opened. Four suites reporting nothing is how that gets
    // mistaken for four broken tests.
    if (Number(process.versions.node.split('.')[0]) < 22) {
      console.log(`
  Node ${process.versions.node} is below the 22 this repo's tests need`);
      console.log('  (better-sqlite3@13 engines: node >=22; node:sqlite lands in 22.5).');
      console.log('  Any sqlite-backed suite above will crash rather than run until you upgrade.');
    }
    process.exit(1);
  }
  // The migrations/tests/*.sql suite lives outside this runner's world: it needs
  // a database, not tsx. Invoked here so `npm test` really does mean every test,
  // which is this file's whole premise. It SKIPS (exit 0) when the stack is not
  // up, so a developer without Docker is not blocked; CI sets MIGRATION_TESTS=1
  // to turn that skip into a failure.
  const mig = require('child_process').spawnSync(
    process.execPath, [tsxCli, path.join(__dirname, 'test-migrations.ts')],
    { stdio: 'inherit' },
  );
  if (mig.status !== 0) {
    console.log('\n  FAILED: migration tests');
    process.exit(1);
  }

  // The frozen backend contract (contract/endpoints.json + socket-events.json).
  // It is a pure static check — no database, no server — and it exists to catch
  // an endpoint or realtime event being dropped or renamed out from under the
  // shipped app.
  //
  // Wired in here because it was not wired in ANYWHERE, and had duly drifted:
  // three genuinely-new items were unfrozen, and the deriver had gone blind to
  // every relayToPeer() event (all WebRTC signalling, all VaultBeam signalling)
  // without anything noticing. A check nobody runs is not a check.
  console.log('\n  backend contract (endpoints + socket events)');
  const contract = require('child_process').spawnSync(
    process.execPath, ['contract/inventory.js'],
    { stdio: 'inherit', cwd: path.join(__dirname, '..', 'vaultchat-backend') },
  );
  if (contract.status !== 0) {
    console.log('\n  FAILED: backend contract drifted — review, then regenerate with:');
    console.log('    node vaultchat-backend/contract/inventory.js --write');
    process.exit(1);
  }

  // Generated protobuf codecs vs proto/ccwire/v1/*.proto.
  //
  // Same reasoning as the backend contract above: generated code that nobody
  // re-verifies becomes a THIRD definition that drifts, alongside the two
  // hand-written codecs it was added to reconcile. This regenerates into a
  // temp directory and byte-compares; it never writes into the repo.
  console.log('\n  protobuf codegen drift');
  const proto = require('child_process').spawnSync(
    process.execPath, [tsxCli, path.join(__dirname, 'proto-check.ts')],
    { stdio: 'inherit' },
  );
  if (proto.status !== 0) {
    console.log('\n  FAILED: generated protobuf is out of date — regenerate with:');
    console.log('    npm run proto:gen');
    process.exit(1);
  }

  console.log('\nALL SUITES PASSED ✓');
}

main().catch((e) => { console.error(e); process.exit(1); });
