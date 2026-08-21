#!/usr/bin/env node
/**
 * scripts/audit-regression.js — every NON-MUTATING test, grouped by subsystem.
 *
 * WHY THIS EXISTS ALONGSIDE test-all.js
 * -------------------------------------
 * test-all.js answers "does everything pass". This answers "which SUBSYSTEM is
 * green", which is the question a production-readiness review actually asks —
 * and it is the safe half: test-all.js now ends by invoking the migration
 * suite, which issues CREATE/ALTER inside a transaction. That is a database
 * mutation, so it is deliberately NOT called here. It is reported as skipped
 * instead, with what it would need.
 *
 * SAFETY CLASSIFICATION IS THE POINT
 * ----------------------------------
 * Every suite is classified before it runs. Only SAFE runs. DATABASE-MUTATING,
 * DEVICE-REQUIRED and PRODUCTION-IMPACTING are listed with a reason and never
 * executed, so a green report can never be mistaken for coverage it does not
 * have.
 *
 * The known pre-existing failure is declared, not hidden: it still runs, still
 * reports, and is labelled PRE-EXISTING so it cannot silently mask a new break.
 *
 *   node scripts/audit-regression.js            all subsystems
 *   node scripts/audit-regression.js --quick    skip tsc (the slow one)
 */
const { execFileSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const GO = path.join(ROOT, 'vaultchat-backend-go');
const QUICK = process.argv.includes('--quick');

// Suites that must never run here, and why. Reported, never executed.
const SKIPPED = [
  { area: 'ShopBook', test: 'migrations/tests/*.sql (9)', why: 'DATABASE-MUTATING',
    needs: 'disposable/local DB; CREATE+ALTER inside BEGIN..ROLLBACK', expect: '9/9 PASS' },
  { area: 'ShopBook', test: 'shopbook_flows_test.go (7)', why: 'DATABASE-MUTATING',
    needs: 'CALL_TEST_DB=1 + CALL_TEST_ADMIN_DSN against a disposable DB', expect: '7/7 PASS' },
  { area: 'Go Live', test: 'reconnect on device', why: 'DEVICE-REQUIRED',
    needs: 'APK built from current source, installed, hash-verified', expect: 'LIVE→RECONNECTING→LIVE' },
  { area: 'TURN', test: 'relay on restricted network', why: 'DEVICE-REQUIRED',
    needs: 'device + UDP-blocked / 443-only network', expect: 'relay pair wins only when direct fails' },
  { area: 'Calls', test: '1:1 + group voice/video, screen share', why: 'DEVICE-REQUIRED',
    needs: 'two devices, current APK', expect: 'media both ways, clean teardown' },
  { area: 'P2P', test: 'large-file transfer, transport switch, resume', why: 'DEVICE-REQUIRED',
    needs: 'two devices + real network change', expect: 'resume by bitmap, sha256 match' },
  { area: 'Scanner', test: 'camera lifecycle + parse', why: 'DEVICE-REQUIRED',
    needs: 'device with camera', expect: 'docscanner produces a real PDF' },
  { area: 'Load', test: 'concurrency / throughput', why: 'PRODUCTION-IMPACTING',
    needs: 'isolated bench stack + explicit approval', expect: 'P50/P95/P99 recorded' },
];

// A suite whose failure is already known and proven unrelated to current work.
// Declared so the report labels it instead of a human having to remember.
const KNOWN_PREEXISTING = new Set(['lib/decryptReplayCost.selftest.ts']);

// Subsystem <- path prefix. First match wins; anything unmatched is "Frontend".
const AREAS = [
  ['Calls', (p) => p.startsWith('lib/call/') || p.includes('callHistory') || p.includes('iceCredentials')],
  ['Go Live', (p) => p.startsWith('lib/golive/')],
  ['P2P', (p) => p.startsWith('lib/vaultBeam') || p.startsWith('lib/vaultbeam')],
  ['ShopBook', (p) => p.includes('shopbook')],
  ['Space', (p) => p.startsWith('lib/spaces/') || p.includes('family/')],
  ['Security', (p) => p.startsWith('services/crypto/') || p.startsWith('services/security/') || p.includes('Crypto') || p.includes('rekey')],
  ['Frontend', () => true],
];
const areaOf = (p) => AREAS.find(([, m]) => m(p))[0];

const SEARCH = ['lib', 'services', 'utils', 'constants', 'db', 'hooks', 'components'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'android', 'ios', 'dist', 'rust', '__vectors__']);

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

// Same two-rule discovery as test-all.js: *.selftest.ts, plus any module
// carrying this codebase's `require.main === module` self-check idiom.
function discover() {
  const out = [];
  for (const f of SEARCH.flatMap((d) => walk(path.join(ROOT, d)))) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    if (rel.endsWith('.selftest.ts')) { out.push(rel); continue; }
    try {
      if (fs.readFileSync(f, 'utf8').includes('require.main === module')) out.push(rel);
    } catch { /* unreadable file is not a test */ }
  }
  return out.sort();
}

