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

// Table voice has moved TWICE and these assertions have to move with it. It
// began on the games server's own SFU (/api/voice/token — 404, and the
// deployment reports sfu:false), became a peer-to-peer mesh port of the web
// client, and is now a room on VaultChat's OWN LiveKit cluster, minted by our
// backend at POST /games/voice-token. The GUARANTEES are the same each time;
// only the place that enforces them moves, so these follow the enforcement.
check('voice asks the SERVER whether this player may speak',
  /setCanSpeak\(!m\.spectator\)/.test(VOICE),
  'a client deciding its own publish rights is what the state frame closes');

// The header still NAMES the games server's dead endpoint, because the history
// is the argument for the current design. What must not come back is a call to
// it — so this asserts the token comes from our own api() and that the games
// origin is not reachable from this file at all.
check('...and the token is minted by VaultChat, never by the games server',
  /api<VoiceToken>\('\/games\/voice-token'/.test(VOICE) && !/GAMES_HTTP/.test(VOICE),
  'the games server has no SFU and no token endpoint — asking it was the original bug');

// Now enforced at the MEDIA SERVER rather than by the client keeping its own
// track disabled: a spectator is minted with the `audience` role, which carries
// no publish grant at all. The client still declines to open the microphone,
// so a listener never even prompts for the permission.
check('...and a spectator cannot be heard, at the server and not by agreement',
  /spectator: !canSpeak/.test(VOICE) && /publish: canSpeak/.test(VOICE)
    && /if \(!s \|\| !canSpeak\) return/.test(VOICE),
  'the audience role has no publish grant; the client must also ask for it and refuse to unmute');

// The mesh had to install the WebRTC globals itself and guard against doing it
// twice. joinSfuRoom owns that now (lib/golive/room.ts), and the correct thing
// for this file is to NOT touch them — a second registerGlobals() swaps the
// constructors under an SDK that is already running on them.
check('...and does not install the WebRTC globals itself',
  !/registerGlobals\(\)/.test(VOICE),
  'joinSfuRoom already guards this; a second registration swaps the constructors under a live SDK');

check('the microphone cannot outlive the table',
  /alive\.current = false; void teardown\(\)/.test(VOICE)
    && /void teardown\(\); \}, \[roomId, game, teardown\]/.test(VOICE),
  'a room left connected keeps publishing from a board nobody is looking at — on unmount AND on changing table');

