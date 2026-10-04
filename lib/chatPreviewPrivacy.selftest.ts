// lib/chatPreviewPrivacy.selftest.ts — run: npx tsx lib/chatPreviewPrivacy.selftest.ts
//
// The Chats row preview and global search show message text outside the chat.
//   • A locked chat shows neither its newest message nor your draft
//     (components/chats/chatPreview), and global search skips it.
//   • An unreadable lock table hides every chat (lib/chatLock fails closed).
//   • A view-once / Invisible Ink newest message never prints its text, even
//     after lib/chatService.hydrateOwnPreviews filled `content` back in for an
//     own message (it spreads the row, so the `protected` flag survives).
//   • A locked row shows no receipt tick and no "typing…" either.
//   • Global search shows message hits only from chats in its loaded list, so
//     hidden (PIN-gated) chats are never hits (lib/localDb also skips them).
// Runs the REAL lib/chatLock.ts with React Native stubbed (as
// lib/chatLockMigration.selftest.ts does) and the real preview function.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const store = new Map<string, string>();
let storageFails = false;
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]) {
  if (request === 'react-native-get-random-values') return {};
  if (request === '@react-native-async-storage/async-storage') {
    return { __esModule: true, default: {
      getItem: async (k: string) => { if (storageFails) throw new Error('disk'); return store.get(k) ?? null; },
      setItem: async (k: string, v: string) => { store.set(k, v); },
    } };
  }
  if (request === 'expo-local-authentication') return {};
  if (request === 'react-native') return { Platform: { OS: 'android' } };
  return origLoad.call(this, request, ...rest);
};
const { lockedChatIds, isLockedIn } = require('./lockedChats') as typeof import('./lockedChats');
const P = require('../components/chats/chatPreview') as typeof import('../components/chats/chatPreview');

