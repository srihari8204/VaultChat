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

if (failures) {
  console.error(`\nchatUnreadCursor.selftest: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\nchatUnreadCursor.selftest: all checks passed');
