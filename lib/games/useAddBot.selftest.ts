// lib/games/useAddBot.selftest.ts — "Add a bot" must not fail silently.
//
//   npx tsx lib/games/useAddBot.selftest.ts
//
// The hook is a timer plus two refs, which is exactly the shape that looks
// obviously-correct and then fires after unmount, or complains about a request
// that actually succeeded. So the state machine is re-implemented here as a
// pure reducer and driven through the sequences that matter, and the SOURCE is
// checked for the wiring a renderer would otherwise have to prove.

import { readFileSync } from 'fs';
import { join } from 'path';
import { ADD_BOT_STALLED, ADD_BOT_TIMEOUT_MS } from './useAddBot';
import { boardSource } from './boardSource.testkit';

let failed = 0;
function A(ok: boolean, what: string): void {
  if (ok) { console.log('  ok   ' + what); return; }
  failed++;
  console.log('  FAIL ' + what);
}

console.log('\nAdd a bot\n');

/* ── the state machine, as the hook implements it ────────────────────── */
type S = { asked: number | null; stalled: boolean; timerLive: boolean };
const fresh = (): S => ({ asked: null, stalled: false, timerLive: false });
/** addBot(): remember the seat count, clear any old complaint, arm the timer. */
const ask = (s: S, seated: number): S => ({ asked: seated, stalled: false, timerLive: true });
/** a lobby snapshot arrived */
const seats = (s: S, seated: number): S =>
  (s.asked != null && seated > s.asked)
    ? { asked: null, stalled: false, timerLive: false }   // it landed
    : s;
/** the timeout fired */
const tick = (s: S): S =>
  s.timerLive ? { ...s, stalled: s.asked != null, timerLive: false } : s;
/** the component went away */
const unmount = (s: S): S => ({ ...s, timerLive: false });

{
  // The happy path: a seat appears, so nothing is ever said.
  let s = fresh();
  s = ask(s, 1);
  s = seats(s, 2);
  A(!s.stalled, '1a. a bot that arrives raises no complaint');
  A(s.asked === null && !s.timerLive, '1b. ...and the timer is disarmed');
  s = tick(s);
  A(!s.stalled, '1c. ...so a late timer cannot complain retroactively');
}

{
  // The bug this exists for: accepted, never seated, nothing said.
  let s = fresh();
  s = ask(s, 1);
  s = seats(s, 1);              // snapshot arrives, seat count UNCHANGED
  s = tick(s);
  A(s.stalled, '2a. no seat before the timeout is reported');
  A(!s.timerLive, '2b. ...once, not on a loop');
}

{
  // Asking again must clear the previous complaint, or the message sticks to a
  // lobby that has since recovered.
  let s = fresh();
  s = ask(s, 1); s = tick(s);
  A(s.stalled, '3a. stalled after the first ask');
  s = ask(s, 1);
  A(!s.stalled, '3b. asking again clears it immediately');
  s = seats(s, 2);
  A(!s.stalled, '3c. ...and success keeps it clear');
}

{
  // A seat that appears for some OTHER reason (a human joins, or a late
  // asynchronous server snapshot) still counts as the request landing — we
  // cannot tell them apart, and claiming a failure while the lobby visibly
  // filled would be the worse error.
  let s = fresh();
  s = ask(s, 1);
  s = seats(s, 3);
  A(!s.stalled && s.asked === null, '4a. any new seat resolves the request');

  // ...including one that arrives long after the tap, from an async update.
  let a = fresh();
  a = ask(a, 2);
  a = seats(a, 2);              // an unrelated snapshot, count unchanged
  a = seats(a, 2);
  a = seats(a, 3);              // the bot finally lands
  A(!a.stalled && a.asked === null, '4b. a late async seat still resolves it');
  a = tick(a);
  A(!a.stalled, '4c. ...and the armed timer cannot then report failure');
}

