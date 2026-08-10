// lib/historyReplay.selftest.ts — run: npx tsx lib/historyReplay.selftest.ts
//
// A decrypt failure while replaying HISTORY must never reset the LIVE session.
//
// Old messages are encrypted to ratchet states that have long since advanced,
// so they are permanently undecryptable by design. Counting them toward the
// "session is dead" streak means the act of reading old messages destroys a
// perfectly healthy session.
//
// Measured on device 2026-08-10:
//   14:28:37  [chats/delta] cold sync (uncapped) user=cb1caeda…
//   14:28:45  session 651e5210 reset — resets=1 decryptFails=2
//             session 8fc9fd3f reset — resets=1 decryptFails=2
//             session 09f46de9 reset — resets=1 decryptFails=2
//   14:30:12  session cb1caeda reset — resets=1 decryptFails=10
//   14:31:05  FORCED re-key (peer call setup failed) — 09f46de9
//
// All four sessions were healthy; the cold sync alone killed them. The call
// that arrived seconds later landed on a session that had just been torn down,
// and was reported as "calls not working" — two layers below the call stack.
//
// Mirrors maybeAutoRecoverSession + the hydrateMessages guard in chatService.

const AUTO_RECOVER_AFTER = 2;

/** Mirrors the streak/reset half of chatService. */
class Recovery {
  resets = new Map<string, number>();
  private streak = new Map<string, number>();
  private bulkDepth = 0;

  /** Mirrors hydrateMessages: everything inside is history. */
  bulk(fn: () => void): void {
    this.bulkDepth++;
    try { fn(); } finally { this.bulkDepth--; }
  }

  fail(peer: string): void {
    if (this.bulkDepth > 0) return;              // history says nothing about live
    const n = (this.streak.get(peer) ?? 0) + 1;
    this.streak.set(peer, n);
    if (n < AUTO_RECOVER_AFTER) return;
    this.streak.delete(peer);
    this.resets.set(peer, (this.resets.get(peer) ?? 0) + 1);
  }

  ok(peer: string): void { this.streak.delete(peer); }
  resetsFor(p: string): number { return this.resets.get(p) ?? 0; }
}

let failures = 0;
const check = (name: string, ok: boolean) => { if (!ok) failures++; console.log(`  ${ok ? '✓' : '✗'} ${name}`); };

console.log('\nHistory replay must not kill live sessions\n');

// ── the captured cold sync ────────────────────────────────────────────
const r = new Recovery();
r.bulk(() => {
  for (const peer of ['651e5210', '8fc9fd3f', '09f46de9', 'cb1caeda']) {
    r.fail(peer); r.fail(peer);          // exactly what tore them down on device
  }
});
check('a cold sync replaying history resets NOTHING',
  ['651e5210', '8fc9fd3f', '09f46de9', 'cb1caeda'].every(p => r.resetsFor(p) === 0));

// ── a genuinely dead live session still recovers ──────────────────────
// The guard must not disable auto-recovery, only scope it.
const r2 = new Recovery();
r2.fail('09f46de9'); r2.fail('09f46de9');
check('a live session that fails twice still resets', r2.resetsFor('09f46de9') === 1);

// ── history failures do not PRIME the live streak ─────────────────────
// If a bulk failure left the counter at 1, a single live failure would then
// trip the reset — the bug surviving in a subtler form.
const r3 = new Recovery();
r3.bulk(() => { r3.fail('09f46de9'); });
r3.fail('09f46de9');
check('one history failure + one live failure does NOT reset',
  r3.resetsFor('09f46de9') === 0);
r3.fail('09f46de9');
check('...but two live failures do', r3.resetsFor('09f46de9') === 1);

// ── a success clears the streak ───────────────────────────────────────
const r4 = new Recovery();
r4.fail('09f46de9'); r4.ok('09f46de9'); r4.fail('09f46de9');
check('an intervening success clears the streak', r4.resetsFor('09f46de9') === 0);

// ── nesting ───────────────────────────────────────────────────────────
// A chat opening while a sync is already running: the inner bulk finishing
// must not re-enable resets while the outer one is still replaying.
const r5 = new Recovery();
r5.bulk(() => {
  r5.bulk(() => { r5.fail('cb1caeda'); });
  r5.fail('cb1caeda');                    // still inside the OUTER bulk
});
check('nested history replay stays suppressed throughout', r5.resetsFor('cb1caeda') === 0);

// ── the depth is restored even if hydrate throws ──────────────────────
const r6 = new Recovery();
try { r6.bulk(() => { throw new Error('render blew up'); }); } catch { /* expected */ }
r6.fail('09f46de9'); r6.fail('09f46de9');
check('a throwing hydrate does not leave resets disabled forever',
  r6.resetsFor('09f46de9') === 1);

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all history-replay checks passed\n');
process.exit(failures ? 1 : 0);
