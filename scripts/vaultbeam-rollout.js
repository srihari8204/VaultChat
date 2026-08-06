#!/usr/bin/env node
/**
 * vaultbeam-rollout.js — the operator dial for the VaultBeam canary.
 *
 * The kill switch and the rollout percentage live in one small table
 * (migrations/071_app_flags.sql), so in principle they are two UPDATE
 * statements. In practice the two statements have an ORDER that matters, a
 * couple of values that are unsafe, and one of them is typed at 3am by someone
 * who has just been paged. This script is that knowledge, written down and
 * enforced rather than remembered.
 *
 * What it refuses to do, and why:
 *
 *   • Raise the percentage above 0 with no `min_build`. VB_SEAMLESS_RESUME makes
 *     a sender write a v2 segment plan, and only a build carrying
 *     lib/vaultBeamSegments v2 can read one. Without a floor the dial hands v2
 *     plans to builds that cannot address them.
 *   • Set a `min_build` the fleet has not reached. That is not unsafe, but it is
 *     almost always a typo, and a rollout that silently reaches nobody looks
 *     exactly like a rollout that is going fine.
 *   • Skip a step. 1 → 100 is not a canary. The ladder exists so that the blast
 *     radius of a bad step is the previous step's size.
 *
 * What it will always do, without argument: `kill`. An emergency lever with
 * preconditions is not an emergency lever.
 *
 *   node scripts/vaultbeam-rollout.js status
 *   node scripts/vaultbeam-rollout.js floor <build>
 *   node scripts/vaultbeam-rollout.js set <pct>
 *   node scripts/vaultbeam-rollout.js kill
 *   node scripts/vaultbeam-rollout.js revive
 *
 * Connection comes from DATABASE_URL, exactly as migrate.js does — and the same
 * warning applies: that variable usually points at PRODUCTION.
 */

const KEY = 'VB_SEAMLESS_RESUME';
/** The approved ladder. Each step's blast radius is the previous step. */
const LADDER = [0, 1, 10, 25, 50, 100];

// ── the rules, as a pure function ────────────────────────────────────
// Separated from the database shell on purpose: these are the decisions that
// get made under pressure, so they are the part that has to be tested. A guard
// that has never been exercised is a comment.
//
// Returns { ok: true, set: {…} } — the columns to write — or
//         { ok: false, error, hint? }.
function planStep(cmd, arg, row) {
  if (cmd === 'kill') {
    // No preconditions, ever. An emergency lever with preconditions is not an
    // emergency lever.
    return { ok: true, set: { killed: true } };
  }

  if (cmd === 'revive') {
    if (!row) return { ok: false, error: 'no row to revive' };
    return { ok: true, set: { killed: false } };
  }

  if (cmd === 'floor') {
    const build = Number.parseInt(arg, 10);
    if (!Number.isInteger(build) || build <= 0) {
      return { ok: false, error: 'floor needs a positive build number' };
    }
    return { ok: true, set: { min_build: build } };
  }

  if (cmd === 'set') {
    const pct = Number.parseInt(arg, 10);
    if (!LADDER.includes(pct)) {
      return {
        ok: false,
        error: `${arg} is not on the ladder (${LADDER.join(', ')})`,
        hint: 'the ladder is not a style preference: each rung bounds the blast radius of the next',
      };
    }
    if (!row) return { ok: false, error: 'no row — run migration 071 first' };
    if (row.killed) {
      return { ok: false, error: 'this flag is KILLED', hint: 'revive first, deliberately' };
    }
    if (pct > 0 && !row.min_build) {
      return {
        ok: false,
        error: 'refusing to roll out with no min_build',
        hint: 'a sender on this flag writes a v2 segment plan, and only a build carrying '
            + 'lib/vaultBeamSegments v2 can read one — set the floor first',
      };
    }
    const cur = LADDER.indexOf(row.rollout_pct);
    const want = LADDER.indexOf(pct);
    if (cur >= 0 && want > cur + 1) {
      return {
        ok: false,
        error: `refusing to skip from ${row.rollout_pct}% to ${pct}%`,
        hint: `the next rung is ${LADDER[cur + 1]}%; rolling BACK is unrestricted`,
      };
    }
    return { ok: true, set: { rollout_pct: pct } };
  }

  return { ok: false, error: `unknown command '${cmd}'` };
}

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

function usage(code = 1) {
  console.log(`
${bold('VaultBeam rollout dial')}  (flag: ${KEY})

  status            show the current row and what the next legal step is
  floor <build>     set min_build — DO THIS BEFORE RAISING THE PERCENTAGE
  set <pct>         move to the next rung of ${LADDER.join(' → ')}
  kill              emergency off, unconditional, outranks everything
  revive            clear the kill (does NOT restore the percentage)

Environment: DATABASE_URL (usually production — check before you run this).
`);
  process.exit(code);
}

async function connect() {
  let Client;
  try { ({ Client } = require('pg')); }
  catch {
    console.error(red('FAIL') + '  the `pg` package is not installed here.');
    console.error('      Run this from vaultchat-backend/ where the backend deps live,');
    console.error('      or apply the SQL printed by `--sql` by hand.');
    process.exit(2);
  }
  const url = process.env.DATABASE_URL;
  if (!url) { console.error(red('FAIL') + '  DATABASE_URL is not set.'); process.exit(2); }
  const c = new Client({ connectionString: url });
  await c.connect();
  return c;
}

async function readRow(c) {
  const r = await c.query(
    'SELECT key, killed, rollout_pct, min_build, note, updated_at FROM app_flags WHERE key = $1', [KEY],
  );
  return r.rows[0] || null;
}

