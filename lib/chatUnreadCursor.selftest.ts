// lib/chatUnreadCursor.selftest.ts — run: npx tsx lib/chatUnreadCursor.selftest.ts
//
// Two reported symptoms, one screen, two independent causes. Both are asserted
// against the SOURCE of app/chat.tsx, because that file imports react-native and
// expo-router and cannot be loaded under Node (the same reason
// twoUserConversation.selftest.ts lists "anything in app/chat.tsx" as out of
// reach). A source assertion is weaker than executing the code and is chosen
// deliberately over asserting nothing.
//
// SYMPTOM 1 — "1 unread message" on a chat with nothing unread in it, surviving
// every re-open.
//
//   lastReadSent is a ref that holds the newest id this screen has already
//   reported via POST /read, and the effect returns early when the current
//   newest id is not greater. messages.id is a single BIGSERIAL across every
//   chat (002_chats.sql), so without a per-chat reset that ref compares ids
//   from DIFFERENT conversations: open a busy chat whose newest id is 9000,
//   then open a quiet one whose newest is 8500, and `8500 <= 9000` returns
//   early forever. POST /read never fires for the second chat and its badge
//   stays lit for the whole session however many times it is opened.
//
// SYMPTOM 2 — a message that fired a push notification never appears in the
// chat.
//
//   The initial load asks the server for messages ONLY when the device holds
//   nothing cached for the chat ("the server is used only when this device
//   holds NOTHING"). For any chat with history the painted cache is the whole
//   story, and the only live update path is the socket — which delivers to an
//   OPEN screen and nothing else. A message that arrived while the app was
//   backgrounded is written to the local DB by lib/syncEngine's catch-up and
//   then never read back, so opening the chat from the notification shows the
//   old page. Its id also stays above the read cursor, which is why symptom 2
//   produces symptom 1 as well.

import { readFileSync } from 'node:fs';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAT = readFileSync(join(HERE, '..', 'app', 'chat.tsx'), 'utf8');
const SYNC = readFileSync(join(HERE, 'syncEngine.ts'), 'utf8');

