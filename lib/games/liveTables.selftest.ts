// lib/games/liveTables.selftest.ts — asynchronous play must have somewhere to land.
//
//   npx tsx lib/games/liveTables.selftest.ts
//
// BEHAVIOURAL for the two pure rules (which rows are shown, and what the age
// label says), STRUCTURAL for the chain — because the chain is where this
// feature can fail in total silence.
//
// THE SHAPE OF THE FAILURE THIS GUARDS
//
// The turn push existed for months and did nothing when tapped: `games_turn`
// carries game+room and no chatId, so it fell past every branch in the tap
// handler and opened the app wherever it already was. Nothing errored. The
// backend was signing events correctly, the phone was showing notifications
// correctly, and the feature was inert. The same silence is available to every
// link below.

import { readFileSync } from 'fs';
import { join } from 'path';
import { liveTableOf, agoLabel } from './liveTable';
import { readRootLayout } from '../../scripts/rootLayoutSources';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (src: string) =>
  src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const HOOK   = code(read('lib/games/useLiveTables.ts'));
const SOCKET = code(read('lib/games/useGameSocket.ts'));
const HUB    = code(read('app/games.tsx'));
const PUSH   = code(read('lib/push.ts'));
const LAYOUT = code(readRootLayout()); // app/_layout.tsx + components/root/useBootSequence.ts
const NOTIFY = code(read('vaultchat-backend-go/internal/routes/games_notify.go'));
const GAMES  = code(read('vaultchat-backend-go/internal/routes/games.go'));
const JOBS   = code(read('vaultchat-backend-go/internal/jobs/jobs.go'));
const MIG    = read('vaultchat-backend/migrations/125_games_live_tables.sql');

let failed = 0;
function A(ok: boolean, what: string): void {
  if (ok) { console.log('  ok   ' + what); return; }
  failed++;
  console.log('  FAIL ' + what);
}

console.log('\nYour games → the table\n');

// ── 1. which rows a player is shown ───────────────────────────────────
const good = { game: 'rummy', room: 't-42', yourTurn: true, title: 'Your turn', body: 'Srihari played a card', updatedAt: '2026-09-02T10:00:00Z' };
A(liveTableOf(good)?.room === 't-42', '1. a well-formed row parses');
A(liveTableOf({ ...good, game: 'carrom' }) === null,
  '1a. a game this app does not expose is dropped — /games falls back to the '
  + 'menu for an unknown kind, so the row would be a button that leads nowhere');
A(liveTableOf({ ...good, room: '   ' }) === null, '1b. a blank room is dropped');
A(liveTableOf(null) === null && liveTableOf('x') === null && liveTableOf({}) === null,
  '1c. junk is dropped without throwing — this is JSON off the network');
A(liveTableOf({ game: 'chess', room: 'r', yourTurn: 'yes', title: 7 })?.title === '',
  '1d. wrong-typed fields degrade to empty rather than reaching the renderer');

// ── 2. the age label ──────────────────────────────────────────────────
const at = (mins: number) => new Date(Date.now() - mins * 60000).toISOString();
A(agoLabel(at(0)) === 'just now', '2. under a minute reads "just now"');
A(agoLabel(at(5)) === '5m ago', '2a. minutes');
A(agoLabel(at(180)) === '3h ago', '2b. hours');
A(agoLabel(at(60 * 24 * 3)) === '3d ago', '2c. days');
A(agoLabel('not a date') === '',
  '2d. an unparseable timestamp renders NOTHING — never "NaN ago"');

// ── 3. the server remembers the table ─────────────────────────────────
A(/INSERT INTO games_live_tables/.test(NOTIFY) && /ON CONFLICT \(user_id, game, room\) DO UPDATE/.test(NOTIFY),
  '3. a turn notification upserts the table');
A(NOTIFY.indexOf('gamesRememberTable(ctx, userID') < NOTIFY.indexOf('tokens := fcmTokensFor'),
  '3a. BEFORE the push, so the list still exists for a phone with no token — '
  + 'the missed-notification case is the whole reason the list exists');
A(/gamesLiveKinds\[/.test(NOTIFY),
  '3b. and only for kinds that mean a table (a friend request is not one)');

// ── 4. reading it back, scoped ────────────────────────────────────────
A(/GET \/games\/tables/.test(GAMES) && /DELETE \/games\/tables/.test(GAMES),
  '4. both routes are registered');
A(/WHERE user_id = \$1/.test(GAMES),
  '4a. the read is scoped by user_id IN THE HANDLER — RLS is inert in prod, so '
  + 'a query that leaves scoping to a policy has no scoping at all');
A(/DELETE FROM games_live_tables WHERE user_id = \$1 AND game = \$2 AND room = \$3/.test(GAMES),
  '4b. and so is the delete — a room id is not a capability over someone else’s list');
A(/games_live_tables/.test(JOBS) && /INTERVAL '14 days'/.test(JOBS),
  '4c. the sweep ages rows out — the notify contract has NO game-over event, so '
  + 'nothing else would ever end a row on its own');

// ── 5. the app shows it, opens it, and clears it ──────────────────────
A(/'\/games\/tables'/.test(HOOK), '5. the hook reads the endpoint');
A(/status === 404\) \{ setTables\(\[\]\); setFailed\(false\); \}/.test(HOOK),
  '5a. a backend without the endpoint means an empty list, never an error — the '
  + 'two halves must be able to land in either order');
A(/else setFailed\(true\)/.test(HOOK) && /live\.failed/.test(HUB),
  '5a2. any other failure keeps the list and the hub offers a retry, instead of '
  + 'reading as "no games"');
A(/useFocusEffect\(refresh\)/.test(HOOK),
  '5a3. the list refreshes on focus, so coming back from a board is current');
A(/useLiveTables\(\)/.test(HUB) && /Your games/.test(HUB),
  '5b. the hub renders the list');
A(/onOpen\(tb\.game, \{ room: tb\.room \}\)/.test(HUB), '5c. and a row opens that table');
A(/const room = roomOverride\.current \?\? roomId;[\s\S]{0,80}void forgetTable\(game, room\)/.test(SOCKET),
  '5d. a finished snapshot drops the table from the list — the client is the '
  + 'ONLY party that ever learns a game ended');

// ── 6. THE TAP. This is the link that did not exist ───────────────────
A(/data\?\.type === 'games_turn'/.test(PUSH),
  "6. the tap handler matches 'games_turn' — without this branch the push fell "
  + 'through to the chat fallback, matched nothing, and did nothing at all');
A(/onGame\?\.\(String\(data\.game \?\? ''\), String\(data\.room \?\? ''\)\)/.test(PUSH),
  '6a. and hands on the two fields the backend mints');
A(/pathname: '\/games', params: game && room/.test(LAYOUT),
  '6b. which the root layout routes to that table');

// ── 7. the table it all rests on ──────────────────────────────────────
A(/CREATE TABLE IF NOT EXISTS games_live_tables/.test(MIG), '7. migration 125 creates it');
A(/PRIMARY KEY \(user_id, game, room\)/.test(MIG),
  '7a. keyed so a repeated turn notification updates one row rather than growing');
A(/REFERENCES users\(id\) ON DELETE CASCADE/.test(MIG),
  '7b. and a deleted user takes their list with them');

console.log(failed === 0 ? '\nAll good.\n' : `\n${failed} FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
