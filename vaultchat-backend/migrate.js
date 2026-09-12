#!/usr/bin/env node
// VaultChat migration runner — idempotent, ledgered, one transaction per file.
//
// Replaces the old "apply each migrations/NNN_*.sql by hand via psql" flow,
// which had no record of what was applied and no rollback on a bad file.
//
// Reads DB_* from .env (same config the app uses — db.js). Whatever DB your
// .env points at is the DB this touches. In this repo .env points at
// 127.0.0.1:15432, which is the SSH tunnel to the Hetzner PRODUCTION
// Postgres — so `up`/`baseline` against the default env mutate production.
// `status` is read-only and safe.
//
// Commands:
//   node migrate.js status          Show applied vs pending. Read-only.
//   node migrate.js baseline 009    Record 001..009 as already-applied
//                                   WITHOUT executing them. Run ONCE on a DB
//                                   that already has those tables (i.e. prod,
//                                   which is at 009) to seed the ledger.
//   node migrate.js up              Apply every pending migration in order.
//   node migrate.js up --to 023     Apply pending migrations up to & incl. 023.
//
// Each `up` file runs inside its own BEGIN/COMMIT; a failure rolls that file
// back and stops the run, leaving the ledger consistent with what committed.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const MIG_DIR = path.join(__dirname, 'migrations');

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'vaultchat',
  user: process.env.DB_USER || 'vaultchat_app',
  password: process.env.DB_PASS || '',
  max: 4,
  connectionTimeoutMillis: 8000,
});

const listFiles = () =>
  fs.readdirSync(MIG_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
const versionOf = (file) => file.match(/^(\d+)_/)[1]; // zero-padded, so string compare is correct
// Line endings are normalised BEFORE hashing.
//
// Without this the same migration hashes differently depending on the machine:
// git checks these files out with CRLF on Windows and LF on Linux, so a ledger
// written by CI reports every single migration as drifted when verified from a
// Windows checkout. Observed exactly that — 80 of 81 files "drifted", all of
// them purely CRLF, which is enough noise to hide the one real mismatch.
const checksum = (text) =>
  crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);

async function ledgerExists(client) {
  const r = await client.query(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ok`
  );
  return r.rows[0].ok;
}
async function ensureLedger(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      filename   TEXT        NOT NULL,
      checksum   TEXT        NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
}
async function appliedSet(client) {
  if (!(await ledgerExists(client))) return new Set();
  const r = await client.query('SELECT version FROM schema_migrations');
  return new Set(r.rows.map((x) => x.version));
}

/**
 * Compare every applied migration against the file on disk.
 *
 * The ledger recorded checksums from the start but nothing ever verified them,
 * so an edit to an already-applied migration went unnoticed indefinitely — the
 * exact thing the column exists to catch. A checksum nobody checks is
 * decoration.
 *
 * Returns the mismatches; the caller decides whether to warn or refuse.
 */
async function verifyChecksums(client) {
  if (!(await ledgerExists(client))) return [];
  const r = await client.query('SELECT version, filename, checksum FROM schema_migrations ORDER BY version');
  const drift = [];
  for (const row of r.rows) {
    const p = path.join(MIG_DIR, row.filename);
    if (!fs.existsSync(p)) { drift.push({ ...row, actual: null }); continue; }
    const actual = checksum(fs.readFileSync(p, 'utf8'));
    if (actual !== row.checksum) drift.push({ ...row, actual });
  }
  return drift;
}

function reportDrift(drift) {
  console.error(`\n  ${drift.length} applied migration(s) NO LONGER MATCH the file on disk:\n`);
  for (const d of drift) {
    console.error(d.actual === null
      ? `   ${d.filename}  — FILE IS MISSING (recorded ${d.checksum})`
      : `   ${d.filename}  recorded ${d.checksum}  now ${d.actual}`);
  }
  console.error(`
  An applied migration must never be edited: the database already ran the old
  text, so the file no longer describes what is deployed and a fresh environment
  built from these files will diverge from production.

  If the change was genuinely cosmetic (a comment) and the SQL is byte-identical,
  confirm it and then re-record the checksum:

     diff <(git show <commit>^:<path> | grep -vE '^\\s*--|^\\s*$') \\
          <(grep -vE '^\\s*--|^\\s*$' <path>)

     UPDATE schema_migrations SET checksum = '<new>' WHERE version = '<nnn>';

  Otherwise revert the file and write a NEW migration instead.
`);
}

async function cmdStatus() {
  const client = await pool.connect();
  try {
    const present = await ledgerExists(client);
    const applied = await appliedSet(client);
    const files = listFiles();
    console.log(`\n  ledger:        ${present ? 'present' : 'NOT INITIALIZED'}`);
    console.log(`  migrations:    ${files.length} files in ${path.relative(process.cwd(), MIG_DIR)}\n`);
    for (const f of files) {
      console.log(`   ${applied.has(versionOf(f)) ? '✓ applied' : '· pending'}  ${f}`);
    }
    const pending = files.filter((f) => !applied.has(versionOf(f)));
    console.log(`\n  ${pending.length} pending`);

    // GAP CHECK — the applied set must be contiguous.
    //
    // "0 pending" only means "no file on THIS disk is unapplied". It says
    // nothing about a version that is missing from the ledger and whose file is
    // also absent here. That combination is not hypothetical: migration 121 sat
    // unapplied on production for weeks while this command printed `0 pending`,
    // because the box's migrations directory was 20 files behind the repo and
    // the runner cannot see a file that is not there.
    //
    // Nothing else catches it either. `SELECT max(version)` reads 127 and looks
    // healthy, because `version` is TEXT and '127' > '120' lexically — a hole at
    // 121 is invisible to any max()/ORDER BY check. Meanwhile the Go backend was
    // querying the column that migration added, and failing with 42703 on every
    // request that touched it.
    //
    // So: compare against the CONTIGUOUS RANGE, not against the file list.
    const nums = [...applied].map(Number).filter(Number.isInteger).sort((a, b) => a - b);
    if (nums.length) {
      const gaps = [];
      for (let v = nums[0]; v < nums[nums.length - 1]; v++) {
        if (!applied.has(String(v).padStart(3, '0')) && !applied.has(String(v))) gaps.push(v);
      }
      // 053 was never authored — a numbering skip, not a skipped migration.
      // Listed here so the check stays quiet about a known-benign hole instead
      // of crying wolf every run, which is how a real gap gets ignored.
      const KNOWN_UNUSED = new Set([53]);
      const real = gaps.filter((v) => !KNOWN_UNUSED.has(v));

      if (real.length) {
        console.log(
          `\n  ⚠ LEDGER GAP: ${real.length} version(s) absent from the ledger between ` +
          `${nums[0]} and ${nums[nums.length - 1]}: ${real.join(', ')}\n` +
          `    These are NOT reported as pending, because no file for them exists in\n` +
          `    this directory. Two possible causes, and they need different fixes:\n` +
          `      a) the version was never authored (a numbering skip) — harmless;\n` +
          `         add it to KNOWN_UNUSED here so this stops re-reporting it.\n` +
          `      b) the migration EXISTS in the repo but is missing from this\n` +
          `         checkout and was never applied — fetch the file and run \`up\`.\n` +
          `    Check each against the repo's migrations/ before dismissing it.\n`
        );
      } else {
        console.log(`  ledger gaps:   none (${nums[0]}–${nums[nums.length - 1]} contiguous)`);
      }
    }
    const drift = await verifyChecksums(client);
    console.log(drift.length ? '' : '  checksums:     all applied migrations match their files\n');
    if (drift.length) reportDrift(drift);
  } finally {
    client.release();
  }
}

