// lib/chatListResync.selftest.ts — run: npx tsx lib/chatListResync.selftest.ts
//
// The chat list must be able to RECOVER, not just receive.
//
// Socket.IO does not replay events sent while a client was away, so anything
// that arrives during a drop — backgrounded, dozing, in a tunnel — is never
// seen by the Chats screen. Its other refresh triggers are a socket event and
// useFocusEffect, and if the user is already sitting on the Chats tab, focus
// never changes. The list then stays stale indefinitely.
//
// Reported as: someone not in my contacts messaged me, nothing appeared on the
// Chats page, and opening the chat from Contacts made it show up — because
// navigating away and back is what re-fired focus. For an existing chat the
// damage is a stale preview; for a FIRST message from someone new there is no
// row at all, so the whole conversation is invisible.
//
// This is the second time this exact gap has shipped: lib/socket.ts carries the
// same story for chat-room membership, where live location silently stopped
// after every reconnect until the screen was re-entered. Hence a guard.

import { readFileSync } from 'node:fs';

const SCREEN = readFileSync('app/(tabs)/chats.tsx', 'utf8');

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  (${detail})` : ''}`);
};

console.log('\nChat list resync\n');

// ── recovery after a dropped socket ───────────────────────────────────
check("refetches on socket 'connect' (i.e. after any reconnect)",
  /s\.on\(\s*'connect'\s*,/.test(SCREEN),
  "no 'connect' listener — anything missed while offline stays missed");

check('...and detaches it on unmount, like every other listener here',
  /s\.off\(\s*'connect'\s*,/.test(SCREEN),
  'listener leaks across remounts');

// ── recovery after the process was frozen ─────────────────────────────
// A resumed app can find its socket already connected without ever firing
// 'connect', so the reconnect path alone does not cover coming back from a
// pocket — the most common way to be looking at a stale list.
check('refetches when the app returns to the foreground',
  /AppState\.addEventListener\(\s*'change'/.test(SCREEN) && /'active'/.test(SCREEN),
  'no AppState listener');

check('AppState is actually imported',
  /import\s*\{[^}]*\bAppState\b[^}]*\}\s*from\s*'react-native'/s.test(SCREEN));

// ── the triggers that were already there must stay ────────────────────
check("still refetches on 'new_message'", /s\.on\(\s*'new_message'\s*,/.test(SCREEN));
check('still refetches on focus', /useFocusEffect\(/.test(SCREEN));

// ── and the refetch must be the coalesced one ─────────────────────────
// Four triggers now share this path; an uncoalesced refetch would turn a burst
// (reconnect + a backlog of new_message events landing together) into a burst
// of identical network calls.
check('resync goes through the coalescing scheduler, not a raw fetch',
  /scheduleRefresh/.test(SCREEN),
  'refresh should be debounced — several triggers can fire at once');

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all chat-list resync checks passed\n');
process.exit(failures ? 1 : 0);
