// lib/editWindow.selftest.ts — run: npx tsx lib/editWindow.selftest.ts
//
// The edit window is a CONTRACT ACROSS TWO CODEBASES, and nothing enforced it.
//
// The server rejects an edit in the PATCH's WHERE clause:
//     created_at > NOW() - INTERVAL '<chatsEditWindowMS> milliseconds'
// so past that it returns 404 and the client can do nothing about it.
//
// The client offered Edit on every own message forever. Tapping it on anything
// older than the window produced a 404 — and because an edit is applied
// optimistically BY ID and carries no pending bubble, the queue's 'failed'
// event (matched on _tempId) found nothing to mark. The rejection was dropped:
// the user saw the edit apply, then watched it revert on the next sync with no
// error. That is the "edit doesn't work" report.
//
// Two halves are pinned here:
//   1. the two constants agree — a drift silently recreates the bug
//   2. the client still gates on the window, plaintext and a real server id
//
// Anchored on the constant NAMES, not on character offsets, so a comment that
// grows cannot defeat it (the trap that broke leaveselfapprove_test.go).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAT = readFileSync(join(HERE, '..', 'app', 'chat.tsx'), 'utf8');
const GO = readFileSync(
  join(HERE, '..', 'vaultchat-backend-go', 'internal', 'routes', 'chats.go'), 'utf8');

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

// ── 1. the two windows must agree ────────────────────────────────────────
console.log('the client must not offer an edit the server will refuse');

const cli = CHAT.match(/const\s+EDIT_WINDOW_MS\s*=\s*([0-9*\s]+);/);
check('client defines EDIT_WINDOW_MS', !!cli,
  'without it the client cannot know when the server stops accepting edits');

const srv = GO.match(/chatsEditWindowMS\s*=\s*([0-9*\s]+)/);
check('server defines chatsEditWindowMS', !!srv);

const evalMs = (s: string) => s.split('*').reduce((a, b) => a * Number(b.trim()), 1);
if (cli && srv) {
  const c = evalMs(cli[1]);
  const s = evalMs(srv[1]);
  check('the windows are identical', c === s,
    `client=${c}ms server=${s}ms — the gap is exactly the range where Edit is ` +
    `offered but 404s, and the failure is invisible`);
  check('the window is non-zero', c > 0, `${c}ms`);
}

// ── 2. the client gate keeps its three conditions ────────────────────────
console.log('the Edit action must stay gated');

const gate = CHAT.match(/const\s+editable\s*=[\s\S]{0,400}?;/);
check('the edit gate exists', !!gate,
  'Edit is being offered unconditionally again');

if (gate) {
  const g = gate[0];
  check('gated on the edit window', /EDIT_WINDOW_MS/.test(g),
    'an edit past the window 404s and the rejection is not visible to the user');
  check('gated on having local plaintext', /!!plain|plain\s*&&/.test(g),
    'editing a message whose plaintext is missing opens an EMPTY composer, and ' +
    'a stray send overwrites the message with whatever was typed');
  check('gated on a real server id', /msg\.id\s*>\s*0/.test(g),
    'a still-pending optimistic bubble has no server row to PATCH');
  check('still gated on ownership + not deleted', /isMine/.test(g) && /deletedAt/.test(g));
}

// ── 3. a refused edit must be undone and reported ────────────────────────
console.log('a refused edit must not vanish');

check('an undo snapshot is recorded when the edit is enqueued',
  /editRollbacks\.current\.set\(/.test(CHAT),
  'nothing captures the pre-edit text, so a rejection cannot be undone');
check('the failure handler consults it',
  /editRollbacks\.current\.get\(tempId\)/.test(CHAT),
  "the queue's 'failed' event matches on _tempId, which an edit does not have — " +
  'without this lookup the rejection is silently dropped');
check('…and tells the user',
  /Alert\.alert\('Edit failed'/.test(CHAT),
  'a silently reverted edit is exactly what made this look broken');
check('a landed edit clears its snapshot',
  /editRollbacks\.current\.delete\(tempId\)/.test(CHAT),
  'the map would grow for the life of the screen');

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