async function cmdBaseline(upTo) {
  if (!upTo) throw new Error('baseline requires a version, e.g. "baseline 009"');
  const client = await pool.connect();
  try {
    await ensureLedger(client);
    const files = listFiles().filter((f) => versionOf(f) <= upTo);
    for (const f of files) {
      const text = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
      await client.query(
        `INSERT INTO schema_migrations(version, filename, checksum)
         VALUES ($1,$2,$3) ON CONFLICT (version) DO NOTHING`,
        [versionOf(f), f, checksum(text)]
      );
      console.log(`  baselined ${f}`);
    }
    console.log(`\n  recorded ${files.length} migration(s) as already-applied (no SQL executed)\n`);
  } finally {
    client.release();
  }
}

async function cmdUp(upTo) {
  const client = await pool.connect();
  try {
    await ensureLedger(client);

    // Refuse to apply anything on top of a ledger that no longer describes what
    // is deployed. MIGRATE_ALLOW_DRIFT=1 is the deliberate escape hatch for the
    // one legitimate case — a cosmetic edit already verified by hand.
    const drift = await verifyChecksums(client);
    if (drift.length) {
      reportDrift(drift);
      if (process.env.MIGRATE_ALLOW_DRIFT !== '1') {
        throw new Error('refusing to migrate with a drifted ledger (set MIGRATE_ALLOW_DRIFT=1 to override)');
      }
      console.error('  MIGRATE_ALLOW_DRIFT=1 — continuing anyway\n');
    }

    const applied = await appliedSet(client);
    let files = listFiles().filter((f) => !applied.has(versionOf(f)));
    if (upTo) files = files.filter((f) => versionOf(f) <= upTo);
    if (!files.length) {
      console.log('\n  nothing to apply — up to date\n');
      return;
    }
    for (const f of files) {
      const text = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
      process.stdout.write(`  applying ${f} ... `);
      try {
        await client.query('BEGIN');
        await client.query(text);
        await client.query(
          `INSERT INTO schema_migrations(version, filename, checksum) VALUES ($1,$2,$3)`,
          [versionOf(f), f, checksum(text)]
        );
        await client.query('COMMIT');
        console.log('ok');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.log('FAILED');
        console.error(`\n  ${f} failed and was rolled back. Nothing after it ran.\n  ${err.message}\n`);
        throw err;
      }
    }
    console.log(`\n  applied ${files.length} migration(s)\n`);
  } finally {
    client.release();
  }
}

(async () => {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'status';
  try {
    if (cmd === 'status') {
      await cmdStatus();
    } else if (cmd === 'baseline') {
      await cmdBaseline(argv[1]);
    } else if (cmd === 'up') {
      const toIdx = argv.indexOf('--to');
      await cmdUp(toIdx > -1 ? argv[toIdx + 1] : null);
    } else {
      console.error(`unknown command: ${cmd}\n  use: status | baseline <ver> | up [--to <ver>]`);
      process.exitCode = 2;
    }
  } catch (err) {
    // Say WHY. This catch used to be silent, which turned "cannot reach the
    // database" into a bare exit 1 after the dotenv banner — indistinguishable
    // from success in a piped shell, and exactly how a stale .env pointed a
    // migration run at the wrong Postgres unnoticed (2026-08-14).
    console.error(`\n  ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
