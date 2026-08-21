#!/usr/bin/env node
/**
 * scripts/test-migrations.js — run every migrations/tests/*.sql against the
 * live schema.
 *
 * WHY THIS EXISTS
 * ---------------
 * There are nine of these files (083, 085, 086, 087, 092, 093, 095, 110, 111)
 * and until now NOTHING RAN THEM. Each carries a `docker exec … psql` line in
 * its own header, which is a note to a human, not a gate. They encode the
 * guarantees only the database can make — a walk-in khata with no account, an
 * invoice that refuses to be rewritten, a shop that can still be deleted after
 * that refusal — and a constraint that has never been fired is a guess.
 *
 * Discovery, not a list, for the same reason scripts/test-all.js discovers: a
 * hand-maintained list decays the first time someone adds a test and forgets
 * the entry.
 *
 * SAFETY
 * ------
 * Every one of these scripts wraps its work in BEGIN … ROLLBACK, so they leave
 * no residue. This runner additionally REFUSES TO RUN unless the target really
 * is the expected container and database — the point of a test that writes to a
 * shared database is that it writes nothing, and that promise is worth checking
 * before the first statement rather than after.
 *
 * It never creates a database and never runs a migration; it only runs tests.
 *
 * Usage:  npm run test:migrations
 *         npm run test:migrations -- 111      only paths matching a substring
 *
 * Exit code is non-zero on the FIRST failure, and the failing file is named.
 * If Docker or the database is unreachable the run SKIPS with exit 0, so a
 * developer without the stack up is not blocked — CI sets MIGRATION_TESTS=1 to
 * turn that skip into a failure.
 */
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TESTS_DIR = path.join(ROOT, 'vaultchat-backend', 'migrations', 'tests');

// The one target these tests are written against, as CONSTANTS. The env vars
// below may only ever move the run AWAY from this, and doing so demands an
// explicit acknowledgement — otherwise the guard is tautological: comparing the
// database we reached against the database we asked for always agrees, and the
// run proceeds happily against whatever was named. (It did, once, before this
// was fixed: MIGRATION_TEST_DB=postgres ran 083 against the postgres database.)
const EXPECTED_CONTAINER = 'vaultchat-postgres-1';
const EXPECTED_DB = 'vaultchat';

const CONTAINER = process.env.MIGRATION_TEST_CONTAINER || EXPECTED_CONTAINER;
const DB = process.env.MIGRATION_TEST_DB || EXPECTED_DB;
const DB_USER = process.env.MIGRATION_TEST_USER || 'vaultchat';
const REQUIRED = process.env.MIGRATION_TESTS === '1';
const ALLOW_OTHER = process.env.MIGRATION_TEST_ALLOW_OTHER_TARGET === '1';

const filter = process.argv.slice(2).filter((a) => !a.startsWith('-'));

function skip(why) {
  if (REQUIRED) {
    console.error(`\n  migration tests REQUIRED but unavailable: ${why}`);
    process.exit(1);
  }
  console.log(`\n  skipped: ${why}`);
  console.log('  (set MIGRATION_TESTS=1 to make this a failure instead)');
  process.exit(0);
}

// ── the target is what we think it is ────────────────────────────────
function verifyTarget() {
  // Refuse BEFORE connecting if the requested target is not the sanctioned one.
  if ((CONTAINER !== EXPECTED_CONTAINER || DB !== EXPECTED_DB) && !ALLOW_OTHER) {
    console.error(`\n  REFUSING TO RUN: target is ${CONTAINER}/${DB},`
      + ` expected ${EXPECTED_CONTAINER}/${EXPECTED_DB}.`);
    console.error('  These tests write to a shared database and rely on it being'
      + ' the one they were written against.');
    console.error('  Set MIGRATION_TEST_ALLOW_OTHER_TARGET=1 if you really mean it.');
    process.exit(1);
  }

  const probe = spawnSync('docker', [
    'exec', CONTAINER, 'psql', '-U', DB_USER, '-d', DB, '-tAc',
    'SELECT current_database() || $$|$$ || current_user',
  ], { encoding: 'utf8' });

  if (probe.status !== 0) {
    skip(`cannot reach ${CONTAINER}/${DB} — ${(probe.stderr || '').trim().split('\n')[0]}`);
  }
  const [db, user] = String(probe.stdout).trim().split('|');
  if (db !== DB) {
    console.error(`\n  REFUSING TO RUN: connected to database "${db}", expected "${DB}"`);
    process.exit(1);
  }
  return { db, user };
}

function discover() {
  let names;
  try {
    names = fs.readdirSync(TESTS_DIR).filter((f) => f.endsWith('.sql'));
  } catch {
    skip(`no ${path.relative(ROOT, TESTS_DIR)} directory`);
  }
  names.sort(); // numeric prefixes make lexical order the migration order
  return names
    .map((f) => path.join(TESTS_DIR, f))
    .filter((p) => !filter.length || filter.some((s) => p.includes(s)));
}

function run(file) {
  const sql = fs.readFileSync(file);
  return spawnSync('docker', [
    'exec', '-i', CONTAINER, 'psql', '-U', DB_USER, '-d', DB,
    '-v', 'ON_ERROR_STOP=1', '-f', '-',
  ], { input: sql, encoding: 'utf8' });
}

// ── main ─────────────────────────────────────────────────────────────
const target = verifyTarget();
const files = discover();
if (!files.length) skip('no migration tests matched');

console.log(`\n  migration tests → ${CONTAINER}/${target.db} as ${target.user}`);
console.log(`  ${files.length} file(s)\n`);

let passed = 0;
for (const file of files) {
  const name = path.basename(file);
  const started = Date.now();
  const res = run(file);
  const ms = Date.now() - started;

  if (res.status === 0) {
    passed++;
    console.log(`  PASS  ${name}  (${ms}ms)`);
    continue;
  }

  // Fail immediately and say which file and which statement. psql's own error
  // line is the useful part; the surrounding transcript is noise.
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  const detail = out
    .split('\n')
    .filter((l) => /ERROR|FATAL|psql:/.test(l))
    .slice(0, 6)
    .join('\n      ');
  console.error(`  FAIL  ${name}  (${ms}ms)`);
  console.error(`      ${detail || out.trim().split('\n').slice(-5).join('\n      ')}`);
  console.error(`\n  ${passed} passed, then ${name} FAILED. Stopping.`);
  process.exit(1);
}

console.log(`\n  ${passed}/${files.length} migration tests passed\n`);
