// lib/vaultBeamRollout.selftest.ts — the rollout dial's guards.
//
// scripts/vaultbeam-rollout.js is the tool an operator reaches for when a
// canary is going wrong. Its guards are the part that has to hold under
// pressure, so they live in a pure function and are exercised here rather than
// discovered during an incident. A guard that has never run is a comment.
//
// The script is plain CommonJS and exports nothing else; requiring it does not
// touch a database, because `main()` is behind `require.main === module`.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { planStep, LADDER, KEY } = require('../scripts/vaultbeam-rollout.js');

type Row = { killed: boolean; rollout_pct: number; min_build: number | null } | null;

let failures = 0;
function check(cond: boolean, label: string) {
  if (cond) { console.log(`  ✓ ${label}`); return; }
  failures++;
  console.log(`  ✗ ${label}`);
}

const row = (o: Partial<NonNullable<Row>> = {}): Row => ({
  killed: false, rollout_pct: 0, min_build: null, ...o,
});

console.log(`VaultBeam rollout dial guards (${KEY}):`);

// ── kill is unconditional ────────────────────────────────────────────
// This is the assertion that matters most. Every other guard exists to stop an
// operator doing something rash; this one exists to make sure none of them can
// ever stop them stopping the bleeding.
{
  const cases: Array<[string, Row]> = [
    ['no row at all', null],
    ['mid-rollout', row({ rollout_pct: 25, min_build: 20 })],
    ['already killed', row({ killed: true })],
    ['fully rolled out', row({ rollout_pct: 100, min_build: 20 })],
    ['no build floor', row({ rollout_pct: 0 })],
  ];
  for (const [why, r] of cases) {
    const p = planStep('kill', undefined, r);
    check(p.ok === true && p.set.killed === true, `kill works with ${why}`);
  }
}

// ── the build floor must come first ──────────────────────────────────
// A sender on this flag writes a v2 segment plan, and only a build carrying
// lib/vaultBeamSegments v2 can read one. Rolling out without a floor hands v2
// plans to builds that cannot address them.
{
  const p = planStep('set', '1', row({ min_build: null }));
  check(p.ok === false && /min_build/.test(p.error), 'a percentage with no build floor is REFUSED');
  check(/v2 segment plan/.test(p.hint ?? ''), 'and the refusal explains why, not just that');

  const ok = planStep('set', '1', row({ min_build: 20 }));
  check(ok.ok === true && ok.set.rollout_pct === 1, 'with a floor set, the first rung is allowed');

  // 0% is not a rollout, so it needs no floor — that is how you roll BACK to
  // zero on a row that never had one.
  const zero = planStep('set', '0', row({ rollout_pct: 1, min_build: null }));
  check(zero.ok === true, 'rolling back to 0% never requires a floor');
}

// ── the ladder ───────────────────────────────────────────────────────
{
  for (const pct of LADDER) {
    const p = planStep('set', String(pct), row({ rollout_pct: pct, min_build: 20 }));
    check(p.ok === true, `${pct}% is on the ladder`);
  }
  for (const bad of ['2', '7', '99', '101', '-1', 'abc']) {
    const p = planStep('set', bad, row({ min_build: 20 }));
    check(p.ok === false, `${bad} is refused as off-ladder`);
  }
}

// ── no skipping rungs ────────────────────────────────────────────────
// The ladder is not decoration: each rung bounds the blast radius of the next.
{
  const skip = planStep('set', '25', row({ rollout_pct: 1, min_build: 20 }));
  check(skip.ok === false && /skip/.test(skip.error), '1% → 25% is refused as a skipped rung');
  check(/10%/.test(skip.hint ?? ''), 'and it names the rung that IS allowed');

  const step = planStep('set', '10', row({ rollout_pct: 1, min_build: 20 }));
  check(step.ok === true, '1% → 10% is allowed');

  const jump = planStep('set', '100', row({ rollout_pct: 0, min_build: 20 }));
  check(jump.ok === false, '0% → 100% is refused — that is not a canary');
}

// ── rolling BACK is never restricted ─────────────────────────────────
// Going down is a safety action. Anything that makes it harder than going up is
// backwards.
{
  for (const [from, to] of [[100, 0], [50, 1], [25, 0], [10, 1]]) {
    const p = planStep('set', String(to), row({ rollout_pct: from, min_build: 20 }));
    check(p.ok === true, `${from}% → ${to}% (a rollback) is allowed`);
  }
}

// ── a killed flag will not quietly resume ────────────────────────────
// Someone pulled that lever on purpose. Raising the percentage past it would
// mean the rollout continued while the row still said KILLED.
{
  const p = planStep('set', '10', row({ killed: true, rollout_pct: 1, min_build: 20 }));
  check(p.ok === false && /KILLED/.test(p.error), 'a killed flag refuses a percentage change');
  const rev = planStep('revive', undefined, row({ killed: true, rollout_pct: 25 }));
  check(rev.ok === true && rev.set.killed === false, 'revive clears the kill');
  check(!('rollout_pct' in rev.set), 'and revive does NOT restore the percentage — that stays deliberate');
}

// ── the floor itself ─────────────────────────────────────────────────
{
  check(planStep('floor', '21', null).ok === true, 'a floor can be set on a missing row (it upserts)');
  check(planStep('floor', '0', row()).ok === false, 'build 0 is refused');
  check(planStep('floor', '-3', row()).ok === false, 'a negative build is refused');
  check(planStep('floor', 'x', row()).ok === false, 'a non-numeric build is refused');
  const p = planStep('floor', '42', row());
  check(p.ok === true && p.set.min_build === 42, 'a valid floor is recorded');
}

// ── unknown commands do nothing ──────────────────────────────────────
{
  const p = planStep('yolo', undefined, row());
  check(p.ok === false && /unknown command/.test(p.error), 'an unknown command is refused, not guessed at');
}

console.log(failures === 0
  ? 'vaultBeamRollout self-check: OK'
  : `✗ ${failures} rollout guard check(s) failed`);
if (failures) process.exit(1);

export default {};