async function main() {
  // ── lock table → set ──────────────────────────────────────────────────
  assert.deepEqual([...(await lockedChatIds())!], [], 'no table: nothing locked');
  store.set('vc_locked_chats', JSON.stringify({
    a: { chatId: 'a', chatName: 'A', locked: true, lockMethod: 'pin', autoLockTimer: 0 },
    b: { chatId: 'b', chatName: 'B', locked: false, lockMethod: 'pin', autoLockTimer: 0 },
  }));
  const ids = await lockedChatIds();
  assert.deepEqual([...ids!], ['a'], 'only entries whose lock is on');
  assert.equal(isLockedIn(ids, 'a'), true);
  assert.equal(isLockedIn(ids, 'b'), false);
  store.set('vc_locked_chats', '[]');
  assert.equal(await lockedChatIds(), null, 'a corrupt table is unreadable, not empty');
  storageFails = true;
  assert.equal(await lockedChatIds(), null, 'a storage failure is unreadable');
  storageFails = false;
  assert.equal(isLockedIn(null, 'anything'), true, 'unreadable → every chat counts as locked');

  // ── row preview ───────────────────────────────────────────────────────
  const text = { content: 'meet at 6', type: 'text', senderId: 'peer', id: 9 };
  const base = { hasLastMessage: true, meId: 'me' };
  assert.equal(P.chatRowPreview({ ...base, lastMsg: text }).preview, 'meet at 6');
  assert.deepEqual(P.chatRowPreview({ ...base, lastMsg: text, draft: 'my draft' }), { draftText: 'my draft', preview: 'my draft' });
  assert.deepEqual(P.chatRowPreview({ ...base, lastMsg: text, draft: 'my draft', locked: true }),
    { draftText: '', preview: P.LOCKED_PREVIEW }, 'locked: no message text, no draft');
  // Protected: lib/localDb withholds content; hydrateOwnPreviews may refill it for own messages.
  const ownRefilled = { content: 'view once secret', type: 'text', senderId: 'me', id: 10, protected: true };
  assert.equal(P.chatRowPreview({ ...base, lastMsg: ownRefilled }).preview, `You: ${P.PROTECTED_PREVIEW}`);
  assert.equal(P.chatRowPreview({ ...base, lastMsg: { ...ownRefilled, senderId: 'peer', content: null } }).preview, P.PROTECTED_PREVIEW);
  assert.equal(P.chatRowPreview({ ...base, lastMsg: { ...ownRefilled, type: 'image' } }).preview, 'You: 📷 Photo',
    'a protected photo keeps its type label (no text in it)');
  assert.equal(P.chatRowPreview({ ...base, lastMsg: { ...text, content: null } }).preview, '🔒 Encrypted message');
  assert.equal(P.chatRowPreview({ hasLastMessage: false }).preview, 'No messages yet');

  // ── receipt tick: none on a locked row ─────────────────────────────────
  const mine = { content: 'hi', type: 'text', senderId: 'me', id: 20 };
  const tk = { lastMsg: mine, meId: 'me', draftText: '', direct: true };
  assert.equal(P.chatRowTick(tk), 'sent');
  assert.equal(P.chatRowTick({ ...tk, peerDeliveredId: 20 }), 'delivered');
  assert.equal(P.chatRowTick({ ...tk, peerReadId: 25 }), 'read');
  assert.equal(P.chatRowTick({ ...tk, peerReadId: 25, locked: true }), null, 'locked: no read tick');
  assert.equal(P.chatRowTick({ ...tk, draftText: 'x' }), null, 'a draft replaces the tick');
  assert.equal(P.chatRowTick({ ...tk, direct: false }), null, 'groups have no row tick');
  assert.equal(P.chatRowTick({ ...tk, lastMsg: text }), null, 'not your message: no tick');

  // hydrateOwnPreviews must keep spreading the row, or the flag is lost.
  const svc = readFileSync('lib/chatService.ts', 'utf8');
  const hydrate = svc.match(/export async function hydrateOwnPreviews[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(hydrate, /\{ \.\.\.row, content:/, 'hydrateOwnPreviews keeps the row (and its protected flag)');

  // ── the screens use it ────────────────────────────────────────────────
  const chats = readFileSync('app/(tabs)/chats.tsx', 'utf8');
  assert.match(chats, /locked=\{lockedIds !== undefined && isLockedIn\(lockedIds, item\.id\)\}/, 'Chats passes the lock to each row');
  assert.match(chats, /draft=\{lockedIds === undefined \? undefined : drafts\[item\.id\]\}/, 'drafts wait for the lock table');
  const row = readFileSync('components/chats/ChatListRow.tsx', 'utf8');
  assert.match(row, /chatRowPreview\(\{[^}]*locked \}\)/, 'the row renders chatRowPreview');
  assert.doesNotMatch(row, /lastMsg\.content/, 'the row reads no message text itself');
  assert.match(row, /chatRowTick\(\{[\s\S]*?locked,/, 'the row tick gets the lock');
  assert.match(row, /const typing = !!isTyping && !locked;/, 'a locked row shows no "typing…"');
  assert.doesNotMatch(row, /\{isTyping \?/, 'the row does not render typing from the raw prop');
  const search = readFileSync('app/search.tsx', 'utf8');
  assert.match(search, /searchAllMessages\(q, 50, locked\)/, 'global search passes the locked set');
  assert.match(search, /locked === null \? \[\]/, 'an unreadable lock table searches no messages');
  // Hidden (PIN-gated) chats: hits only from chats in the loaded list.
  assert.match(search, /msgs\.filter\(h => chatTitle\.has\(h\.chatId\)\)/, 'search lists hits only from listed chats');
  assert.match(search, /getCachedVisibleChats\(\)/, 'offline search lists only visible cached chats');
  assert.doesNotMatch(search, /getCachedChats\(/, 'search never lists hidden cached rows');

  // contact-info: a locked chat's messages are not even fetched.
  const info = readFileSync('app/contact-info.tsx', 'utf8');
  assert.match(info, /if \(chatLocked === null\) return;/, 'contact-info waits for the lock before loading');
  assert.match(info, /chatId && !locked \? getMessages\(/, 'contact-info fetches no messages for a locked chat');
  assert.match(info, /const unioned = locked \? \[\] : await unionWithLocalHistory\(/, 'contact-info reads no local history for a locked chat');

  console.log('chat preview privacy: locked rows (text, tick, typing), drafts, protected messages, search lock/hidden wiring and contact-info lock checks passed');
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