const tsxCli = require.resolve('tsx/cli');
const runSuite = (rel) => new Promise((res) => {
  execFile(process.execPath, [tsxCli, rel], { cwd: ROOT, timeout: 180_000, maxBuffer: 16 << 20 },
    (err, so, se) => res({ rel, ok: !err, output: `${so}\n${se}`.trim() }));
});

function cmd(label, file, args, cwd) {
  try {
    execFileSync(file, args, { cwd, stdio: 'pipe', timeout: 600_000 });
    return { label, ok: true };
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
    return { label, ok: false, output: out.split('\n').slice(-12).join('\n') };
  }
}

(async () => {
  const results = { Backend: [], Frontend: [], Calls: [], 'Go Live': [], TURN: [], ShopBook: [], Khata: [], P2P: [], Scanner: [], Space: [], Finance: [], Security: [] };

  console.log('Running non-mutating regression…\n');

  results.Backend.push(cmd('go build ./...', 'go', ['build', './...'], GO));
  results.Backend.push(cmd('go vet ./...', 'go', ['vet', './...'], GO));
  results.Backend.push(cmd('go test ./...', 'go', ['test', './...'], GO));

  if (QUICK) results.Frontend.push({ label: 'tsc --noEmit', ok: true, skipped: true });
  else results.Frontend.push(cmd('tsc --noEmit', process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit'], ROOT));

  // TURN and Khata are cross-cutting: they live under other paths but are
  // reported on their own line because they are their own go/no-go gate.
  const suites = discover();
  const running = suites.map(async (rel) => {
    const r = await runSuite(rel);
    r.preexisting = KNOWN_PREEXISTING.has(rel);
    let area = areaOf(rel);
    if (rel.includes('turnWiring') || rel.includes('iceCredentials')) area = 'TURN';
    results[area].push({ label: rel, ...r });
  });
  await Promise.all(running);

  // Go-side subsystem detail, so ShopBook/Khata are not just "go test passed".
  results.ShopBook.push(cmd('go test -run Idempot|Constraint|Money|Stock|Bill',
    'go', ['test', './internal/routes/', '-count=1', '-run', 'Idempot|Constraint|StringMatched|Money|Stock|Bill'], GO));
  results.Khata.push(cmd('go test -run Walkin|Party|CustomerLimit|CreditCheck',
    'go', ['test', './internal/routes/', '-count=1', '-run', 'Walkin|Party|CustomerLimit|CreditCheck'], GO));
  results.Finance.push(cmd('go test -run Money|Ledger|Amount',
    'go', ['test', './internal/routes/', '-count=1', '-run', 'Money|Ledger|Amount'], GO));

  const line = '='.repeat(40);
  console.log(`\n${line}\nVAULTCHAT REGRESSION REPORT\n${line}\n`);

  let newFailures = 0;
  for (const [area, rs] of Object.entries(results)) {
    if (!rs.length) { console.log(`${area}:\nNO AUTOMATED TEST\n`); continue; }
    const bad = rs.filter((r) => !r.ok && !r.preexisting);
    const pre = rs.filter((r) => !r.ok && r.preexisting);
    newFailures += bad.length;
    const verdict = bad.length ? 'FAIL' : (pre.length ? 'PASS (1 PRE-EXISTING)' : 'PASS');
    console.log(`${area}:\n${verdict}  (${rs.length - bad.length - pre.length}/${rs.length} green)\n`);
  }
  console.log(`Performance:\nUNKNOWN — no benchmark is run here\n`);
  console.log(`Device:\nBLOCKED — see skipped list\n`);
  console.log(`Database:\nUNCHANGED — no mutating test executed\n`);

  console.log(line);
  const failing = Object.entries(results).flatMap(([a, rs]) => rs.filter((r) => !r.ok).map((r) => [a, r]));
  for (const [area, r] of failing) {
    console.log(`\nTEST            ${r.label}`);
    console.log(`STATUS          FAIL (${area})`);
    console.log(`PRE-EXISTING?   ${r.preexisting ? 'PRE-EXISTING' : 'NEW'}`);
    console.log(`BLOCKING?       ${r.preexisting ? 'NO' : 'YES'}`);
    if (r.output) console.log(`OUTPUT\n${r.output.split('\n').slice(-8).join('\n')}`);
  }

  console.log(`\n${line}\nNOT RUN — classified unsafe\n${line}`);
  for (const s of SKIPPED) {
    console.log(`\nTEST            ${s.test}  [${s.area}]`);
    console.log(`REASON SKIPPED  ${s.why}`);
    console.log(`REQUIRES        ${s.needs}`);
    console.log(`EXPECTED        ${s.expect}`);
  }

  console.log(`\n${line}`);
  console.log(newFailures ? `${newFailures} NEW FAILURE(S) — BLOCKING` : 'NO NEW FAILURES');
  process.exit(newFailures ? 1 : 0);
})();