// The audio ROUTE is shared with calls and Go Live, and handing back a session
// we never took is how opening rummy during a call cut the call.
// TURN, and why this file no longer pins it directly.
//
// lib/games/turnWiring.selftest.ts used to assert that useTableVoice fetched
// VaultChat's TURN list and handed it to each peer connection — the bug it was
// written for being that the mesh used the games server's STUN-only list and
// never asked for ours, so a player behind CGNAT could not be heard and every
// test still passed. Table voice now goes through joinSfuRoom, which fetches
// getIceServers() itself and passes it as `rtcConfig` to room.connect(); that
// is pinned, on the same file, by lib/golive/turnWiring.selftest.ts. Two copies
// of one rule is how they drift, so what is left here is the LINK: as long as
// voice joins through that helper, the TURN wiring is the wiring already tested.
check('table voice joins through the shared SFU helper, which carries our TURN',
  /joinSfuRoom\(/.test(VOICE) && !/new RTCPeerConnection/.test(VOICE),
  'a peer connection built here would bypass the ICE list lib/golive/room.ts assembles');

check('...and only hands back the audio route if it took one',
  /const wasJoined = joined\.current/.test(VOICE) && /if \(wasJoined\) \{ try \{ stopBroadcastAudio\(\)/.test(VOICE),
  'teardown runs on unmount too, whether or not voice was ever joined');

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
check('chess opens on the GLASS board, like the other three games',
  /let boardPref: ThemeName = 'glass'/.test(CHESS),
  "the four games share one look; this outranks matching chess.com's green default here (changed 2026-09-04)");
check('...and green is still offered, since it is what the web uses',
  /green:\s*\{ light:/.test(CHESS),
  'dropping the reference client’s own board would be a different decision from changing the default');

check('...and remembers the one the player picks',
  /AsyncStorage\.setItem\(BOARD_KEY/.test(CHESS),
  'the web persists it; re-picking every launch is how a setting reads as broken');

// THE PIECES ARE VECTORS NOW (2026-09-07). They were Unicode glyphs, and that
// was a device risk rather than a style: a glyph is drawn by whatever font the
// platform resolves it to, every Android skin ships its own symbol fonts, and
// on one that renders the outline set solid the white king comes out black —
// a board where you cannot tell your own pieces apart. A path is one shape
// everywhere, and it takes a real stroke instead of four offset copies.
check('a piece is a VECTOR, outlined not haloed',
  /const PIECE_PATH: Record<string, string>/.test(CHESS)
    && /const PIECE_STROKE = 2\.2/.test(CHESS)
    && !/OUTLINE\.map/.test(stripComments(CHESS)),
  'four offset copies of a text glyph were faking the stroke a path simply has');
check('...and every piece letter has a path',
  (() => {
    const from = CHESS.slice(CHESS.indexOf('const PIECE_PATH'));
    const body = from.slice(0, from.indexOf('};'));
    // No backslash escapes here on purpose: this file is generated as a plain
    // string, and `\s` collapses to a literal `s` on the way in — which reads
    // as a failing board rather than a failing regex.
    return ['p', 'r', 'b', 'n', 'q', 'k'].every(k => new RegExp('^[ ]+' + k + ':', 'm').test(body));
  })(),
  'a letter with no path draws nothing, and an empty chess square reads as captured');

check("...in chess.css's own ink",
  /fill: '#f4f0e6', line: '#2b2620'/.test(CHESS) && /fill: '#1d1a16', line: '#000000'/.test(CHESS),
  'a light stroke on black is a different piece set — it engraves a solid knight');

check('the check marker is not dimmed by its own pulse',
  /const CHECK_RED = '#e15a5a'/.test(CHESS),
  'a .55 colour at .55 opacity lands at .30 — half the alarm the reference raises');

// MOVED OFF THE SQUARES (2026-09-06). chess.css draws the labels inside the
// first column and last row, which means eight squares carry a mark a piece
// then stands on top of — and on a phone the label and the piece are fighting
// over the same 40dp. They sit on the felt rail now, the way a real board does.
// What did NOT change is how MANY: one rank column, one file row.
check('coordinates sit on the rail, not on the squares',
  /position: 'absolute', left: 0, width: rail/.test(CHESS)
    && /left: rail \+ i \* cell, width: cell/.test(CHESS)
    && !/coordFile=/.test(CHESS),
  'a label inside a square is a label a piece then stands on');
check('...and it is still one rank column and one file row',
  /key=\{`rk\$\{i\}`\}/.test(CHESS) && /key=\{`fl\$\{i\}`\}/.test(CHESS),
  'four edges is sixteen extra labels crowding the board');

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
// The sheet was hub-local until chess grew a Stats control of its own
// (2026-09-06). Copying it into the board would have been the same defect the
// VoiceSheet check above exists to stop: two surfaces reading one server, and
// two places to fix when it changes what it ranks by.
const LBS = readFileSync('components/games/LeaderboardSheet.tsx', 'utf8');
check('the standings sheet is shared, not one per screen',
  /export default function LeaderboardSheet\(/.test(LBS)
    && !/function LeaderboardSheet\(/.test(HUB)
    && !/function LeaderboardSheet\(/.test(CHESS),
  'a second copy drifts the moment the server changes its ordering');
check('...and chess opens it on the chess table',
  /<LeaderboardSheet[\s\S]{0,200}initialScope="chess"/.test(CHESS),
  'a player standing at the chess board is asking about chess, not about Overall');
check('...on every open, not only the first',
  /if \(visible\) setScope\(initialScope\)/.test(LBS),
  'a sheet that never unmounts keeps whichever tab was last looked at');

// Chess's player list is the LOBBY ROSTER, not a list of its own — and it
// refuses to name a side it cannot derive. The frame carries `color` for this
// client only, so with three seats the other side is a guess.
check('the chess roster reads the lobby the server sent',
  /const members = state\.lobby\?\.members \?\? \[\];/.test(CHESS),
  'a second roster is a second thing to go stale');
check('...and never names a side it cannot know',
  /members\.length === 2 && myColor != null/.test(CHESS),
  '`color` is sent for this client alone; the other seat is an inference that holds for two');

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
  /onOpen\(e\.kind, \{ room: newPrivateCode\(\) \}\)/.test(HUB)
  && /room: newPrivateCode\(\), auto: '1', bot: '1'/.test(HUB),
  'a fresh code makes the player the host, which is what makes the buttons work');
check('...with online play going through the matchmaker',
  /quick\(e\);/.test(HUB));

// ── RUMMY TAKES NO INVENTED ID ────────────────────────────────────────
// THE BUG THIS CLOSES: rummy tables belong to the SERVER, and it silently seats
// you at one of its own when it does not recognise the id you sent. So "Play
// online" (which passed the matchmaker's roomId) and "Private room" (a freshly
// minted code) both substituted two players onto different tables, each reading
// "1/6 seated" — "online and private rummy both do not connect". Device-proven
// cure: joining a REAL table id seats both phones together at "2/6 seated".
//
// Structural, because it is a WIRING bug: every piece worked and none of them
// was joined to a real table.
check('rummy asks for a seat INTENT rather than minting a table id',
  /if \(e\.kind === 'rummy'\) \{ onOpen\('rummy', \{ seat: 'auto' \}\); return; \}/.test(HUB),
  'a minted rummy code is substituted by the server and the player sits alone');
check('...for the bot mode too, at a practice table',
  /if \(e\.kind === 'rummy'\) \{ onOpen\('rummy', \{ seat: 'bot', auto: '1', bot: '1' \}\); return; \}/.test(HUB));
check('...and rummy never reaches the matchmaker, whose room is not a table',
  /if \(e\.kind === 'rummy'\) \{ onOpen\('rummy', \{ seat: 'auto' \}\); return; \}[\s\S]{0,40}?quick\(e\);/.test(HUB),
  'the rummy branch must return BEFORE quick(e), or online rummy is dead again');
check('the board picks its table from the list the server sent',
  /pickTable\(tables, seat\)/.test(RUMMY) && /import \{[\s\S]*?pickTable/.test(RUMMY),
  'choosing from the tables frame is what makes the id real');
check('...exactly once, so a filling table cannot bounce the player',
  /asked\.current = true;/.test(RUMMY));

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

// ── a deep link must not open a dead or unguarded app ─────────────────
const LAYOUT = readFileSync('app/_layout.tsx', 'utf8');
check('the root hides splash only after its auth/capture gate',
  /if \(launchReady\) SplashScreen\.hideAsync/.test(LAYOUT) &&
  /Promise\.all\(\[secure, getLaunchSessionState\(\), isMfaEnabled\(\)\]\)/.test(LAYOUT),
  'deep links bypass index, so the root must protect their first frame');

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

// Chess reports the winner as a COLOUR ('w'/'b'), the same convention
// lib/games/history.ts reads (see outcomeOf). `game.you` does not exist on the
// game object — `you` sits beside `game` on the socket frame — so comparing
// `game.winner === game.you` silently compared a colour to `undefined` and
// every decisive game fell through to the LOSING branch: wrong banner tone,
// wrong sfx, no confetti, wrong share text, regardless of who actually won.
check('chess compares the winner against the colour you play, not game.you',
  !/game\.winner === game\.you/.test(CHESS) && !/G\.winner === state\.you/.test(CHESS),
  'the winner is a colour; game.you and state.you are not the same field');
check('...and the pieces that decide win/lose read myColor',
  /G\.winner === myColor/.test(CHESS) && /game\.winner === myColor/.test(CHESS),
  'sfx, share, confetti and the status line all need the same fix or one of them still lies');

// The same "+0 coins" defect the history list already had (lib/games/history.ts
// detailOf) had a second, separate occurrence in Rummy's own live result table:
// `d >= 0` put a zero settlement in the winning-green branch with a leading '+'.
check('the rummy result table does not colour a zero settlement as a win',
  !/d >= 0 \? C\.good/.test(RUMMY) && !/d >= 0 \? `\+\$\{d\}`/.test(RUMMY),
  'a zero delta says nothing happened, not that something good happened');

/* ── design tokens that do not exist ────────────────────────────────── */
//
// TWO BUGS OF THE SAME SHAPE, and the compiler can see NEITHER: tsconfig sets
// `noImplicitAny: false`, so indexing a plain object with a key it does not
// have is silently `any` rather than an error, and it reaches the device as
// `undefined`.
//
//   goldLine[40] / goldLine[12]  — the SELECTED chip in rummy's table filter.
//     goldLine defines 14/18/22/28/38/55. Both resolved to undefined, so the
//     selected chip rendered with no border colour and no fill and the only
//     mark of selection was the text weight.
//
//   icon="crown" on Btn — ICONS has no such key, so the button falls through
//     to Btn's raw-text branch and draws the literal string. ui.tsx already
//     carries a comment about exactly this happening with four emoji.
//
// Neither is a typo a reviewer catches, and neither throws. They are only
// visible on a screen nobody can currently reach, so they are asserted here.
{
  // Comments stripped first — the same treatment rummyTable.selftest gives its
  // own source scans. Without it this check fails on the note in Rummy.tsx that
  // NAMES the two bad indexes, which is the one place they should still appear.
  const code = (src: string) =>
    src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  const SOURCES: [string, string][] = ([
    ['app/games.tsx', HUB], ['TicTacToe.tsx', TTT], ['Chess.tsx', CHESS],
    ['Ludo.tsx', LUDO], ['Rummy.tsx', RUMMY], ['ui.tsx', UI], ['feedback.tsx', FEEDBACK],
  ] as [string, string][]).map(([n, src]) => [n, code(src)] as [string, string]);

  // EVERY numeric token ramp, not just goldLine. `S`, `R`, `E` and `goldLine`
  // are all plain objects indexed by a literal, so they all carry the same
  // failure — `S[7]` or `R[5]` would be exactly as invisible as `goldLine[40]`
  // was. Discovering the ramps from theme.ts rather than listing them means a
  // ramp added later is covered without anyone remembering to come back here.
  const themeSrc = readFileSync('lib/games/theme.ts', 'utf8');
  const ramps = new Map<string, Set<string>>();
  for (const m of themeSrc.matchAll(/export const (\w+)\s*=\s*\{/g)) {
    const body = themeSrc.slice(m.index! + m[0].length);
    const keys = new Set(
      // NOT line-anchored. `S` and `R` are written on ONE line, so an anchored
      // pattern reads a single key off each and silently passes every index
      // above it — the first draft of this very check did that.
      Array.from(body.slice(0, body.indexOf('}')).matchAll(/(?:^|[{,])\s*(\d+)\s*:/g), x => x[1]),
    );
    if (keys.size >= 3) ramps.set(m[1], keys);
  }
  check('the numeric token ramps are discovered from theme.ts',
    ramps.has('goldLine') && ramps.has('S') && ramps.has('R'),
    `found ${[...ramps.keys()].join()}`);
  check('...and each is read whole, not truncated at its first key',
    (ramps.get('S')?.size ?? 0) >= 6 && (ramps.get('goldLine')?.size ?? 0) >= 5,
    `S=${ramps.get('S')?.size} goldLine=${ramps.get('goldLine')?.size}`);

  let badToken = '';
  for (const [name, src] of SOURCES) {
    for (const [ramp, keys] of ramps) {
      for (const m of src.matchAll(new RegExp('\\b' + ramp + '\\[(\\d+)\\]', 'g'))) {
        if (!keys.has(m[1])) badToken = `${name}: ${ramp}[${m[1]}] is not defined (has ${[...keys].join('/')})`;
      }
    }
  }
  check('every token ramp index used is one that exists', !badToken, badToken);

  const iconBlock = UI.slice(UI.indexOf('const ICONS = {'));
  const iconKeys = new Set(
    Array.from(iconBlock.slice(0, iconBlock.indexOf('};')).matchAll(/^\s*([A-Za-z][\w]*):/gm), m => m[1]),
  );
  check('the icon set parses', iconKeys.size >= 10, `${iconKeys.size} icons`);

  let badIcon = '';
  for (const [name, src] of SOURCES) {
    for (const m of src.matchAll(/\bicon="([A-Za-z][\w]*)"/g)) {
      if (!iconKeys.has(m[1])) badIcon = `${name}: icon="${m[1]}" is not in ICONS`;
    }
  }
  check('every Btn icon name is one the icon set defines', !badIcon, badIcon);
}

/* ── the two controls the owner asked to be made real ───────────────── */
//
// Both were deliberately not built the first time round because neither had a
// handler, and a dead control reads to a player as a broken one. They are wired
// now, so what is asserted is that they stayed wired to REAL data rather than
// drifting back into decoration.
check('the table list filters by kind as well as by seat count',
  /filterByKind\(/.test(RUMMY) && /KIND_FILTERS/.test(RUMMY),
  'Practice / Free / Bots has to filter the server list, not just look like tabs');

check('...and the Bots tab actually seats a bot when you join',
  /onJoin\(tb\.id, kind === 'bots'\)/.test(RUMMY) && /autoBot: autoBot \|\| wantBot/.test(RUMMY),
  'the tab lists the same tables as Practice; the difference IS the join');

check('...through the hook that already owns auto-start, not a second copy',
  !/t: 'addbot'/.test(RUMMY.slice(0, RUMMY.indexOf('function Room'))),
  'a board-side addbot would race the hook and double-seat');

check('the score strip caps deadwood at what the hand can actually lose',
  /Math\.min\(MAX_LOSS, hint\.deadwood\)/.test(RUMMY),
  'raw deadwood reads 90 on a fresh deal; a misdeclare never costs more than 80');

check('Score opens the standings from server data',
  /StandingsSheet/.test(RUMMY) && /setShowStandings\(true\)/.test(RUMMY));

// THREE layouts, and Standings must be reachable in all of them: the score
// PANEL beside the hand on a wide screen, the compact trio in the action bar
// when the panel does not fit, and a button of its own when even the trio is
// dropped. Counting the entry points is what keeps a later layout change from
// quietly stranding the control on one breakpoint.
// FOUR ways in, and the last one is the guarantee. The action bar gives up its
// optional controls as it narrows — the deadwood toggle, then the trio degrades
// to one button, then that goes too — which was found by sweeping the Honor,
// where at 666dp the bar overflowed and pushed DROP off the screen entirely.
// So the SHEET carries Standings unconditionally: a readout must not be gated
// on how wide the action row happens to be.
check('...and stays reachable at every width',
  /scoreW > 0[\s\S]{0,400}ScorePanel/.test(RUMMY)
    && /m\.barTrio &&[\s\S]{0,300}setShowStandings\(true\)/.test(RUMMY)
    && /m\.barStandings &&[\s\S]{0,220}setShowStandings\(true\)/.test(RUMMY)
    && /label="Standings"[\s\S]{0,220}setShowStandings\(true\)/.test(RUMMY),
  'band panel, then trio, then one button, and the settings sheet always');

check('the action bar budgets its width instead of overflowing',
  /m\.barBtnW/.test(RUMMY) && /m\.barToggle &&/.test(RUMMY),
  'at 666dp on the Honor the row ran 680dp of controls and DROP fell off the edge');

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all native-games checks passed\n');
process.exit(failures ? 1 : 0);
