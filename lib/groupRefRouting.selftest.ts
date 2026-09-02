// lib/groupRefRouting.selftest.ts — the shared group card must lead somewhere.
//
//   npx tsx lib/groupRefRouting.selftest.ts
//
// SCOPE: STRUCTURAL. Reads source and asserts the chain is joined end to end.
// It renders nothing and navigates nowhere.
//
// WHAT WAS BROKEN
//
// Four pieces of this feature existed and none of them were connected:
//
//   1. group-members.tsx calls shareGroup(), which sends a message of type
//      'group_ref' and tells the sender "The card is in your chat with X".
//   2. The Go backend enriches that message's meta with the group's name, type,
//      icon and colour (chats_helpers.go, chats_membership.go).
//   3. lib/chatService.groupRefOf() parses exactly that meta.
//   4. app/group-join.tsx reads exactly those params and is, by its own header
//      comment, "the ONLY way into a group you were not personally invited to".
//
// And in between: MessageBubble had NO branch for 'group_ref', so the card
// rendered as an empty bubble, and `/group-join` had ZERO inbound navigation
// anywhere in the repo. Server written, parser written, screen written, nothing
// wired. The sender was told it had been delivered.
//
// This file exists because every individual piece looked healthy in isolation.

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (src: string) =>
  src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const BUBBLE = code(read('components/chat/MessageBubble.tsx'));
const SERVICE = code(read('lib/chatService.ts'));
const JOIN = code(read('app/group-join.tsx'));

let failed = 0;
function A(ok: boolean, what: string): void {
  if (ok) { console.log('  ok   ' + what); return; }
  failed++;
  console.log('  FAIL ' + what);
}

console.log('\nShared group card → join screen\n');

// ── 1. the sender still sends the card ────────────────────────────────
A(/sendMessage\(toChatId, '', 'group_ref'/.test(SERVICE),
  "1. shareGroup still sends a 'group_ref' message");
A(/export function groupRefOf/.test(SERVICE),
  '1a. groupRefOf still parses the card off the meta');

// ── 2. the receiving bubble draws it ──────────────────────────────────
A(/msg\.type === 'group_ref' \? groupRefOf\(msg\.meta\)/.test(BUBBLE),
  "2. MessageBubble matches type 'group_ref' — without this branch the card "
  + 'renders as an EMPTY bubble, which is what shipped');
A(/<GroupRefBubble gref=\{groupRef\}/.test(BUBBLE),
  '2a. and renders it through GroupRefBubble');
A(/export function GroupRefBubble/.test(BUBBLE), '2b. which is defined here');

// ── 3. THE ROUTE. This is the link that did not exist ─────────────────
A(/pathname: '\/group-join'/.test(BUBBLE),
  '3. tapping the card navigates to /group-join — the screen had ZERO inbound '
  + 'navigation from anywhere in the codebase before this');

// ── 4. the params the screen actually reads ───────────────────────────
//
// A route with the wrong param names fails silently: group-join would open
// with groupId '' and render "this group" with nothing to join.
{
  const i = BUBBLE.indexOf("pathname: '/group-join'");
  const sent = BUBBLE.slice(i, i + 400);
  for (const p of ['groupId', 'name', 'groupType', 'icon', 'color']) {
    A(new RegExp('\\b' + p + ':').test(sent), `4. passes ${p}`);
    A(new RegExp('\\b' + p + '\\??:').test(JOIN) || JOIN.includes(p),
      `4a. and group-join reads ${p}`);
  }
  A(/groupId: gref\.groupId/.test(sent),
    '4b. groupId comes from the parsed card, not from an empty default — it is '
    + 'the only param the join request actually needs');
}

// ── 5. the card must not join anything by itself ──────────────────────
//
// group-join describes itself as a weak door: arriving admits nothing, it
// sends a request and an admin decides. A card that joined on tap would turn
// a forwarded message into an admission.
A(!/requestToJoin/.test(BUBBLE),
  '5. the bubble navigates and never joins — admission stays behind the '
  + "screen's own request flow");
A(/requestToJoin\(groupId\)/.test(JOIN),
  '5a. and group-join is still the thing that asks');

console.log(failed === 0
  ? '\ngroupRefRouting: all checks passed'
  : `\ngroupRefRouting: ${failed} FAILED`);
if (failed > 0) process.exit(1);
