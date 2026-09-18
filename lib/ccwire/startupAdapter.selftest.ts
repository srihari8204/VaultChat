/**
 * lib/ccwire/startupAdapter.selftest.ts
 *   run with: npx tsx lib/ccwire/startupAdapter.selftest.ts
 *
 * Batch A's contract in assertions: the strict wire-id parser, the per-field
 * rules of the startup adapter, and the downstream shape the consumers assume.
 *
 * The assertion that matters most is the safe-integer pair. BIGSERIAL is
 * int64; an id past 2^53 that rounds instead of rejecting collides with a real
 * row under `ON CONFLICT(id)` in cacheMessages and overwrites a different
 * message. `"9007199254740992"` and int64-max must come back null, never a
 * rounded number.
 */
import { wireId } from '../msgIds';
import { startupChatSummary, startupMessage } from './startupAdapter';

let n = 0;
function ok(label: string, cond: boolean): void {
  n++;
  if (!cond) {
    console.error(`FAIL: ${label}`);
    process.exit(1);
  }
}

// ── wireId: accepted ───────────────────────────────────────────────────
ok('"1" → 1', wireId('1') === 1);
ok('"42" → 42', wireId('42') === 42);
ok('MAX_SAFE_INTEGER accepted', wireId('9007199254740991') === 9007199254740991);
ok('accepted values are numbers', typeof wireId('42') === 'number');

// ── wireId: the load-bearing bound ─────────────────────────────────────
// Not a formality and not unreachable: these are int64 values a BIGSERIAL can
// reach, and Number() rounds both silently.
ok('2^53 + 1 rejected, not rounded', wireId('9007199254740992') === null);
ok('int64 max rejected, not rounded', wireId('9223372036854775807') === null);
ok('Number() really would have rounded it', Number('9223372036854775807') === 9223372036854775808);

// ── wireId: rejected ───────────────────────────────────────────────────
for (const bad of [
  '0',            // optimistic-bubble band; a server row of 0 is a bug
  '-1',           // Exit-Kit import band; negative from the wire is corruption
  '-9007',
  '01',           // leading zero: two strings for one id breaks string dedupe
  '042',
  '1.0',          // Number("1.0") is a clean 1 — a non-integer producer looks fine until it emits 1.5
  '4.5',
  '1e3',          // parses under Number(); not a BIGSERIAL rendering
  '0x10',
  '0x2a',
  'Infinity',
  'NaN',
  ' 1',           // Number() trims, the regex does not
  '1 ',
  '42\n',
  '42abc',        // trailing characters (parseInt would take this as 42)
  '42,43',
  '',             // proto3 absence: means null, never 0
]) ok(`wireId(${JSON.stringify(bad)}) → null`, wireId(bad) === null);

for (const bad of [null, undefined, 42, {}, [], true]) {
  ok(`wireId(${String(bad)}) non-string → null`, wireId(bad) === null);
}
ok('wireId never throws on hostile input', (() => { try { wireId(Object.create(null)); return true; } catch { return false; } })());

// ── message rows ───────────────────────────────────────────────────────
const base = {
  chatId: '018f-aaaa-bbbb', senderId: 'u1', type: 'text' as const, content: 'hi',
  createdAt: '2026-09-18T10:00:00.000Z', editedAt: null, deletedAt: null,
};

const reply = startupMessage({ ...base, id: '7', replyToId: '3' })!;
ok('id parsed to number', reply.id === 7 && typeof reply.id === 'number');
ok('replyToId parsed to number', reply.replyToId === 3 && typeof reply.replyToId === 'number');
ok('reply-target map (number-keyed) hits', new Map([[3, 'x']]).get(reply.replyToId!) === 'x');
ok('chatId passed through as the same string, no coercion',
   reply.chatId === '018f-aaaa-bbbb' && typeof reply.chatId === 'string');
ok('createdAt stays an ISO string', reply.createdAt === '2026-09-18T10:00:00.000Z' && typeof reply.createdAt === 'string');
ok('content untouched', reply.content === 'hi');

const noReply = startupMessage({ ...base, id: '8', replyToId: '' })!;
ok('replyToId "" → null, strictly not 0', noReply.replyToId === null);
const missingReply = startupMessage({ ...base, id: '9' })!;
ok('missing replyToId → null, strictly not 0', missingReply.replyToId === null);
ok('rejected replyToId → null, not 0', startupMessage({ ...base, id: '9', replyToId: '0' })!.replyToId === null);

ok('id "" → row dropped', startupMessage({ ...base, id: '' }) === null);
ok('id "0" → row dropped, no id:0 constructed', startupMessage({ ...base, id: '0' }) === null);
ok('id "-5" → row dropped (import band unreachable from the wire)', startupMessage({ ...base, id: '-5' }) === null);
ok('id past 2^53 → row dropped, not rounded into a collision',
   startupMessage({ ...base, id: '9007199254740992' }) === null);
ok('empty chatId → row dropped', startupMessage({ ...base, id: '7', chatId: '' }) === null);