let failures = 0;
function check(name: string, ok: boolean, why: string): void {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}\n       ${why}`);
  }
}

// ── Symptom 1 ───────────────────────────────────────────────────────────────

check(
  'the read cursor is reset when the chat changes',
  // The reset is a multi-line effect (it clears `messages` too), so this spans
  // lines rather than expecting the one-liner it started as.
  // The reset effect now clears the whole per-chat surface (messages, replyTo,
  // editingId, chat, pinnedId, typingUids, liveLoc, extraReplies,
  // newSinceUp), so a tight character window is the wrong shape of
  // assertion - it fails on the effect getting MORE correct. Anchor on the
  // two things that must hold: the cursor is cleared, and the list with it.
  /lastReadSent\.current\s*=\s*0;/.test(CHAT)
    && /lastReadSent\.current\s*=\s*0;[\s\S]{0,1400}?\}, \[chatId\]\);/.test(CHAT),
  'lastReadSent is no longer cleared on [chatId]. Message ids are global, so the '
    + 'ref now carries a previous chat’s newest id into this one and POST /read '
    + 'is skipped for every chat whose newest id happens to be lower.',
);

// The guard itself must stay — without it every render re-POSTs.
check(
  'the early-return guard on the read cursor is still present',
  /latestId\s*<=\s*lastReadSent\.current/.test(CHAT),
  'the monotonic guard is gone; POST /read would fire on every messages change.',
);

// ── Symptom 2 ───────────────────────────────────────────────────────────────

check(
  'the chat screen re-reads the cache after a catch-up',
  /catchUp\(\)/.test(CHAT) && /getCachedMessages\(cid, INITIAL_PAGE_SIZE\)/.test(CHAT),
  'app/chat.tsx no longer runs a catch-up and re-reads the local cache. Messages '
    + 'that arrived while the screen was unmounted are written to the DB by '
    + 'lib/syncEngine and would again be invisible to a chat that has any history, '
    + 'because the server fetch is skipped whenever the cache is non-empty.',
);

check(
  'the top-up also runs when the app returns to the foreground',
  /AppState\.addEventListener\('change'[\s\S]{0,200}?'active'[\s\S]{0,120}?topUp\(\)/.test(CHAT),
  'the AppState hook is gone from chat.tsx. A chat that is already focused when '
    + 'the app resumes fires no focus event, so nothing would re-read the cache.',
);

check(
  'outbox bubbles are split off by _tempId, not by the sign of the id',
  /const pending = (?:prev|base)\.filter\(x => x\._tempId\)/.test(CHAT)
    && /const real = (?:prev|base)\.filter\(x => !x\._tempId\)/.test(CHAT),
  'the merge is bucketing on `id > 0` again. Optimistic bubbles must stay pinned '
    + 'to the top of the inverted list, but Exit-Kit imported history carries '
    + 'NEGATIVE ids (importMessages in lib/localDb.ts is their only writer), so an '
    + 'id-sign test sweeps the whole imported archive into the pinned bucket and '
    + 'renders years-old history as the newest messages in the chat.',
);

check(
  'the top-up bails when chatId changed under a live instance',
  /const cid = chatId;/.test(CHAT) && /chatIdRef\.current !== cid/.test(CHAT),
  'the async top-up no longer checks that it is still on the chat it started '
    + "for. app/split.tsx swaps its two panes onto the SAME mounted ChatScreen, so "
    + "without this one chat’s cached rows get merged into the other’s list.",
);

check(
  'the per-chat reset also clears the rendered messages',
  /lastReadSent\.current = 0;[\s\S]{0,80}?setMessages\(\[\]\);/.test(CHAT),
  'resetting the read cursor WITHOUT clearing messages is worse than not '
    + 'resetting it: on a split-view swap the read effect computes a latest id '
    + "from the previous chat’s rows and POSTs it against the new chat, which "
    + "moves that chat’s cursor to a foreign id and makes the vanish sweep "
    + 'hard-delete every vanish_after_read message at or below it.',
);

check(
  'catch-up coalesces on the in-flight run instead of returning 0',
  /if \(!inflight\) \{\s*inflight = drainRequestedSync\(\);\s*ordinaryInflight = inflight\.then\(\(result\) => result\.applied\);\s*\}\s*return ordinaryInflight!;/.test(SYNC) && !/if \(running\) return 0;/.test(SYNC),
  'catchUp() drops the call while a run is in flight again. Callers AWAIT it to '
    + "mean the delta has landed; on a resume, initSync’s own listener takes the "
    + 'flag first, so the chat screen would await a no-op and re-read the cache '
    + 'before the round trip wrote anything.',
);

check(
  'the resume trigger is throttled in syncEngine, not in one caller',
  /RESUME_MIN_GAP_MS/.test(SYNC) && /lastResumeSync/.test(SYNC),
  "Android fires AppState 'active' on return from the image picker, document "
    + 'picker, camera, share sheet, permission dialog and biometric prompt. '
    + 'Unthrottled, attaching three photos is three full delta round trips.',
);

check(
  'catch-up is armed on foreground, not only on an ONLINE transition',
  /AppState\.addEventListener\('change'[\s\S]{0,220}?'active'[\s\S]{0,200}?requestCatchUp\(\)/.test(SYNC),
  'lib/syncEngine only wires catchUp to onConnectionState. ONLINE fires on a '
    + 'TRANSITION, so a device that was backgrounded holding a live socket, or '
    + 'that was woken by FCM, can foreground without ever pulling the delta.',
);

check(
  'the ONLINE trigger was kept alongside it',
  /onConnectionState\(\(s\) => \{ if \(s === 'ONLINE'\) requestCatchUp\(\)/.test(SYNC),
  'the reconnect trigger was replaced rather than added to; a device that comes '
    + 'back online without a foreground transition would no longer catch up.',
);

// ── SYMPTOM 3 (2026-09-18) — read the message, row still shows unread ───────
//
// unreadCount is a denormalized server column and POST /chats/:id/read is the
// only thing that recomputes it. app/chat.tsx debounces that 800ms and
// lib/receipts.ts batches another 300ms before the round trip, but pressing
// Back re-focuses the Chats tab, which refetches at once — so the list asks
// before the server was told and then has no later trigger to correct itself.
// A rejected receipt (Go 400s a cursor above the chat's MAX(id); the older Node
// handler answers 200 having updated nothing) makes it permanent.
//
// The device's own read watermark is the earliest correct answer, so the list
// trusts it over the server's count. Unlike everything above, this rule is
// real code with no react-native in it, so it is EXECUTED rather than grepped.

import { applyLocalReadPointers } from './unreadStore';

type Row = { id: string; unreadCount: number; lastMessageId: number | null };
const row = (id: string, unreadCount: number, lastMessageId: number | null): Row =>
  ({ id, unreadCount, lastMessageId });

// The bug: read to the newest message, server has not caught up yet.
check(
  'a chat read up to its newest message shows no badge',
  applyLocalReadPointers([row('a', 3, 900)], { a: 900 })[0].unreadCount === 0,
  'the stale server count survives a local read — the reported bug is back.',
);

// …and the half that must NOT regress.
check(
  'a genuinely unread chat stays unread',
  applyLocalReadPointers([row('a', 3, 900)], { a: 880 })[0].unreadCount === 3,
  'a chat with messages past my read watermark was cleared. Reading chat A must '
    + 'never silence chat A’s later messages.',
);
check(
  'a new incoming message raises the badge again',
  applyLocalReadPointers([row('a', 1, 901)], { a: 900 })[0].unreadCount === 1,
  'the watermark is being treated as "this chat is read forever" rather than as '
    + 'a position. One message past it is unread.',
);
check(
  'a chat this device has never read is left alone',
  applyLocalReadPointers([row('a', 2, 900)], {})[0].unreadCount === 2
    && applyLocalReadPointers([row('b', 2, 900)], { b: 0 })[0].unreadCount === 2,
  'a missing pointer reads as 0 and 0 >= 0 would clear every badge on a device '
    + 'that has read nothing — the whole list would go quiet on a fresh install.',
);
check(
  'another chat’s pointer cannot clear this row',
  applyLocalReadPointers([row('a', 2, 900)], { b: 9999 })[0].unreadCount === 2,
  'pointers are being applied unkeyed. Message ids are a single global '
    + 'BIGSERIAL, so one busy chat’s cursor would clear the entire list.',
);
check(
  'a chat with no messages is not cleared on a stray pointer',
  applyLocalReadPointers([row('a', 1, null)], { a: 5 })[0].unreadCount === 1,
  'lastMessageId null means "nothing here to have read"; defaulting it to 0 '
    + 'makes any pointer clear the row.',
);

// The rule has to be WIRED, not merely correct. Both list paths: the network
// fetch every screen shares, and the cached paint that runs before it.
const SERVICE = readFileSync(join(HERE, 'chatService.ts'), 'utf8');
const CHATS = readFileSync(join(HERE, '..', 'app', '(tabs)', 'chats.tsx'), 'utf8');
check(
  'listChats applies the local read pointers',
  /applyLocalReadPointers\(rows, await readPointers\(\)\)/.test(SERVICE),
  'the correction was removed from lib/chatService.listChats. Every list surface '
    + '— the Chats tab, app/search.tsx, app/hidden-chats.tsx — reads unreadCount '
    + 'off those rows, so the badge goes stale on all of them at once.',
);
check(
  'the cold-start cached paint applies them too',
  /applyLocalReadPointers\(cached as any, await readPointers\(\)\)/.test(CHATS),
  'lib/localDb.cacheChatDetail rewrites a chat’s cached row from the ChatDetail '
    + 'fetched when the chat is OPENED — i.e. with its pre-read unreadCount — so '
    + 'without this the badge returns on every cold start.',
);

if (failures) {
  console.error(`\nchatUnreadCursor.selftest: ${failures} failure(s)`);
  process.exit(1);
}
// A QUICK GLANCE MUST STILL WRITE A READ POINTER (2026-09-18).
//
// app/chat.tsx debounces the read by 800ms so the message list can settle and
// the LATEST id is the one recorded. The cleanup used to clearTimeout and
// nothing else, so backing out inside that window wrote no pointer at all -
// and applyLocalReadPointers above cannot correct a count it has no pointer
// for. That is the "I opened it and it still says unread" case.
{
  const src = fs.readFileSync('app/chat.tsx', 'utf8');
  const cleanup = src.slice(src.indexOf('A GLANCE STILL COUNTS AS READING'));
  check('the read debounce has a blur handler at all', cleanup.length > 0, 'the 2026-09-18 comment block is gone');
  check('blur flushes the pending read instead of dropping it',
    cleanup.slice(0, 1800).includes('markReadDurable(chatId, latestId, meId)'),
    'backing out inside the 800ms window writes no read pointer at all');
  check('...and still clears the timer', cleanup.slice(0, 1800).includes('clearTimeout(readDebounce.current)'), 'the debounce timer would leak');
  check('...and still refuses to re-send an id already sent',
    cleanup.slice(0, 1800).includes('latestId <= lastReadSent.current'),
    'a blur after a completed read would re-send it');
}

// This line used to print unconditionally with no process.exit, so a FAILED
// check printed its message and the suite still exited 0 - the file could not
// fail. Found 2026-09-18 while adding the glance assertions below; the same
// defect was fixed in utils/shopbook.selftest.ts earlier.
console.log(failures === 0
  ? String.fromCharCode(10) + 'chatUnreadCursor.selftest: all checks passed'
  : String.fromCharCode(10) + failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
