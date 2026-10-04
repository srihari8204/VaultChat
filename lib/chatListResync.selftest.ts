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

// A listener may be attached with s.on(...) on the current socket, or with
// lib/socket's addPersistentListener(...), which re-arms it on every new socket
// (e.g. after a failed sign-out replaced it). The persistent form must keep its
// unsubscribe and call it, as s.off(...) is called for the plain form: either
// `const offX = addPersistentListener('x', …)` with `offX()`, or an element of
// `const offs = [addPersistentListener('x', …), …]` with `offs.forEach(…)`.
const persistentUnsub = (ev: string) =>
  new RegExp(`(?:const|let)\\s+(\\w+)\\s*=\\s*addPersistentListener\\(\\s*'${ev}'\\s*,`).exec(SCREEN)?.[1] ?? null;
const persistentList = (ev: string) => {
  for (const m of SCREEN.matchAll(/(?:const|let)\s+(\w+)\s*=\s*\[([^\]]*)\]/g)) {
    if (new RegExp(`addPersistentListener\\(\\s*'${ev}'\\s*,`).test(m[2])) return m[1];
  }
  return null;
};
const listens = (ev: string) =>
  new RegExp(`s\\.on\\(\\s*'${ev}'\\s*,`).test(SCREEN) || persistentUnsub(ev) !== null || persistentList(ev) !== null;
const detaches = (ev: string) => {
  const unsub = persistentUnsub(ev);
  const list = persistentList(ev);
  return new RegExp(`s\\.off\\(\\s*'${ev}'\\s*,`).test(SCREEN)
    || (unsub !== null && new RegExp(`\\b${unsub}\\(\\)`).test(SCREEN))
    || (list !== null && new RegExp(`\\b${list}\\.forEach\\(\\s*(\\w+)\\s*=>\\s*\\1\\(\\)\\s*\\)`).test(SCREEN));
};

// ── recovery after a dropped socket ───────────────────────────────────
check("refetches on socket 'connect' (i.e. after any reconnect)",
  listens('connect'),
  "no 'connect' listener — anything missed while offline stays missed");

check('...and detaches it on unmount, like every other listener here',
  detaches('connect'),
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
check("still refetches on 'new_message'", listens('new_message'));
check("...and detaches it on unmount", detaches('new_message'), 'listener leaks across remounts');
check('still refetches on focus', /useFocusEffect\(/.test(SCREEN));

// ── and the refetch must be the coalesced one ─────────────────────────
// Four triggers now share this path; an uncoalesced refetch would turn a burst
// (reconnect + a backlog of new_message events landing together) into a burst
// of identical network calls.
check('resync goes through the coalescing scheduler, not a raw fetch',
  /scheduleRefresh/.test(SCREEN),
  'refresh should be debounced — several triggers can fire at once');

// ── cold-start paint stays first ──────────────────────────────────────
check('initial fetch reuses the preview read started for cache paint',
  /await loadList\(false\)/.test(SCREEN),
  'first mount should not run getLastMessagePerChat twice');

check('non-paint startup work waits until after interactions',
  /InteractionManager/.test(SCREEN)
    && /afterInteractions\(\(\) => \{ registerPushToken/.test(SCREEN)
    && /afterInteractions\(\(\) => \{[\s\S]*cloudBackupMeta/.test(SCREEN),
  'push registration and restore probing should not compete with first paint');

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all chat-list resync checks passed\n');
process.exit(failures ? 1 : 0);
