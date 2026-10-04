// lib/hiddenChatMask.selftest.ts — run: npx tsx lib/hiddenChatMask.selftest.ts
//
// Screens that list message content OUTSIDE the chat must not show a locked or
// a hidden (PIN-gated) chat's content, and must fail closed when they cannot
// tell:
//   * app/shelf.tsx lists file names. lib/localDb.listAllAttachments already
//     keeps to the visible chats; the screen also drops locked chats
//     (lib/lockedChats: an unreadable lock table → null → every chat locked).
//   * app/bookmarks.tsx, app/scheduled.tsx and the reminders list mask the
//     text of a chat that is locked, or not in visibleCachedChatIds (hidden,
//     unreadable, or not cached); an unreadable chat table masks every row.
// Structural (comments stripped), like lib/silentFailure.selftest.ts: it proves
// the rule is wired, not that a device renders it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const code = (p: string) => readFileSync(p, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// The list rule itself (read from source: lib/lockedChats imports chatLock,
// which needs React Native): null (unreadable lock table) hides every chat.
const locked = code('lib/lockedChats.ts');
assert.ok(/return locked === null \|\| locked\.has\(chatId\);/.test(locked), 'isLockedIn: null means every chat is locked');
assert.ok(/catch \{ return null; \}/.test(locked), 'lockedChatIds: an unreadable lock table answers null');

const shelf = code('app/shelf.tsx');
assert.ok(/listAllAttachments\(\)/.test(shelf), 'shelf reads the visible-only attachment index');
assert.ok(/lockedChatIds\(\)/.test(shelf) && /!isLockedIn\(locked, r\.chatId\)/.test(shelf),
  'shelf drops files from locked chats (failing closed)');
const db = code('lib/localDb.ts');
const listAll = db.slice(db.indexOf('export async function listAllAttachments'));
assert.ok(/const visible = await visibleCachedChatIds\(\);/.test(listAll.slice(0, 1200))
  && /if \(!visible\.has\(r\.chat_id\)\) continue;/.test(listAll.slice(0, 1200)),
  'listAllAttachments keeps to the chats the main list may show');

const MASKED = /const visible = await visibleCachedChatIds\(\)\.catch\(\(\) => null\);[\s\S]{0,200}if \(visible === null \|\| !visible\.has\(id\) \|\| await isChatLocked\(id\)\.catch\(\(\) => true\)\) lockedIds\.add\(id\);/;
for (const f of ['app/bookmarks.tsx', 'app/scheduled.tsx', 'components/chattools/RemindersList.tsx']) {
  assert.ok(MASKED.test(code(f)), `${f}: hidden, uncached and locked chats are masked, failing closed`);
}

console.log('hiddenChatMask selftest: ok');
