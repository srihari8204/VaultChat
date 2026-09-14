/**
 * lib/gamesBackCoverage.selftest.ts
 *   run with: npx tsx lib/gamesBackCoverage.selftest.ts
 *
 * A GAME SCREEN WITH NO WAY OUT IS THE BUG THIS GUARDS.
 *
 * The games route spent its whole life passing `<Stack.Screen options={{ title,
 * headerBackTitle }}>` to a navigator that sets `headerShown: false` for every
 * screen — so the options were inert, the header never rendered, and Chess's
 * own source still carried a comment explaining that it did not duplicate a
 * Back control because "the navigator header already owns Back". Nothing failed
 * loudly. The hub, the four boards, and every lobby/joining/table-list state a
 * board can sit in simply had no visible exit, and the hardware key was the
 * only way off a board it had pushed — which, on a turn notification's deep
 * link, exits the app instead.
 *
 * That class of defect cannot be caught by a type or by a render test, because
 * the missing thing is a *decision*. So this is a source-level check: the games
 * route must render the shared bar, the bar must actually contain a back
 * control, and a NEW game screen added tomorrow that imports a board without
 * rendering the bar fails here rather than on someone's phone.
 *
 * Same shape as lib/themeCoverage.selftest.ts and lib/a11yCoverage.selftest.ts:
 * read the repo, assert a rule, name the offender.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

let n = 0;
const ok = (label: string, cond: boolean) => { assert.ok(cond, label); n++; };

const read = (p: string) => fs.readFileSync(p, 'utf8');

/* ── 1. the shared control exists, and is a back control ────────────── */

const UI = 'components/games/ui.tsx';
const ui = read(UI);

ok(`${UI} exports GameTopBar`, /export function GameTopBar\b/.test(ui));
ok(`${UI} exports GameChrome`, /export function GameChrome\b/.test(ui));

const bar = ui.slice(ui.indexOf('export function GameTopBar'), ui.indexOf('export function GameChrome'));
ok('GameTopBar renders a back chevron', /ion="chevron-back"/.test(bar));
// RoundBtn maps `label` onto accessibilityLabel; a bar without one is an
// unlabelled button on every game screen at once (see a11yCoverage.selftest).
ok('GameTopBar labels the back control for a screen reader', /label={backLabel}/.test(bar));
ok('GameChrome reuses GameTopBar rather than drawing a second bar', /<GameTopBar\b/.test(ui.slice(ui.indexOf('export function GameChrome'))));

/* ── 2. every game a room, so the bar is never a stripe from elsewhere ─ */

const ROUTE = 'app/games.tsx';
const route = read(ROUTE);

const kinds = [...route.matchAll(/{ kind: '([a-z]+)',/g)].map(m => m[1]);
ok('app/games.tsx still declares its catalogue of games', kinds.length >= 4);

const roomBg = ui.slice(ui.indexOf('export const ROOM_BG'), ui.indexOf('export function GameTopBar'));
for (const k of kinds) ok(`ROOM_BG has a room for '${k}'`, new RegExp(`\\b${k}:`).test(roomBg));

/* ── 3. the route renders it, for the hub AND for every board ───────── */

ok('games route renders GameChrome around the boards', /<GameChrome\b/.test(route));
ok('games route renders GameTopBar on the hub', /<GameTopBar\b/.test(route));
// The on-screen control asks before leaving a live table; the hardware key has
// to ask the same question or the two disagree, which is worse than neither.
ok('games route intercepts the hardware back key', route.includes('hardwareBackPress'));
ok('games route confirms before leaving a table', /Alert\.alert\(\s*'Leave this table\?'/.test(route));
// Leaving must never be able to drop the player out of the app.
ok('games route never dead-ends on a cold deep link', route.includes('router.canGoBack()'));

/* ── 4. the ratchet: a NEW game screen cannot skip the bar ──────────── */

/** The board components — anything under app/ that mounts one is a game screen. */
const BOARDS = fs.readdirSync('components/games')
  .filter(f => /^[A-Z]/.test(f) && f.endsWith('.tsx') && !f.endsWith('Sheet.tsx'))
  .map(f => f.replace(/\.tsx$/, ''));
ok('found the board components', BOARDS.length >= 4);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.tsx')) out.push(p.split(path.sep).join('/'));
  }
  return out;
}

const missing: string[] = [];
for (const file of walk('app')) {
  const src = read(file);
  const mountsBoard = BOARDS.some(b => new RegExp(`from\\s+'[^']*components/games/${b}'`).test(src));
  if (!mountsBoard) continue;
  if (!/<GameChrome\b/.test(src) && !/<GameTopBar\b/.test(src)) missing.push(file);
}

ok(
  missing.length === 0
    ? 'every route that mounts a game board renders the shared back control'
    : `game screens with no way out (render <GameChrome> or <GameTopBar>):\n` +
      missing.map(f => `      ${f}`).join('\n'),
  missing.length === 0,
);

console.log(`gamesBackCoverage.selftest: ${n} assertions passed, ${kinds.length} games covered`);
