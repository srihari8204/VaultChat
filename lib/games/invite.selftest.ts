// lib/games/invite.selftest.ts — a game invite must reach a table.
//
//   npx tsx lib/games/invite.selftest.ts
//
// TWO SCOPES IN ONE FILE.
//
// BEHAVIOURAL: the link builder and the card parser are pure, so they are
// exercised directly. The room id ends up inside a URL other people open, and
// a slash or a '?' in it rewrites that URL rather than filling it in.
//
// STRUCTURAL: the rest reads source and asserts the chain is joined end to end.
// This is not belt-and-braces — it is the exact failure this feature already
// shipped once, for the shared group card: server written, parser written,
// screen written, and NO branch in MessageBubble, so the recipient got an empty
// bubble while the sender was told it had been delivered
// (lib/groupRefRouting.selftest.ts). A game invite has the same shape and the
// same way of failing silently.
//
// It renders nothing and sends nothing.

import { readFileSync } from 'fs';
import { join } from 'path';
// The link builder and the card parser, imported for real: these two decide
// what a recipient actually opens. Declared here with the other imports rather
// than beside the checks that use them — an import is hoisted whatever line it
// is written on, so a mid-file one only makes the reading order a fiction.
import { tableLink, gameInviteOf, inviteText } from './inviteLink';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (src: string) =>
  src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const INVITE  = code(read('lib/games/invite.ts'));
const BUBBLE  = code(read('components/chat/MessageBubble.tsx'));
const SERVICE = code(read('lib/chatService.ts'));
const SHEET   = code(read('components/games/InviteSheet.tsx'));
const HUB     = code(read('app/games.tsx'));
const HELPERS = code(read('vaultchat-backend-go/internal/routes/chats_helpers.go'));
const MIGRATION = read('vaultchat-backend/migrations/124_game_invite_message.sql');

let failed = 0;
function A(ok: boolean, what: string): void {
  if (ok) { console.log('  ok   ' + what); return; }
  failed++;
  console.log('  FAIL ' + what);
}

console.log('\nGame invite → table\n');

// ── 1. the link and the parser ────────────────────────────────────────

A(tableLink('rummy', 'abc-123') === 'vaultchat://games?game=rummy&room=abc-123',
  '1. tableLink builds the deep link app.json registers');
A(tableLink('chess', '') === null, '1a. no room id → no link');
for (const bad of ['a/b', 'a?b', 'a#b', "a'b", 'a b', 'x'.repeat(65)]) {
  A(tableLink('ludo', bad) === null,
    `1b. rejects ${JSON.stringify(bad)} — it would REWRITE the URL, not fill it in`);
}

A(JSON.stringify(gameInviteOf({ game: 'ludo', room: 'r1' })) === '{"game":"ludo","room":"r1"}',
  '2. gameInviteOf reads a well-formed card');
A(gameInviteOf({ game: 'carrom', room: 'r1' }) === null,
  '2a. rejects a game this app does not expose — the screen would fall back to '
  + 'the menu, so the card would be a button that leads nowhere');
A(gameInviteOf({ game: 'chess', room: 'a/b' }) === null, '2b. rejects a room id that is not a slug');
A(gameInviteOf(null) === null && gameInviteOf('x') === null && gameInviteOf({}) === null,
  '2c. rejects junk without throwing');

A(inviteText('chess', 'r1').includes('vaultchat://games?game=chess&room=r1'),
  '3. the fallback line carries the link — this is what a client too old to '
  + "know the type renders, instead of an empty bubble");

// ── 4. the send path ──────────────────────────────────────────────────
A(/sendMessage\(chatId, inviteText\(game, r\), 'game_invite', \{ meta: \{ game, room: r \} \}\)/.test(INVITE),
  "4. sendGameInvite posts a 'game_invite' with meta {game, room} and the "
  + 'readable line as its E2EE body');
A(/'game_invite'/.test(SERVICE),
  "4a. chatService's Message type union admits 'game_invite'");
