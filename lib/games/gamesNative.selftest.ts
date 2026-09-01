// lib/games/gamesNative.selftest.ts — run: npx tsx lib/games/gamesNative.selftest.ts
//
// Guards the one property the native games rest on: THE CLIENT DECIDES NOTHING.
//
// The games server owns the deck, the dice and the rules, and sends the legal
// moves outright (`legal` for chess, `movable` for ludo). The moment a board
// starts computing game truth locally it becomes a second rulebook, and the
// two players see different boards with no way to tell which is right. That
// failure is invisible in review — the code looks like a helpful improvement.
//
// So this asserts the shape of the dependency, not the pixels.

import { readFileSync, existsSync } from 'node:fs';

const HUB    = readFileSync('app/games.tsx', 'utf8');
const TTT    = readFileSync('components/games/TicTacToe.tsx', 'utf8');
const CHESS  = readFileSync('components/games/Chess.tsx', 'utf8');
const LUDO   = readFileSync('components/games/Ludo.tsx', 'utf8');
const RUMMY  = readFileSync('components/games/Rummy.tsx', 'utf8');
const HOOK   = readFileSync('lib/games/useGameSocket.ts', 'utf8');
const FEEDBACK = readFileSync('components/games/feedback.tsx', 'utf8');

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  (${detail})` : ''}`);
};

console.log('\nNative games\n');

// ── the WebView is gone ───────────────────────────────────────────────
check('the games hub no longer uses a WebView',
  !/react-native-webview/.test(HUB),
  'the whole point of this change');

// Comments stripped first: the header explains what this replaced, and naming
// the old URL there is documentation, not a dependency.
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

check('...and no longer loads the games site as a page',
  !/games\.corefinite\.com/.test(stripComments(HUB)),
  'the native screens reach the same server over a socket instead');

// ── all four are reachable ────────────────────────────────────────────
for (const [name, file] of [
  ['TicTacToe', 'components/games/TicTacToe.tsx'],
  ['Chess', 'components/games/Chess.tsx'],
  ['Ludo', 'components/games/Ludo.tsx'],
  ['Rummy', 'components/games/Rummy.tsx'],
] as [string, string][]) {
  check(`${name} exists`, existsSync(file));
  check(`...and the hub routes to it`, new RegExp(`<${name}\\b`).test(HUB));
}

// Deep links and the turn notifications already in the wild carry ?game=&room=.
// Dropping those params would silently break every invite ever sent.
// Matched loosely on purpose: the param type has grown (auto/bot for
// matchmaking) and will grow again. What must not change is that `game` and
// `room` are still read from the URL.
check('the hub still honours the game/room deep-link params',
  /useLocalSearchParams<\{[^}]*\bgame\?: string;[^}]*\broom\?: string;/.test(HUB),
  'existing invites and push notifications point here with them');

