// routes/config.js — the remote feature-flag channel (migration 071_app_flags.sql).
//
// Node parity for vaultchat-backend-go/internal/routes/config.go. Caddy routes
// the client surface to go-api today, so this path is not live — it exists
// because Node is the rollback target, and a rollback that took the kill switch
// offline would remove the lever at exactly the moment it is needed.
//
// The resolution rules MUST match config.go exactly: kill outranks everything,
// then the build floor, then a stable per-(key, device) bucket. See the Go
// tests in internal/routes/config_test.go for the properties both must hold —
// in particular that raising the dial only ever ADDS devices.
//
// Unauthenticated on purpose: the flag names are already in the shipped binary,
// nothing user-specific is returned, and the client fetches this during boot
// where an auth failure must never be able to log somebody out.

const express = require('express');
const db      = require('../db');
// The rules live in a dependency-free module so they can be tested (and their
// bucket vectors emitted for the Go parity test) without booting Express.
const { resolve } = require('../lib/flagResolve');

const router = express.Router();

// Client cache lifetime. The client caps staleness independently, so a device
// that cannot reach us eventually returns to its compiled defaults rather than
// honouring an override nobody can revoke.
const TTL_SEC = 900;

router.get('/flags', async (req, res) => {
  const deviceId = req.get('X-Device-Id') || '';
  // Absent/garbage build parses to 0, which fails every floor — the safe
  // direction: an unidentifiable client gets no new behaviour.
  const build = Number.parseInt(req.query.build, 10) || 0;

  let rows;
  try {
    const r = await db.query('SELECT key, killed, rollout_pct, min_build FROM app_flags');
    rows = r.rows;
  } catch {
    // No opinion available. An empty map means "use your compiled defaults" —
    // never an implicit enable.
    return res.json({ v: 1, flags: {}, killed: [], ttlSec: 60 });
  }

  const flags = {};
  const killed = [];
  for (const row of rows) {
    if (row.killed) killed.push(row.key);
    flags[row.key] = resolve(row, deviceId, build);
  }
  res.json({ v: 1, flags, killed, ttlSec: TTL_SEC });
});

module.exports = router;
