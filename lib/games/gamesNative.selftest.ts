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
const UI     = readFileSync('components/games/ui.tsx', 'utf8');
const CLOCK  = readFileSync('lib/games/useCountdown.ts', 'utf8');

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
  // openInvite(), not inviteToTable(): the invite now opens a chat picker and
  // posts a card into the thread, with the OS share sheet kept behind it as the
  // way to reach someone who does not have VaultChat.
  check(`${name} can invite someone to the table`, /openInvite\(/.test(src));
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

// Lifted out of Rummy into a hook every board can use — the property being
// guarded did not change with the address.
check('the turn clock re-renders once a second, not on every tick',
  /setSecs\(secondsLeft\(deadline, Date\.now\(\)\)\)/.test(CLOCK) && !/setNow\(Date\.now\(\)\)/.test(stripComments(CLOCK)),
  'holding the raw clock reading makes every tick a new value, so React can never bail out');

// ── the board the reference client actually shows ─────────────────────
check('chess opens on the green board, like the web',
  /let boardPref: ThemeName = 'green'/.test(CHESS),
  "chess.js does `if (!settings.board) settings.board = \"green\"`; this port opened on a theme the web does not have");

check('...and remembers the one the player picks',
  /AsyncStorage\.setItem\(BOARD_KEY/.test(CHESS),
  'the web persists it; re-picking every launch is how a setting reads as broken');

check('a piece is outlined, not haloed',
  /OUTLINE\.map/.test(CHESS) && /const PIECE_STROKE = 1\.2/.test(CHESS),
  'a blurred shadow stood in for the stroke the web gets from -webkit-text-stroke');

check("...in chess.css's own ink",
  /fill: '#f4f0e6', line: '#2b2620'/.test(CHESS) && /fill: '#1d1a16', line: '#000000'/.test(CHESS),
  'a light stroke on black is a different piece set — it engraves a solid knight');

check('the check marker is not dimmed by its own pulse',
  /const CHECK_RED = '#e15a5a'/.test(CHESS),
  'a .55 colour at .55 opacity lands at .30 — half the alarm the reference raises');

check('coordinates ring two edges, not four',
  /coordFile=\{coords && \(d >> 3\) === 7/.test(CHESS) && !/coordRankRight/.test(CHESS),
  'chess.css places one file row and one rank column; four edges is sixteen extra labels');

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

// ── a dropped socket ──────────────────────────────────────────────────
// A mid-game drop used to take the whole screen back to "Joining the table…",
// which reads as if the game were gone. The board underneath is the last thing
// the server said and is still the best thing to show; what must NOT survive is
// input, because an intent sent into a closed socket is dropped in silence and
// the player never learns their move did not happen.
for (const [name, src] of [['tic-tac-toe', TTT], ['chess', CHESS], ['ludo', LUDO], ['rummy', RUMMY]] as [string, string][]) {
  check(`${name} keeps the board up while reconnecting`,
    /&& !G\)|&& !state\.game\)|&& !!G;/.test(stripComments(src)),
    'a full-screen spinner mid-game throws away the position the player was looking at');
  check(`...and ${name} disables input while the socket is down`,
    /phase === 'connected'/.test(stripComments(src)),
    'a tap that goes nowhere is worse than a disabled button');
}

check('the reconnect banner is shared, not copied into four boards',
  /export function Reconnecting\(/.test(UI),
  'four copies is four things to fix when the wording changes');

// ── the turn clock ────────────────────────────────────────────────────
// Rendered from the SERVER's deadline, and only when it sends one.
check('the turn clock is one hook, shared by every board',
  /export function useCountdown/.test(CLOCK) && !/function useCountdown/.test(stripComments(RUMMY)),
  'it started as rummy-only; the other three had no clock at all');
check('...built on the tested secondsLeft, not a second implementation',
  /from '\.\/rummyTable'/.test(CLOCK),
  'secondsLeft already refuses a deadline the device clock says is nonsense');
check('...and no deadline shows no clock',
  /if \(secs == null\) return null;/.test(UI),
  'a frozen 0s is a claim about a game this client does not referee');

// ── a bot is always a bot ─────────────────────────────────────────────
for (const [name, src] of [['tic-tac-toe', TTT], ['chess', CHESS], ['ludo', LUDO], ['rummy', RUMMY]] as [string, string][]) {
  check(`${name} labels a bot seat`,
    /isBot/.test(stripComments(src)),
    'filling an empty room with unlabelled bots is how these apps lose trust');
}

// ── the matchmaker does not lie ───────────────────────────────────────
// `botoffer` means NOBODY WAS WAITING. Opening that room with bot:'1' seated a
// player who asked for an opponent against the house without telling them —
// and with ~19 players registered that is the common path, not an edge case.
check('a bot offer is not opened as if it were a match',
  /if \(withBot\) \{ setOffer/.test(HUB),
  'the search must stop and let the player choose');
check('...and the offer puts inviting someone beside the bot',
  /<BotOffer/.test(HUB) && /openInvite\(/.test(HUB),
  'an invite is the only thing that actually fixes an empty room');

// ── the rematch ───────────────────────────────────────────────────────
// `start` on the same table already WAS the rematch; what was missing is what
// happens when it does not work. A player whose opponent had already left
// tapped a button that fired into the socket and changed nothing on screen.
const REMATCH = readFileSync('lib/games/useRematch.ts', 'utf8');
for (const [name, src] of [['tic-tac-toe', TTT], ['chess', CHESS], ['ludo', LUDO], ['rummy', RUMMY]] as [string, string][]) {
  check(`${name} rematches through the shared control`,
    /<RematchBtn/.test(src) && /useRematch\(/.test(src),
    'four boards must not disagree about what waiting for a rematch looks like');
}
check('the rematch is still `start` on the same table',
  /send\(\{ t: 'start' \}\)/.test(REMATCH),
  'a fresh room would throw away the seats the server already has');
check('...the wait ENDS',
  /setTimeout\(\(\) => \{ setWaiting\(false\); setTimedOut\(true\); \}, WAIT_MS\)/.test(REMATCH),
  'an indefinite spinner is what this replaced');
check('...it ends on the SERVER’s snapshot, not on the button firing',
  /if \(!isFinished && waiting\)/.test(REMATCH),
  'the tap is not evidence that anything happened');
check('...and an empty seat becomes an invite, not a longer wait',
  /openInvite\(game, room\)/.test(REMATCH),
  'an invite is the only thing that reaches a player who has closed the app');

// ── three ways in, and none of them is a dead end ─────────────────────
// THE BUG THIS CLOSES: tapping a game opened it with NO room, which lands the
// player in the server's default table — one somebody else already hosts. Only
// a host may seat a bot or deal, so the two buttons on screen did nothing and
// said nothing. A lobby you cannot start is what "the games don't work" was.
check('a game card asks HOW you want to play',
  /<ModeSheet/.test(HUB) && /function ModeSheet/.test(HUB),
  'opening a game with no room drops the player in a table they cannot host');
check('...and the private and bot rooms are ones the player HOSTS',
  /onPrivate=\{\(\) => \{ const e = mode; setMode\(null\); onOpen\(e\.kind, \{ room: newPrivateCode\(\) \}\)/.test(HUB)
  && /room: newPrivateCode\(\), auto: '1', bot: '1'/.test(HUB),
  'a fresh code makes the player the host, which is what makes the buttons work');
check('...with online play still going through the matchmaker',
  /onOnline=\{\(\) => \{ const e = mode; setMode\(null\); quick\(e\); \}\}/.test(HUB));

// ── dealing is not a race ─────────────────────────────────────────────
// Ludo sent `start` on a 400ms timer after `addbot`. The bot was seated by a
// LATER snapshot, so start reached the server while the table still had one
// player, was refused, and the lobby sat there with a bot in it. Device-seen.
check('ludo deals when the seats arrive, not on a timer',
  !/setTimeout\(\(\) => send\(\{ t: 'start'/.test(LUDO) && /if \(\(L\.members\?\.length \?\? 0\) < wantStart\) return;/.test(LUDO),
  'a fixed delay loses the race on any slow link, and the table never starts');
check('...and it deals exactly once',
  /if \(startedRef\.current\) return;/.test(LUDO),
  'the server answers a second start with an error, which reads as a broken table');

// ── a private room is people you know ─────────────────────────────────
for (const [name, src] of [['tic-tac-toe', TTT], ['chess', CHESS], ['ludo', LUDO]] as [string, string][]) {
  check(`${name} offers voice in the LOBBY, not only mid-game`,
    /<VoiceBar/.test(src),
    'waiting for the person you invited is exactly when you want to talk');
  check(`...and ${name} shows the room code to share`,
    /Room code:/.test(src),
    'a private table nobody can be told the code of is a table for one');
}
check('rummy already had both',
  /<VoiceSheet/.test(RUMMY) && /Code \$\{seated\}|Code \$\{code\}|`Code /.test(RUMMY));

// ── a board cannot take the app down ──────────────────────────────────
// Without a boundary a render error unmounts the tree and leaves a blank
// screen with no way back — reported as "the app crashed while playing", and
// invisible in the crash log because nothing native crashed. The boards render
// fields from a reverse-engineered protocol, so an unexpected shape is a
// question of when, not if.
check('the games board is wrapped in an error boundary',
  /<ErrorBoundary/.test(HUB) && /screen=\{`Game:\$\{kind\}`\}/.test(HUB),
  'every other screen rendering untrusted shapes already does this');
check('...and the boundary offers a way out, not just a message',
  /Try Again/.test(readFileSync('components/ErrorBoundary.tsx', 'utf8')));

// ── a deep link must not open a dead app ──────────────────────────────
// hideAsync() lives only in app/index.tsx, the cold-start router at `/`. A cold
// start from a deep link routes straight past it, so nothing hid the splash:
// the window never became visible, never got an input channel, and every touch
// was dropped until Android raised "isn't responding". Device-reproduced on two
// phones. This is the guard for the whole notification/invite path.
const LAYOUT = readFileSync('app/_layout.tsx', 'utf8');
check('a deep-link cold start hides the splash',
  /Linking\.getInitialURL\(\)[\s\S]{0,200}SplashScreen\.hideAsync/.test(LAYOUT),
  'without this a turn push or an invite card opens an app that takes no input');
check('...and the launcher path still hides it in index.tsx',
  /SplashScreen\.hideAsync/.test(readFileSync('app/index.tsx', 'utf8')),
  'index covers its own auth read with the splash — moving it would flash a spinner');

// ── two devices, one truth ────────────────────────────────────────────
// Found with two phones in one room: chess announced every square by its DRAWN
// position, so the player with black — whose board is flipped — heard the
// mirrored name for every square (the pawn on e4 read as "d5"). The VISIBLE
// coordinates were always right, which is exactly why nobody saw it.
check('chess names a square by the square, not by where it is drawn',
  /squareLabel\(sq, piece/.test(CHESS) && /function squareLabel\(sq: number/.test(CHESS),
  'on a flipped board the display index is a different square entirely');

// The rummy server answers a join for a table it does not know by seating you
// at one of its own and saying nothing. Two phones sharing a code both landed
// on "Practice", each reading "1/6 seated", each waiting for someone who could
// never arrive.
check('rummy admits when the server substituted the table',
  /const substituted =/.test(RUMMY) && /This is a public table/.test(RUMMY),
  'a code nobody can join is worse than no code');
check('...and stops offering a code to share in that case',
  /\{substituted \? \(/.test(RUMMY));

// The dice receipt says "not published" because this server never reveals its
// half, so the hub must not promise a proof the player cannot perform.
check('the hub does not claim provably fair dice',
  !/provably fair/i.test(HUB),
  'the receipt shows "table seed: not published" — the claim outran the server');

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all native-games checks passed\n');
process.exit(failures ? 1 : 0);
