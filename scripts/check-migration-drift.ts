#!/usr/bin/env node
/**
 * scripts/check-migration-drift.ts - does the database have every migration?
 *
 * Exit 0 = in sync. Exit 1 = drift, with the missing versions listed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATIONS_DIR = path.join(__dirname, '..', 'vaultchat-backend', 'migrations');

type Migration = { version: string; file: string };

/** Every migration on disk. Numeric prefix is the version. */
function migrationsOnDisk(): Migration[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => ({ version: (f.match(/^(\d+)/) || [])[1], file: f }))
    .filter((m): m is Migration => Boolean(m.version))
    .sort((a, b) => Number(a.version) - Number(b.version));
}

function missing(disk: Migration[], applied: Array<string | number>): Migration[] {
  const have = new Set(applied.map((v) => Number(v)));
  return disk.filter((m) => !have.has(Number(m.version)));
}

function duplicates(disk: Migration[]): string[] {
  const seen = new Map<number, string>();
  const dupes: string[] = [];
  for (const m of disk) {
    const n = Number(m.version);
    const prev = seen.get(n);
    if (prev) dupes.push(`${prev} and ${m.file} share version ${m.version}`);
    else seen.set(n, m.file);
  }
  return dupes;
}

async function appliedVersions(): Promise<Array<string | number>> {
  const { Client } = require(require.resolve('pg', {
    paths: [path.join(__dirname, '..', 'vaultchat-backend')],
  }));
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
    return r.rows.map((row: { version: string | number }) => row.version);
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const disk = migrationsOnDisk();
  console.log(`\n  migration files on disk: ${disk.length} (latest ${disk[disk.length - 1]?.version})`);

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
    return;
  }

  let applied: Array<string | number>;
  try {
    applied = await appliedVersions();
  } catch (e: any) {
    console.error(`\n  could not read schema_migrations: ${e.message}`);
    console.error('  set DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_NAME, or use --expect for an offline check\n');
    process.exit(1);
  }

  console.log(`  applied in database:     ${applied.length}`);

  const gaps = missing(disk, applied);
  if (gaps.length) {
    console.error(`\n  DRIFT - ${gaps.length} migration(s) on disk are NOT applied:`);
    for (const g of gaps) console.error(`    ${g.file}`);
    console.error('\n  A runner with a stale migrations directory can print "nothing to apply" and exit 0.\n');
    process.exit(1);
  }

  console.log('  in sync - every migration on disk is applied\n');
}

main();