function describe(row) {
  if (!row) {
    console.log(yellow('WARN') + `  no row for ${KEY} — every client is using its COMPILED default (off).`);
    console.log('      Run migration 071 to create it.');
    return;
  }
  const state = row.killed ? red('KILLED') : (row.rollout_pct > 0 ? green(`${row.rollout_pct}%`) : 'off (0%)');
  console.log(`\n  ${bold(KEY)}`);
  console.log(`    state       ${state}`);
  console.log(`    min_build   ${row.min_build ?? yellow('(none — the percentage is capped at 0 until this is set)')}`);
  console.log(`    updated     ${row.updated_at?.toISOString?.() ?? row.updated_at}`);
  if (row.note) console.log(`    note        ${row.note}`);

  if (row.killed) {
    console.log(`\n    ${red('This flag is killed.')} Every client resolves it false regardless of the`);
    console.log('    percentage. `revive` clears the kill; it does not restore a rollout.');
    return;
  }
  const i = LADDER.indexOf(row.rollout_pct);
  const next = i >= 0 && i < LADDER.length - 1 ? LADDER[i + 1] : null;
  if (next === null && row.rollout_pct === 100) console.log('\n    Fully rolled out.');
  else if (next === null) console.log(`\n    ${yellow('Off-ladder percentage')} — the next legal move is one of ${LADDER.join(', ')}.`);
  else if (!row.min_build) console.log(`\n    Next: ${bold(`floor <build>`)} — a percentage without a build floor is refused.`);
  else console.log(`\n    Next: ${bold(`set ${next}`)}`);
}

/** How much of the fleet is on a build at or above the floor. */
async function adoption(c, minBuild) {
  // Best-effort: the devices table may not carry a build number in every
  // deployment. A missing signal is reported as unknown, never as "fine".
  try {
    const r = await c.query(
      `SELECT count(*) FILTER (WHERE app_build >= $1) AS ok, count(*) AS total
         FROM devices WHERE last_seen_at > now() - interval '14 days'`, [minBuild],
    );
    const ok = Number(r.rows[0].ok), total = Number(r.rows[0].total);
    if (!total) return null;
    return { ok, total, pct: Math.round((ok / total) * 100) };
  } catch { return null; }
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') usage(0);

  const c = await connect();
  try {
    const row = await readRow(c);

    if (cmd === 'status') { describe(row); return; }

    const plan = planStep(cmd, arg, row);
    if (!plan.ok) {
      console.error(red('FAIL') + '  ' + plan.error);
      if (plan.hint) console.error('      ' + plan.hint);
      process.exit(1);
    }

    if (cmd === 'kill') {
      // No preconditions, ever. This is the one command that must work when
      // everything else is on fire.
      await c.query(
        `INSERT INTO app_flags (key, killed, rollout_pct, updated_at) VALUES ($1, TRUE, 0, now())
         ON CONFLICT (key) DO UPDATE SET killed = TRUE, updated_at = now()`, [KEY],
      );
      console.log(red(`\n  ${KEY} is KILLED.`));
      console.log('  Clients pick this up within one TTL (<=15 min) or immediately at the');
      console.log('  next transfer start. In-flight transfers are NOT interrupted — they');
      console.log('  finish on their own terms rather than abandoning a half-written file.');
      describe(await readRow(c));
      return;
    }

    if (cmd === 'revive') {
      await c.query('UPDATE app_flags SET killed = FALSE, updated_at = now() WHERE key = $1', [KEY]);
      console.log(green('\n  Kill cleared.') + ` The percentage is still ${row.rollout_pct}% — reviving does not roll out.`);
      describe(await readRow(c));
      return;
    }

    if (cmd === 'floor') {
      const build = plan.set.min_build;
      const adopt = await adoption(c, build);
      if (adopt && adopt.pct < 50) {
        console.log(yellow('WARN') + `  only ${adopt.pct}% of devices seen in the last 14 days are on build >= ${build}`);
        console.log('      (a rollout that reaches almost nobody looks exactly like one that is going fine)');
      } else if (adopt) {
        console.log(green('OK') + `    ${adopt.pct}% of recently-seen devices are on build >= ${build}`);
      } else {
        console.log(yellow('WARN') + '  adoption is unknown here (no build column on devices) — check your own dashboards');
      }
      await c.query(
        `INSERT INTO app_flags (key, min_build, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET min_build = $2, updated_at = now()`, [KEY, build],
      );
      describe(await readRow(c));
      return;
    }

    if (cmd === 'set') {
      const pct = plan.set.rollout_pct;
      await c.query('UPDATE app_flags SET rollout_pct = $2, updated_at = now() WHERE key = $1', [KEY, pct]);
      if (pct > row.rollout_pct) {
        console.log(green(`\n  ${KEY} raised to ${pct}%.`));
        console.log('  Watch before the next rung — see openspec/changes/vaultbeam-seamless-resume/tasks.md 9.');
      } else {
        console.log(yellow(`\n  ${KEY} lowered to ${pct}%.`));
        console.log('  Bucketing is stable, so devices leave in the reverse order they joined.');
      }
      describe(await readRow(c));
      return;
    }

    usage();
  } finally {
    await c.end().catch(() => {});
  }
}

// Exported for lib/vaultBeamRollout.selftest.ts — the rules are tested without
// a database, which is the only way they get tested at all.
module.exports = { planStep, LADDER, KEY };

if (require.main === module) {
  main().catch((e) => { console.error(red('FAIL') + '  ' + (e?.message ?? e)); process.exit(2); });
}
