#!/usr/bin/env node
/**
 * scripts/check-migration-drift.js — does the database have every migration?
 *
 * WHY THIS EXISTS
 * ---------------
 * Migration drift is a recurring incident here, not a one-off, and its failure
 * mode is the dangerous kind: it reports SUCCESS.
 *
 *   - Migration 121 was missing from production for weeks. It was found by a
 *     person happening to look, not by anything that watches.
 *   - The legacy `api` image bakes its migrations directory at build time, and
 *     that copy stops around 101. So `migrate.js up` inside it prints
 *     "nothing to apply — up to date" while being blind to everything newer.
 *
 * Both are invisible without counting. So: count the files, count the rows,
 * compare, and name the exact versions that are missing.
 *
 * Deliberately standalone and dependency-light. It runs in CI against a throw-
 * away Postgres, and over SSH against production, without needing the app's
 * config, the docker runner, or a checkout on the far side.
 *
 *   node scripts/check-migration-drift.js                 # uses DB_* env
 *   node scripts/check-migration-drift.js --expect 127    # offline file check
 *
 * Verified against production 2026-09-13: 126 files, 126 applied, no drift.
 *
 * Exit 0 = in sync. Exit 1 = drift, with the missing versions listed.
 */
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'vaultchat-backend', 'migrations');

/** Every migration on disk, as {version, file}. Numeric prefix is the version. */
function migrationsOnDisk() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => ({ version: (f.match(/^(\d+)/) || [])[1], file: f }))
    .filter((m) => m.version)
    .sort((a, b) => Number(a.version) - Number(b.version));
}

/**
 * Versions present on disk but absent from the applied list.
 *
 * Compared as NUMBERS, not strings: files are zero-padded ("007") and the
 * schema_migrations column may not be, so a string compare would report every
 * early migration as missing.
 */
function missing(disk, applied) {
  const have = new Set(applied.map((v) => Number(v)));
  return disk.filter((m) => !have.has(Number(m.version)));
}

function duplicates(disk) {
  const seen = new Map();
  const dupes = [];
  for (const m of disk) {
    const n = Number(m.version);
    if (seen.has(n)) dupes.push(`${seen.get(n)} and ${m.file} share version ${m.version}`);
    else seen.set(n, m.file);
  }
  return dupes;
}

async function appliedVersions() {
  const { Client } = require('pg');
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'vaultchat',
    password: process.env.DB_PASS || process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'vaultchat',
  });
  await client.connect();
  try {
    const r = await client.query('SELECT version FROM schema_migrations');
    return r.rows.map((row) => row.version);
  } finally {
    await client.end();
  }
}

(async () => {
  const disk = migrationsOnDisk();
  console.log(`\n  migration files on disk: ${disk.length} (latest ${disk[disk.length - 1]?.version})`);

  // A duplicate version number is its own incident — two long-lived branches
  // each adding "070" collides on the primary key and rolls the whole run back.
  const dupes = duplicates(disk);
  if (dupes.length) {
    console.error('\n  DUPLICATE VERSION NUMBERS:');
    for (const d of dupes) console.error(`    ${d}`);
    process.exit(1);
  }

  const expectArg = process.argv.indexOf('--expect');
  if (expectArg > -1) {
    const want = Number(process.argv[expectArg + 1]);
    const latest = Number(disk[disk.length - 1].version);
    if (latest !== want) {
      console.error(`\n  FAIL: latest migration is ${latest}, expected ${want}\n`);
      process.exit(1);
    }
    console.log(`  latest matches --expect ${want}\n`);
    process.exit(0);
  }

  let applied;
  try {
    applied = await appliedVersions();
  } catch (e) {
    console.error(`\n  could not read schema_migrations: ${e.message}`);
    console.error('  set DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_NAME, or use --expect for an offline check\n');
    process.exit(1);
  }

  console.log(`  applied in database:     ${applied.length}`);

  const gaps = missing(disk, applied);
  if (gaps.length) {
    console.error(`\n  DRIFT — ${gaps.length} migration(s) on disk are NOT applied:`);
    for (const g of gaps) console.error(`    ${g.file}`);
    console.error('\n  This is the failure that reports success: a runner with a stale');
    console.error('  migrations directory prints "nothing to apply" and exits 0.\n');
    process.exit(1);
  }

  console.log('  in sync — every migration on disk is applied\n');
})();