// ── every board goes through the shared socket ────────────────────────
for (const [name, src] of [['TicTacToe', TTT], ['Chess', CHESS], ['Ludo', LUDO], ['Rummy', RUMMY]] as [string, string][]) {
  check(`${name} renders from the server socket`,
    /useGameSocket\(/.test(src),
    'a board with its own transport would drift from the shared lifecycle');
}

// ── the client decides nothing ────────────────────────────────────────
// Chess must take its moves from the server's list, never generate them.
check('chess uses the server-sent legal move list',
  /state\.raw\?\.legal/.test(CHESS) && /legal\.filter\(m => m\.from === /.test(CHESS),
  'the alternative is a client rules engine and two disagreeing boards');

check('...and contains no move generation of its own',
  !/knight|bishopDirs|isInCheck|generateMoves|castl/i.test(CHESS.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')),
  'rules belong to the server; comments may mention them, code may not');

// Ludo must take movable tokens from the server, not compute reachability.
check('ludo uses the server-sent movable token list',
  /G\.movable/.test(LUDO) && /movable\.includes\(/.test(LUDO));

// Rummy must not judge a declaration — that is the whole game.
// Rummy now labels each group ("Pure Sequence", "Set") and warns before a
// misdeclare, which the reference client does too. The line that matters is not
// "no rules on the client" — it is that the hint may never GATE anything. If
// the hint and the server disagree, the player must still be able to declare
// and the server's answer must still be the one that counts.
check('the rummy meld hint never blocks a declaration',
  /label=\{hint\.valid \? 'Declare & win' : 'Declare anyway'\}/.test(RUMMY)
    && !/disabled=\{[^}]*hint\./.test(RUMMY),
  'a hint that disables Declare becomes a second rulebook with veto power');

check('...and the hint lives apart from the board',
  /from '\.\.\/\.\.\/lib\/games\/meldHint'/.test(RUMMY)
    && !/isValidSequence|isValidSet|validateMeld|scoreHand/i.test(RUMMY),
  'keeping it in one tested module is what stops it drifting into authority');

check('rummy shows other players a COUNT, never their cards',
  /handCount/.test(RUMMY) && !/opponentHand|otherHand/.test(RUMMY),
  'the server sends only this player\'s hand — that is the privacy property');

// ── the snapshot is authoritative ─────────────────────────────────────
check('state frames replace local state wholesale',
  /raw: s,/.test(HOOK) && /setState\(\{/.test(HOOK),
  'the protocol sends full snapshots, never deltas');

check('the hook keeps the raw frame',
  /raw: any/.test(HOOK),
  'chess legal/color and rummy hand ride at the TOP level beside `game`');

check('the socket is disposed on unmount',
  /sock\.dispose\(\)/.test(HOOK),
  'four screens sharing one hook means one place to leak, or none');

// ── wire shapes that have already bitten ──────────────────────────────
// Both of these rendered a perfect-looking board that could not be played,
// which is why they survived review: nothing looks wrong until you touch it.

// The server sends `Tokens []int` — a token IS its step. Reading `.step` off it
// yields undefined, coord() then returns undefined, and destructuring that
// crashes the whole board the moment a game starts.
check('ludo reads token steps as plain numbers',
  !/tok\.step|\.tokens\[[^\]]*\]\.step|k\.step/.test(LUDO),
  'tokens are number[], not {step}[]');

// Chess seats by COLOUR. isMyTurn() only understands turnPlayerId or a numeric
// turn against a numeric seat, so using it here made every square inert.
check('chess decides the turn by colour, not by seat',
  /G\?\.turn === myColor/.test(CHESS) && !/isMyTurn\(/.test(stripComments(CHESS)),
  'the shared seat-index helper always returns false for chess');

// ── the look is shared, not re-invented per board ─────────────────────
// The first native boards styled themselves from VaultChat's app palette and
// came out looking like four different settings screens. The table has its own
// identity and every board draws from it.
for (const [name, src] of [['TicTacToe', TTT], ['Ludo', LUDO], ['Rummy', RUMMY]] as [string, string][]) {
  check(`${name} uses the games theme`,
    /from '\.\.\/\.\.\/lib\/games\/theme'/.test(src) && !/from '\.\.\/\.\.\/lib\/theme'/.test(src),
    'the app palette makes a card table look like a form');
}

check('the boards share one set of table furniture',
  [TTT, LUDO, RUMMY].every(src => /from '\.\/ui'/.test(src)),
  'per-board buttons and panels are how four screens drift apart');

// ── every board has the same furniture ────────────────────────────────
// These were added one game at a time and drifted immediately: a win that
// showed confetti in Ludo and nothing in Rummy reads as a bug in Rummy. If a
// fifth board ever appears, this is what tells you what it still owes.
for (const [name, src] of [['TicTacToe', TTT], ['Chess', CHESS], ['Ludo', LUDO], ['Rummy', RUMMY]] as [string, string][]) {
  check(`${name} shows server notices as toasts`, /<Toasts events=/.test(src));
  check(`${name} celebrates a win`, /<Confetti show=/.test(src));
  check(`${name} can invite someone to the table`, /inviteToTable\(/.test(src));
  check(`${name} offers a rematch and a share`, /shareResult\(/.test(src) && /(Rematch|Play again|Deal again)/.test(src));
}

// ── voice ─────────────────────────────────────────────────────────────
const VOICE = readFileSync('lib/games/useTableVoice.ts', 'utf8');

// The SFU these used to check is gone: /api/voice/token answers 404 and the
// deployment reports sfu:false, so voice is now a peer-to-peer mesh (see the
// header of useTableVoice.ts). The GUARANTEES did not change — only where they
// are enforced — so these assert the mesh's enforcement points, not LiveKit's.
check('voice asks the SERVER whether this player may speak',
  /setCanSpeak\(!m\.spectator\)/.test(VOICE),
  'a client deciding its own publish rights is what the state frame closes');

check('...and a spectator cannot be heard even once the mic is open',
  /const startMuted = !canSpeak/.test(VOICE) && /if \(!s \|\| !canSpeak\) return/.test(VOICE),
  'a mesh has no server-side publish gate, so the track must start disabled AND mute must refuse to lift');

check('...and does not re-install the WebRTC globals',
  /typeof g\.RTCPeerConnection !== 'undefined'/.test(VOICE),
  'registering twice swaps the constructors under a running SDK');

check('the microphone cannot outlive the table',
  /alive\.current = false; teardown\(\)/.test(VOICE),
  'a room left connected keeps publishing from a board nobody is looking at');

// ── online ────────────────────────────────────────────────────────────
// Without matchmaking the only opponent reachable from the app is a bot, which
// is what made a fully multiplayer game feel like single-player.
check('the hub can find a real opponent',
  /useQuickMatch\(/.test(HUB),
  'Quick Match is the difference between multiplayer and playing the house');

const QM = readFileSync('lib/games/useQuickMatch.ts', 'utf8');
check('...over the matchmaker socket, reusing the games session',
  /\/live\/ws/.test(QM) && /establishGamesSession/.test(QM),
  'a second session handshake is a second place to get credentials wrong');

check('...and leaves the queue when the player walks away',
  /return \(\) => \{ aliveRef\.current = false; close\(\); \}/.test(QM),
  'a stale queue entry pairs someone against a socket that stopped listening');

// ── what stays off the render path ────────────────────────────────────
//
// These three are the difference between a board that redraws when something
// happened and one that redraws on a timer. They are all invisible: delete any
// of them and the games still work, still pass every other check here, and just
// get slower on exactly the devices least able to afford it — which is why they
// are asserted rather than left to review.

check('the ludo board is memoised',
  /React\.memo\(function BoardSvg/.test(LUDO),
  '~80 SVG nodes with gradient fills, redrawn on every roll and every move to show the same picture');

check('a rummy hand card is memoised',
  /React\.memo\(function HandCard/.test(RUMMY),
  'thirteen cards each rebuilding four shared values and a gesture pair');

check('...and its tap handler is stable, or the memo is decoration',
  /onPress=\{toggle\}/.test(RUMMY) && /runOnJS\(onPress\)\(card\.id\)/.test(RUMMY),
  'an inline () => toggle(id) is a new prop every render and defeats the memo entirely');

check('the turn clock re-renders once a second, not on every tick',
  /setSecs\(secondsLeft\(deadline, Date\.now\(\)\)\)/.test(RUMMY) && !/setNow\(Date\.now\(\)\)/.test(stripComments(RUMMY)),
  'holding the raw clock reading makes every tick a new value, so React can never bail out');

// ── the board the reference client actually shows ─────────────────────
check('chess opens on the green board, like the web',
  /let boardPref: ThemeName = 'green'/.test(CHESS),
  "chess.js does `if (!settings.board) settings.board = \"green\"`; this port opened on a theme the web does not have");

check('...and remembers the one the player picks',
  /AsyncStorage\.setItem\(BOARD_KEY/.test(CHESS),
  'the web persists it; re-picking every launch is how a setting reads as broken');

check('a piece is outlined, not haloed',
  /OUTLINE\.map/.test(CHESS) && !/textShadowRadius/.test(stripComments(CHESS)),
  'a blurred shadow stood in for the stroke the web gets from -webkit-text-stroke');

// ── talking at the table ──────────────────────────────────────────────
// The voice mesh was already wired into chess, but only as a bar BELOW the
// board, both seats and the status line — past the fold on a phone, which is
// indistinguishable from not having it.
check('the table voice room is shared, not per-board',
  /export function VoiceSheet\(/.test(FEEDBACK) && !/function VoiceSheet\(/.test(RUMMY),
  'a second copy for chess is a second thing to fix when the mesh changes');

check('...and chess can reach it without scrolling',
  /<VoiceSheet/.test(CHESS) && /setVoiceOpen\(true\)/.test(CHESS),
  'a voice control below the fold is one the player never finds');

// ── standings ─────────────────────────────────────────────────────────
const LB = readFileSync('lib/games/leaderboard.ts', 'utf8');
check('the leaderboard does not re-rank the server',
  !/\.sort\(/.test(LB),
  'the server orders and cuts the table; sorting here would show a standing it does not agree with');

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all native-games checks passed\n');
process.exit(failures ? 1 : 0);