{
  // A SECOND ask must invalidate the FIRST ask's timer, or the old timeout
  // fires and blames a request that has been superseded.
  let s = fresh();
  s = ask(s, 1);                // request A arms a timer
  s = ask(s, 1);                // request B — A's timer must be dead
  A(s.timerLive, '4d. the newer request owns the live timer');
  // Only ONE timer may ever be live: `stop()` runs before each arm.
  const hook = readFileSync(join(__dirname, 'useAddBot.ts'), 'utf8');
  const body = hook.match(/const addBot = useCallback\(([\s\S]*?)\n  \}, \[/)?.[1] ?? '';
  A(/stop\(\)/.test(body) && body.indexOf('stop()') < body.indexOf('setTimeout'),
    '4e. ...because addBot clears the old timeout BEFORE arming a new one');
}

{
  // A timeout that survives unmount sets state on a dead component — one
  // warning per lobby visit, and the classic way this hook leaks.
  let s = fresh();
  s = ask(s, 1);
  s = unmount(s);
  s = tick(s);
  A(!s.stalled, '5a. a timer that fires after unmount changes nothing');
}

{
  // Never complain about a request that was never made.
  let s = fresh();
  s = tick(s);
  A(!s.stalled, '6a. no ask, no complaint');
  s = seats(s, 5);
  A(!s.stalled, '6b. ...and seats arriving unprompted say nothing');
}

/* ── the wiring, which a pure reducer cannot prove ───────────────────── */
{
  const ROOT = join(__dirname, '..', '..');
  const hook = readFileSync(join(ROOT, 'lib/games/useAddBot.ts'), 'utf8');
  const ludo = boardSource('Ludo');
  const chess = boardSource('Chess');
  const ttt = boardSource('TicTacToe');

  A(/useEffect\(\(\) => stop, \[\]\)/.test(hook),
    '7a. the hook clears its timeout on unmount');
  // It must ASK ONCE. A refusal may be deliberate, and a hook that quietly
  // re-sends would hammer a server that is already saying no.
  // (The first version of this check matched `addBot` in the `return` line and
  //  failed on correct code — assert the timeout's BODY, not its neighbourhood.)
  const timeoutBody = hook.match(/setTimeout\(\(\) => \{([\s\S]*?)\}, timeoutMs\)/)?.[1] ?? '';
  A(timeoutBody.length > 0, '7b. the timeout callback is findable');
  A(!/send\(/.test(timeoutBody), '7b\'. ...and it does not send anything');
  A((hook.match(/\bsend\(/g) ?? []).length === 1,
    '7b". `send` is called exactly once in the hook — one ask per tap');
  A(!/retry\(/.test(hook), '7b\'\'\'. ...and it never reconnects on its own');
  A(!/roomId|defaultRoom/.test(hook),
    '7c. ...and it does not quietly change rooms, which would lose invited players');

  for (const [name, src] of [['Ludo', ludo], ['Chess', chess], ['TicTacToe', ttt]] as const) {
    A(/useAddBot\(/.test(src), `7d. ${name} uses the hook`);
    // The call may carry its own payload (Ludo writes one explicitly) or take
    // the hook's default (Chess, whose shim discards it) — either way the tap
    // must go through addBot rather than straight to send.
    A(/bot\.addBot\(/.test(src), `7e. ${name}'s button goes through it`);
    A(/bot\.stalled &&/.test(src), `7f. ${name} renders the message`);
    A(/ADD_BOT_STALLED/.test(src), `7g. ${name} uses the shared wording`);
    // The raw send must not remain on the button, or the watch is bypassed.
    A(!/onPress=\{\(\) => send\(\{ t: 'addbot'/.test(src),
      `7h. ${name} no longer fires addbot straight past the watch`);
  }
  // Ludo's fillAndStart sends addbot in a LOOP for "play 3 bots" — that path is
  // deliberately left alone: it is a different intent with its own wait, and
  // wrapping it would make one stalled seat blame the whole deal.
  A(/for \(let i = seated; i < n \+ 1; i\+\+\) send\(\{ t: 'addbot' \}\);/.test(ludo),
    '7i. Ludo\'s multi-bot deal is untouched');

  // THE WIRE PAYLOADS ARE UNCHANGED. This is the whole safety property: the
  // hook watches the OUTCOME and must never have altered what is sent.
  A(/onAddBot=\{\(\) => send\(\{ t: 'addbot', level: botLevel \}\)\}/.test(chess),
    '7l. Chess still sends {t:"addbot", level} — byte-identical');
  A(/onPress=\{\(\) => bot\.addBot\(\{ t: 'addbot' \}\)\}/.test(ludo),
    '7m. Ludo still sends {t:"addbot"} — written at the call site, not defaulted');
  A(/onPress=\{\(\) => bot\.addBot\(\{ t: 'addbot' \}\)\}/.test(ttt),
    '7m2. TicTacToe still sends {t:"addbot"} — written at the call site');
  // Chess routes through a shim that DISCARDS the hook's default message, so
  // its level cannot be dropped on the floor by a future default change.
  A(/useAddBot\(\(\) => onAddBot\(\), members\.length\)/.test(chess),
    '7n. ...and Chess\'s shim ignores the hook\'s payload entirely');

  A(ADD_BOT_STALLED.length > 30 && !/error|failed/i.test(ADD_BOT_STALLED),
    '7j. the message says what happened and what to do, not "error"');
  A(ADD_BOT_TIMEOUT_MS >= 3000 && ADD_BOT_TIMEOUT_MS <= 15000,
    `7k. the timeout is patient but still feedback (${ADD_BOT_TIMEOUT_MS}ms)`);
}

console.log(failed === 0 ? '\nAll good.\n' : `\n${failed} FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