A(!/insertLocal|localId|negative/i.test(INVITE),
  '4b. the invite inserts no local-only row — nothing here can mint a positive '
  + 'local messages.id, which is also the delta-sync cursor');

// ── 5. THE BRANCH. This is what was missing for group_ref ─────────────
A(/msg\.type === 'game_invite' \? gameInviteOf\(msg\.meta\)/.test(BUBBLE),
  "5. MessageBubble matches type 'game_invite' — without this branch the card "
  + 'renders as an EMPTY bubble, which is what shipped for the group card');
A(/<GameInviteBubble inv=\{gameInvite\}/.test(BUBBLE), '5a. and renders it through GameInviteBubble');
A(/export function GameInviteBubble/.test(BUBBLE), '5b. which is defined here');
A(/pathname: '\/games'/.test(BUBBLE) && /params: \{ game: inv\.game, room: inv\.room \}/.test(BUBBLE),
  '5c. tapping it opens /games with the two params that screen reads — the '
  + 'same route the deep link and the turn notification use');

// ── 6. the picker is mounted, and the boards can reach it ─────────────
A(/registerInvitePicker/.test(SHEET), '6. the sheet registers itself as the picker');
A(/<InviteSheet \/>/.test(HUB), '6a. and app/games.tsx mounts it once');
for (const board of ['Chess', 'Ludo', 'Rummy', 'TicTacToe']) {
  const src = code(read(`components/games/${board}.tsx`));
  A(/openInvite\(/.test(src) && !/inviteToTable\(/.test(src),
    `6b. ${board} opens the picker rather than going straight to the share sheet`);
}
A(/Share a link instead/.test(SHEET)
  && SHEET.indexOf('Share a link instead') < SHEET.indexOf('chats.map'),
  '6d. the out-of-app share sits ABOVE the chat list — below it, a player with a '
  + 'dozen chats has to scroll past all of them to reach the only option that '
  + 'works for someone who does not have crazzychat');
A(/Send the link instead\?/.test(SHEET) && /onPress: \(\) => \{ void inviteToTable\(target\.game, target\.room\)/.test(SHEET),
  '6e. a card the SERVER refuses falls back to the link — otherwise the button '
  + 'is simply broken, which is exactly what production does today until '
  + "migration 124 lands ('invalid type')");
A(/const \{ cacheMessages \} = await import\('\.\.\/localDb'\)/.test(INVITE),
  '6f. the sender CACHES its own card — the send happens from the games screen, '
  + 'so no chat screen persists it, a sender never gets its own message back '
  + 'over the socket, and the server has already advanced last_delivered past '
  + 'it. Without this the card is in the database and missing from the thread, '
  + 'which is exactly what device testing found for a group chat');
A(/openInvite\('chess', code\)/.test(read('components/games/Chess.tsx')),
  '6g. chess can invite from the LOBBY — it used to offer it only on the board, '
  + 'i.e. only after the game had already started');
A(/inviteToTable/.test(SHEET),
  '6c. the share sheet survives inside the picker — it is the only way to reach '
  + 'someone who does not have crazzychat yet');

// ── 7. the server does not take the client's word for it ──────────────
A(/"game_invite": true/.test(HELPERS), "7. the backend accepts the 'game_invite' type");
A(/chatsGameKinds\[/.test(HELPERS) && /chatsGameRoomRe\.MatchString/.test(HELPERS),
  '7a. and validates BOTH the game and the room id server-side — a client-side '
  + 'check alone is no check at all against a modified client');
A(/CHECK \(type IN[\s\S]*'game_invite'/.test(MIGRATION),
  '7b. migration 124 makes the type storable');
A(/scheduled_messages/.test(MIGRATION) && !/scheduled_messages_type_check[\s\S]*game_invite/.test(MIGRATION),
  '7c. and deliberately withholds it from scheduled_messages — a table is a '
  + 'live thing and would be gone by send time');

console.log(failed === 0 ? '\nAll good.\n' : `\n${failed} FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
