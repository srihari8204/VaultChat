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
const checksum = (text) =>
  crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

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
    console.log(`\n  ${pending.length} pending\n`);
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
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
