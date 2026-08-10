// lib/call/netChange.selftest.ts — run: npx tsx lib/call/netChange.selftest.ts
//
// The property that matters is not the boolean, it is the SEQUENCE: a real
// Wi-Fi -> cellular handover must produce exactly ONE ICE restart, on the
// event where a usable network exists.
//
// Replayed from the device capture at 12:28:13, where the old behaviour
// produced two restarts and a rollback.

import { netKey, shouldRestartIce, type NetState } from './netChange';

let failures = 0;
const check = (name: string, ok: boolean) => { if (!ok) failures++; console.log(`  ${ok ? '✓' : '✗'} ${name}`); };

/** Feed a sequence of NetInfo emissions through the predicate; count restarts. */
function replay(states: NetState[]): { restarts: number; on: string[] } {
  let prev = '';
  const on: string[] = [];
  for (const st of states) {
    if (shouldRestartIce(prev, st)) on.push(netKey(st));
    // The engine advances `prev` on every distinct key, restart or not — so a
    // skipped dead-network event still counts as seen and the NEXT event is a
    // change relative to it.
    prev = netKey(st);
  }
  return { restarts: on.length, on };
}

console.log('\nNetwork-change -> ICE restart\n');

const WIFI: NetState = { type: 'wifi', isConnected: true };
const NONE: NetState = { type: 'none', isConnected: false };
const CELL: NetState = { type: 'cellular', isConnected: true };

// ── the captured handover ─────────────────────────────────────────────
const handover = replay([WIFI, NONE, CELL]);
check('a wifi->none->cellular handover restarts ONCE', handover.restarts === 1);
check('...and on the cellular event, not the dead one', handover.on[0] === 'cellular:true');

// ── the first emission is not a change ────────────────────────────────
// NetInfo emits current state on subscribe; treating that as a handover would
// restart ICE on every call setup.
check('the first callback never restarts', replay([WIFI]).restarts === 0);

// ── wobble must not churn a healthy call ──────────────────────────────
check('repeated identical states do not restart',
  replay([WIFI, WIFI, WIFI]).restarts === 0);

// ── a direct swap with no gap still restarts ──────────────────────────
// Some devices hand over without an intervening `none`.
check('a direct wifi->cellular swap restarts', replay([WIFI, CELL]).restarts === 1);

// ── going offline and back on the SAME network ────────────────────────
// The path is genuinely dead and needs re-gathering, so the return must fire.
check('offline then back to the same wifi restarts on return',
  replay([WIFI, NONE, WIFI]).restarts === 1);

// ── a dead network alone never restarts ───────────────────────────────
check('losing connectivity alone does not restart', replay([WIFI, NONE]).restarts === 0);

// ── flapping ──────────────────────────────────────────────────────────
// Two real recoveries = two restarts. This is why a blanket time-based
// debounce was rejected: it would have swallowed the second one.
check('wifi->none->cell->none->cell restarts twice',
  replay([WIFI, NONE, CELL, NONE, CELL]).restarts === 2);

// ── key shape ─────────────────────────────────────────────────────────
check('netKey distinguishes reachability on the same transport',
  netKey({ type: 'wifi', isConnected: true }) !== netKey({ type: 'wifi', isConnected: false }));
check('undefined state is handled', typeof netKey(undefined) === 'string');

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all network-change checks passed\n');
process.exit(failures ? 1 : 0);
