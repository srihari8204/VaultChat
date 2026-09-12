#!/usr/bin/env node
/**
 * Re-record migration checksums that drifted ONLY because of line endings.
 *
 * migrate.js hashes with CRLF normalised, but that normalisation was added
 * after some migrations had already been applied — from a Windows checkout,
 * where the recorded hash is the CRLF one. Those entries now read as "drifted"
 * forever, and a ledger that cries wolf on every file is worse than none: the
 * one real mismatch hides in the noise.
 *
 * This ONLY touches a row whose recorded checksum is exactly the CRLF hash of
 * the current file — which is proof the same SQL ran, not an assumption. Any
 * row matching neither hash is REPORTED and left alone: that is genuine drift
 * and a person has to look at it.
 *
 *   node scripts/fix-migration-ledger-crlf.js            # report only
 *   node scripts/fix-migration-ledger-crlf.js --apply    # re-record the provable ones
 *
 * Run against production 2026-09-13: 126 rows, exactly one line-ending-only
 * mismatch (099_message_bodies.sql), no real drift. Exit 1 means real drift.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const DIR = process.env.MIGRATIONS_DIR || path.join(__dirname, '..', 'vaultchat-backend', 'migrations');
const h = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);
const lf = (t) => t.replace(/\r\n/g, '\n');

(async () => {
  const client = new Client({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME,
  });
  await client.connect();
  const rows = (await client.query('SELECT version, filename, checksum FROM schema_migrations')).rows;

  const fixable = [], real = [], missing = [];
  for (const r of rows) {
    const p = path.join(DIR, r.filename);
    if (!fs.existsSync(p)) { missing.push(r); continue; }
    const text = lf(fs.readFileSync(p, 'utf8'));
    if (r.checksum === h(text)) continue;                       // in sync
    if (r.checksum === h(text.replace(/\n/g, '\r\n'))) fixable.push({ r, want: h(text) });
    else real.push(r);
  }

  console.log(`  ledger rows: ${rows.length}`);
  console.log(`  line-ending only (provably the same SQL): ${fixable.length}`);
  for (const f of fixable) console.log(`    ${f.r.filename}: ${f.r.checksum} -> ${f.want}`);
  if (missing.length) {
    console.log(`  applied but the file is gone (not touched): ${missing.length}`);
    for (const m of missing) console.log(`    ${m.filename}`);
  }
  if (real.length) {
    console.log(`\n  REAL DRIFT — the file no longer matches what ran, and no line-ending`);
    console.log(`  explanation fits. NOT touched; look at these by hand:`);
    for (const r of real) console.log(`    ${r.filename} recorded ${r.checksum}`);
  }

  if (process.argv.includes('--apply') && fixable.length) {
    for (const f of fixable) {
      await client.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2', [f.want, f.r.version]);
    }
    console.log(`\n  re-recorded ${fixable.length} checksum(s)`);
  }
  await client.end();
  process.exit(real.length ? 1 : 0);
})();
