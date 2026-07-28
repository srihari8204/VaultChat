// One-off backfill for F1 (peppered contact discovery).
//
// Re-keys every stored discovery hash in place:
//   users.phone_hash:  sha256(digits)  →  HMAC(pepper, sha256(digits))
// using vault.discoveryHash for byte-parity with the live code.
//
// WHY A SCRIPT AND NOT A MIGRATION: migrate.js only executes .sql and cannot
// bind the pepper (hardcoding it into a committed .sql would leak the secret
// into git). And the transform is IRREVERSIBLE if run twice (peppered and
// unpeppered values are both 64-hex and indistinguishable), so the script
// self-gates with its own sentinel table and refuses to run again.
//
// Run ON THE SERVER, from vaultchat-backend/, with env loaded:
//   node scripts/pepper-phone-hash-backfill.js
//
// Deploy order: run this backfill and deploy the peppered code in the SAME
// release window — between the two, existing users are undiscoverable and
// DM-by-phone misses them (new signups are unaffected either way).
//
// otp_codes.phone_hash is NOT transformed: rows live ≤5 minutes and any
// in-flight OTP at deploy simply fails; the user re-requests a code.
//
// Bonus hardening (decision 1 from the F1 plan): any legacy plaintext
// users.phone is encrypted into phone_cipher (AES-256-GCM under the master
// key) and the plaintext column is nulled — without this, the pepper adds no
// at-rest value on legacy rows since the raw phone sits beside the hash.

'use strict';
require('dotenv').config();
const db    = require('../db');
const vault = require('../lib/vault');

const SENTINEL = 'pepper_phone_hash_backfill_v1';

async function main() {
  if (!process.env.VAULTCHAT_LOOKUP_PEPPER) {
    console.error('ABORT: VAULTCHAT_LOOKUP_PEPPER is not set — refusing to backfill.');
    process.exit(1);
  }

  await db.query(`CREATE TABLE IF NOT EXISTS one_off_flags (
    key      TEXT PRIMARY KEY,
    done_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  const gate = await db.query(`SELECT 1 FROM one_off_flags WHERE key = $1`, [SENTINEL]);
  if (gate.rows[0]) {
    console.error(`ABORT: sentinel '${SENTINEL}' already present — this backfill has run. ` +
                  `Re-running would double-pepper hashes IRREVERSIBLY.`);
    process.exit(1);
  }

  await db.transaction(async (client) => {
    // 1) Re-key users.phone_hash in place.
    const rows = await client.query(
      `SELECT id, phone_hash FROM users WHERE phone_hash IS NOT NULL`);
    let rekeyed = 0;
    for (const { id, phone_hash } of rows.rows) {
      await client.query(`UPDATE users SET phone_hash = $1 WHERE id = $2`,
        [vault.discoveryHash(phone_hash), id]);
      rekeyed++;
    }
    console.log(`re-keyed users.phone_hash: ${rekeyed} rows`);

    // 2) Drop in-flight phone OTPs (≤5-min rows keyed by the OLD hash — they
    //    could never match again; the user just requests a fresh code).
    const otp = await client.query(`DELETE FROM otp_codes WHERE phone_hash IS NOT NULL`);
    console.log(`cleared in-flight phone OTPs: ${otp.rowCount} rows`);

    // 3) Legacy plaintext phone → phone_cipher, then NULL the plaintext.
    //    Skipped gracefully if the master key or the column is unavailable.
    try {
      const legacy = await client.query(
        `SELECT id, phone FROM users WHERE phone IS NOT NULL AND phone <> ''`);
      let sealed = 0;
      for (const { id, phone } of legacy.rows) {
        await client.query(
          `UPDATE users SET phone_cipher = COALESCE(phone_cipher, $1), phone = NULL WHERE id = $2`,
          [vault.encrypt(phone), id]);
        sealed++;
      }
      console.log(`sealed legacy plaintext phones: ${sealed} rows`);
    } catch (e) {
      console.warn(`plaintext-phone seal skipped (${e.message}) — ` +
                   `pepper still applied; re-run the seal after setting VAULTCHAT_MASTER_KEY.`);
    }

    await client.query(`INSERT INTO one_off_flags (key) VALUES ($1)`, [SENTINEL]);
  });

  console.log('DONE. Deploy the peppered backend code now (same release window).');
  await db.shutdown();
}

main().catch(err => { console.error('BACKFILL FAILED (rolled back):', err); process.exit(1); });