// ── chat summaries ─────────────────────────────────────────────────────
const chatBase = {
  id: '018f-cccc', type: 'direct' as const, name: null, photoURL: null, createdBy: null,
  createdAt: '2026-09-18T10:00:00.000Z', updatedAt: '2026-09-18T10:00:00.000Z',
  lastMessageAt: null, myRole: 'member' as any, muted: false, pinned: false,
  favourite: false, archived: false, hidden: false, unreadCount: 0,
};

const empty = startupChatSummary({ ...chatBase })!;
ok('absent lastMessageId → null (chat has no messages)', empty.lastMessageId === null);
ok('absent myLastReadId → null', empty.myLastReadId === null);
// unreadStore: `mine >= (r.lastMessageId ?? Infinity)` — a 0 here clears every badge.
ok('null lastMessageId does not clear a badge', !(5 >= (empty.lastMessageId ?? Infinity)));
const zeroed: number | null = startupChatSummary({ ...chatBase })!.lastMessageId === null ? 0 : null;
ok('a 0 there WOULD have cleared it (so null matters)', 5 >= (zeroed ?? Infinity));
ok('absent peer pointers stay absent', !('peerLastReadMessageId' in empty));

const full = startupChatSummary({
  ...chatBase, lastMessageId: '90', myLastReadId: '88',
  peerLastReadMessageId: '88', peerLastDeliveredMessageId: '89',
})!;
// CHANGED 2026-09-18. These two PASS THROUGH AS STRINGS and must not be
// narrowed. The server emits them as JSON strings (chats.go:1120,1123 ->
// userBigStr), listChats does no coercion, and cacheChats persists the row
// verbatim — so emitting a number writes a shape into the cache that no older
// build ever wrote, and an older reader (a bare JSON.parse, no normalization)
// reads back the wrong type after a rollback.
//
// This assertion used to demand a number. lib/chatsCacheRollback.selftest.ts
// caught it as a rollback break before it shipped; the contract wins over the
// (incorrect) ChatSummary declaration.
ok('lastMessageId stays the JSON path STRING, not narrowed',
  (full.lastMessageId as unknown) === '90' && typeof full.lastMessageId === 'string');
ok('myLastReadId stays the JSON path STRING, not narrowed',
  (full.myLastReadId as unknown) === '88' && typeof full.myLastReadId === 'string');
ok('peerLastReadMessageId → number', full.peerLastReadMessageId === 88 && typeof full.peerLastReadMessageId === 'number');
ok('peerLastDeliveredMessageId → number', full.peerLastDeliveredMessageId === 89);
ok('chat id passed through as opaque text', full.id === '018f-cccc' && typeof full.id === 'string');
// "0" PASSES THROUGH, and that is the contract-correct answer even though it
// looks less defensive than mapping it to null.
//
// The JSON path applies no coercion at all, so a server that sent "0" would
// put "0" in the cache today. The adapter must produce the SAME shape or the
// rollback gate breaks — a divergence here is a divergence, whichever
// direction it leans.
//
// It is also unreachable from a correct server: lastMessageId comes from
// userBigStr of a *int64 that is either nil (-> JSON null) or a BIGSERIAL id,
// and BIGSERIAL starts at 1. Only '' means absent on the wire, and '' -> null
// is asserted above.
ok('lastMessageId "0" passes through, matching the uncoerced JSON path',
  (startupChatSummary({ ...chatBase, lastMessageId: '0' })!.lastMessageId as unknown) === '0');
ok('bad chat id → dropped', startupChatSummary({ ...chatBase, id: '' }) === null);

// ── opaque cursors are never ids ───────────────────────────────────────
// `nextMutationCursor` is "<iso>|<n>" — feeding it to wireId would null it and
// stall the cursor. Asserted here so nobody "helpfully" parses it later.
const cursor = '2026-09-14T02:00:00Z|9';
ok('a cursor is not a wire id', wireId(cursor) === null);
ok('cursors must be echoed verbatim', cursor === '2026-09-14T02:00:00Z|9');

// ── downstream consumers receive the right type ────────────────────────
const page = ['10', '11', '12'].map((id, i) =>
  startupMessage({ ...base, id, replyToId: i === 2 ? '10' : undefined })!,
);
// syncEngine:68 — the hydrate filter
ok('every row survives syncEngine\'s `typeof id === "number" && id > 0`',
   page.map(m => m.id).filter(id => typeof id === 'number' && id > 0).length === page.length);
// syncEngine:110 — `b.id - a.id` inside a try/finally with no catch
const sorted = [...page].sort((a, b) => b.id - a.id);
ok('sort by `b.id - a.id` yields numbers, newest first',
   typeof (sorted[0].id - sorted[1].id) === 'number' && sorted[0].id === 12);
// localDb:425 — the silent skip
ok('no row is skipped by cacheMessages\' guard',
   page.every(m => !(typeof m.id !== 'number' || m.id <= 0)));
// localDb:500 — the per-chat cursor
const maxId = page.reduce((a, m) => (typeof m.id === 'number' && m.id > a ? m.id : a), 0);
ok('maxId > 0, so the sync cursor advances', maxId === 12);
// localDb:1157 — noteGlobalSyncCursor's Number.isFinite, which is false for a string
ok('a validated cursor passes Number.isFinite', Number.isFinite(maxId));
ok('the raw wire string would NOT have', !Number.isFinite('12' as any));

console.log(`startupAdapter.selftest: ${n} assertions passed`);
