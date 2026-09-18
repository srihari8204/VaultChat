// lib/chatsCacheRollback.selftest.ts — run: npx tsx lib/chatsCacheRollback.selftest.ts
//   (needs the Node sqlite driver once: npm i -D better-sqlite3)
//
// THE RELEASE GATE THIS EXISTS TO PROVE
// -------------------------------------
// "An older application must read records written by the new version using its
//  OLD reader, without relying on any newly added normalization."
//
// That is a ROLLBACK requirement. It means whatever the protobuf adapter hands
// to `cacheChats` must be SHAPE-IDENTICAL to what today's JSON path hands it:
// same key set, same runtime types, same null-vs-absent — INCLUDING today's
// inconsistencies. One chat row currently ships three different id
// representations and that is the contract to preserve, not to fix.
//
// THE CONTRACT, ESTABLISHED FROM SOURCE (not assumed):
//   vaultchat-backend-go/internal/routes/chats.go — `chatsListItem`
//     LastMessageID *string  ← userBigStr() = strconv.FormatInt  → JSON STRING
//     MyLastReadID  *string  ← userBigStr()                      → JSON STRING
//     PeerLastReadMessageID      *int64                          → JSON NUMBER
//     PeerLastDeliveredMessageID *int64                          → JSON NUMBER
//     No `omitempty` anywhere on the struct, so EVERY key is present and a
//     nil pointer serialises as an explicit `null` — never as an absent key.
//   lib/chatService.ts — `ChatSummary` DECLARES all four as `number | null`.
//     Three of them are a lie at runtime. listChats() does no coercion; the
//     rows are handed to consumers exactly as JSON.parse produced them.
//   lib/localDb.ts cacheChats() — persists `JSON.stringify(c)` of the WHOLE
//     row, so the cache preserves those runtime types verbatim.
//   lib/localDb.ts getCachedChats() — JSON.parse, no normalization at all.
//
// HONESTY / SCOPE — read before trusting a green run. See the closing block.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { startupChatSummary, type WireChatSummary } from './ccwire/startupAdapter';
import { applyLocalReadPointers } from './unreadStore';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCALDB = readFileSync(join(HERE, 'localDb.ts'), 'utf8');
const CHATS_GO = readFileSync(
  join(HERE, '..', 'vaultchat-backend-go', 'internal', 'routes', 'chats.go'), 'utf8');

let failures = 0;
const defects: string[] = [];
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
function defect(name: string, ok: boolean, detail: string) {
  if (!ok) defects.push(`${name} — ${detail}`);
  check(name, ok, detail);
}

// ═══ 0. The contract is still what this file says it is ══════════════════
// Lifted from the Go source, so a server-side change breaks this test rather
// than silently invalidating every fixture below.
console.log('0. the server contract, re-read from chats.go');
const item = CHATS_GO.match(/type chatsListItem struct \{[\s\S]*?\n\}/)?.[0] ?? '';
check('chatsListItem found', !!item);
check('lastMessageId is *string (JSON string)', /LastMessageID\s+\*string\s+`json:"lastMessageId"`/.test(item));
check('myLastReadId is *string (JSON string)', /MyLastReadID\s+\*string\s+`json:"myLastReadId"`/.test(item));
check('peerLastReadMessageId is *int64 (JSON number)',
  /PeerLastReadMessageID\s+\*int64\s+`json:"peerLastReadMessageId"`/.test(item));
check('peerLastDeliveredMessageId is *int64 (JSON number)',
  /PeerLastDeliveredMessageID\s+\*int64\s+`json:"peerLastDeliveredMessageId"`/.test(item));
check('no omitempty: a nil pointer is an explicit null key, never absent',
  !/omitempty/.test(item));
check('userBigStr really is strconv.FormatInt (ids leave as decimal text)',
  /func userBigStr\(n \*int64\) \*string \{[\s\S]*?strconv\.FormatInt/.test(
    readFileSync(join(HERE, '..', 'vaultchat-backend-go', 'internal', 'routes', 'user.go'), 'utf8')));

// ═══ 1. Independent fixtures ═════════════════════════════════════════════
// The JSON fixture is the literal bytes the Go handler marshals for one chat.
// Hand-written from the struct above — deliberately NOT produced by any client
// code, so nothing under test can agree with itself.
const JSON_BYTES = `{
  "id": "chat-7",
  "type": "direct",
  "name": null,
  "photoURL": null,
  "createdBy": "user-1",
  "createdAt": "2026-09-01T10:00:00.000Z",
  "updatedAt": "2026-09-18T08:30:00.000Z",
  "lastMessageId": "9412",
  "lastMessageAt": "2026-09-18T08:30:00.000Z",
  "myRole": "member",
  "myLastReadId": "9410",
  "muted": false,
  "pinned": false,
  "favourite": false,
  "archived": false,
  "hidden": false,
  "screenshotMode": "block",
  "vanishMode": false,
  "unreadCount": 2,
  "peerUserId": "user-2",
  "peerName": "Ada",
  "peerPhotoURL": null,
  "peerOnline": true,
  "peerLastSeenAt": "2026-09-18T08:29:00.000Z",
  "peerLastReadMessageId": 9408,
  "peerLastDeliveredMessageId": 9412,
  "anonMasked": false,
  "expiresAt": null
}`;
// A chat with NOTHING in it — every nullable pointer nil. This is the row that
// carries the `lastMessageId ?? Infinity` unread rule.
const JSON_BYTES_EMPTY = `{
  "id": "chat-8", "type": "group", "name": "Ops", "photoURL": null,
  "createdBy": "user-1", "createdAt": "2026-09-02T10:00:00.000Z",
  "updatedAt": "2026-09-02T10:00:00.000Z",
  "lastMessageId": null, "lastMessageAt": null, "myRole": "owner",
  "myLastReadId": null, "muted": false, "pinned": true, "favourite": false,
  "archived": false, "hidden": false, "screenshotMode": "block",
  "vanishMode": false, "unreadCount": 0, "peerUserId": null, "peerName": null,
  "peerPhotoURL": null, "peerOnline": false, "peerLastSeenAt": null,
  "peerLastReadMessageId": null, "peerLastDeliveredMessageId": null,
  "anonMasked": false, "expiresAt": null
}`;

const jsonRow: any = JSON.parse(JSON_BYTES);
const jsonEmpty: any = JSON.parse(JSON_BYTES_EMPTY);

// The protobuf-shaped row for the SAME logical chat. proto3 has no null, so
// absence is `''` — that is what WireChatSummary documents.
const wireRow = {
  id: 'chat-7',
  type: 'direct',
  name: null,
  photoURL: null,
  createdBy: 'user-1',
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-18T08:30:00.000Z',
  lastMessageId: '9412',
  lastMessageAt: '2026-09-18T08:30:00.000Z',
  myRole: 'member',
  myLastReadId: '9410',
  muted: false, pinned: false, favourite: false, archived: false, hidden: false,
  screenshotMode: 'block',
  vanishMode: false,
  unreadCount: 2,
  peerUserId: 'user-2', peerName: 'Ada', peerPhotoURL: null, peerOnline: true,
  peerLastSeenAt: '2026-09-18T08:29:00.000Z',
  peerLastReadMessageId: '9408',
  peerLastDeliveredMessageId: '9412',
  anonMasked: false,
  expiresAt: null,
} as unknown as WireChatSummary;

const wireEmpty = {
  id: 'chat-8', type: 'group', name: 'Ops', photoURL: null, createdBy: 'user-1',
  createdAt: '2026-09-02T10:00:00.000Z', updatedAt: '2026-09-02T10:00:00.000Z',
  lastMessageId: '', lastMessageAt: null, myRole: 'owner', myLastReadId: '',
  muted: false, pinned: true, favourite: false, archived: false, hidden: false,
  screenshotMode: 'block', vanishMode: false, unreadCount: 0,
  peerUserId: null, peerName: null, peerPhotoURL: null, peerOnline: false,
  peerLastSeenAt: null, peerLastReadMessageId: '', peerLastDeliveredMessageId: '',
  anonMasked: false, expiresAt: null,
} as unknown as WireChatSummary;

// ═══ 2. Adapter output vs the JSON path, FIELD BY FIELD ══════════════════
// The gate: any difference in key name, runtime type, or null-vs-absent is a
// rollback defect, because the old reader does no normalization and will hand
// the difference straight to the UI.
console.log('\n2. protobuf adapter output vs the JSON path shape');

function describe(v: unknown): string {
  return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
}
function diffShape(a: any, b: any): string[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const out: string[] = [];
  for (const k of keys) {
    const inA = k in a, inB = k in b;
    if (inA !== inB) { out.push(`${k}: ${inA ? 'present(JSON)/ABSENT(proto)' : 'ABSENT(JSON)/present(proto)'}`); continue; }
    if (describe(a[k]) !== describe(b[k])) out.push(`${k}: JSON ${describe(a[k])} vs proto ${describe(b[k])}`);
  }
  return out;
}

const adapted: any = startupChatSummary(wireRow);
check('adapter returns a row for a valid chat', !!adapted);
const adaptedEmpty: any = startupChatSummary(wireEmpty);
check('adapter returns a row for an empty chat', !!adaptedEmpty);
check('adapter drops a row with no chat id',
  startupChatSummary({ ...wireRow, id: '' } as any) === null);

const d1 = diffShape(jsonRow, adapted ?? {});
defect('populated row: adapter shape === JSON path shape', d1.length === 0, d1.join(' | '));
const d2 = diffShape(jsonEmpty, adaptedEmpty ?? {});
defect('empty row: adapter shape === JSON path shape', d2.length === 0, d2.join(' | '));

// Named explicitly so the report says which of the three id representations
// moved, not just "something differs".
defect('lastMessageId keeps the JSON path type',
  describe(adapted?.lastMessageId) === describe(jsonRow.lastMessageId),
  `JSON ${describe(jsonRow.lastMessageId)} vs proto ${describe(adapted?.lastMessageId)}`);
defect('myLastReadId keeps the JSON path type',
  describe(adapted?.myLastReadId) === describe(jsonRow.myLastReadId),
  `JSON ${describe(jsonRow.myLastReadId)} vs proto ${describe(adapted?.myLastReadId)}`);
defect('peerLastReadMessageId keeps the JSON path type',
  describe(adapted?.peerLastReadMessageId) === describe(jsonRow.peerLastReadMessageId),
  `JSON ${describe(jsonRow.peerLastReadMessageId)} vs proto ${describe(adapted?.peerLastReadMessageId)}`);
defect('empty chat: peer pointers stay null keys, not absent keys',
  'peerLastReadMessageId' in (adaptedEmpty ?? {}) &&
  adaptedEmpty?.peerLastReadMessageId === null,
  `JSON has null, proto has ${'peerLastReadMessageId' in (adaptedEmpty ?? {}) ? describe(adaptedEmpty.peerLastReadMessageId) : 'ABSENT'}`);
check('lastMessageId null on an empty chat is preserved as null, never 0',
  adaptedEmpty?.lastMessageId === null,
  'a 0 here clears every unread badge via `mine >= (lastMessageId ?? Infinity)`');

// ═══ 3. The real cache SQL, lifted from localDb.ts ═══════════════════════
// Not restated — restated SQL agrees with itself no matter what ships.
console.log('\n3. the real writer + the CURRENT, UNCHANGED reader');

function ddl(name: string): string {
  const m = LOCALDB.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name}[\\s\\S]*?;`));
  if (!m) throw new Error(`selftest: no DDL for ${name} in localDb.ts — renamed?`);
  return m[0];
}
const cacheChatsSrc = LOCALDB.match(/export async function cacheChats[\s\S]*?\n\}/)?.[0] ?? '';
const getCachedSrc  = LOCALDB.match(/export async function getCachedChats[\s\S]*?\n\}/)?.[0] ?? '';
const INSERT_SQL = cacheChatsSrc.match(/`(INSERT OR REPLACE INTO chats[\s\S]*?)`/)?.[1];
const SELECT_SQL = getCachedSrc.match(/`(SELECT data FROM chats[\s\S]*?)`/)?.[1];
check('cacheChats INSERT lifted from source', !!INSERT_SQL, INSERT_SQL ?? 'not found');
check('getCachedChats SELECT lifted from source', !!SELECT_SQL, SELECT_SQL ?? 'not found');
check('the writer persists JSON.stringify of the WHOLE row (no field projection)',
  /encField\(JSON\.stringify\(c\)\)/.test(cacheChatsSrc),
  'if it ever projects fields, the cache stops being a verbatim copy of the wire row');
check('the CURRENT reader adds NO normalization — plain JSON.parse',
  /rows\.map\(\(r: any\) => safeParse\(decField\(r\.data\) \|\| ''\)\)\.filter\(Boolean\)/.test(getCachedSrc),
  'a normalizing reader would MASK a rollback break rather than expose it');
check('safeParse is a bare JSON.parse',
  /function safeParse\(s: string\): any \{ try \{ return JSON\.parse\(s\); \} catch \{ return null; \} \}/.test(LOCALDB));

const db = new Database(':memory:');
db.exec(ddl('chats'));
const put = db.prepare(INSERT_SQL!);
const sel = db.prepare(SELECT_SQL!);
// encField/decField are AEAD over the same string (proved in cacheCrypto.selftest);
// identity here keeps this test about the SHAPE that survives, not the cipher.
const write = (rows: any[]) => {
  const ids = rows.map(r => r.id);
  db.prepare(`DELETE FROM chats WHERE id NOT IN (${ids.map(() => '?').join(',')})`).run(...ids);
  for (const c of rows) put.run(c.id, JSON.stringify(c), c.lastMessageAt ?? null);
};
const read = (): any[] => (sel.all() as any[]).map(r => JSON.parse(r.data));

// 3a. TODAY's JSON path through the cache — the behaviour that must not change.
write([jsonRow, jsonEmpty]);
const backJson = read();
check('JSON path round-trips byte-identically through the cache',
  JSON.stringify(backJson[0]) === JSON.stringify(jsonRow) &&
  JSON.stringify(backJson[1]) === JSON.stringify(jsonEmpty));
check('…preserving all three id representations',
  typeof backJson[0].lastMessageId === 'string' &&
  typeof backJson[0].myLastReadId === 'string' &&
  typeof backJson[0].peerLastReadMessageId === 'number');
check('ordering: newest lastMessageAt first, null last_message_at sinks',
  backJson.map(r => r.id).join(',') === 'chat-7,chat-8',
  backJson.map(r => r.id).join(','));

// 3b. THE ROLLBACK PROOF: the NEW writer's output read by the CURRENT reader.
write([adapted, adaptedEmpty]);
const backProto = read();
check('a cache written from protobuf rows is readable at all', backProto.length === 2);
check('…and still orders correctly',
  backProto.map(r => r.id).join(',') === 'chat-7,chat-8',
  backProto.map(r => r.id).join(','));
const rb1 = diffShape(backJson[0], backProto[0]);
const rb2 = diffShape(backJson[1], backProto[1]);
defect('ROLLBACK: protobuf-written row reads back with the JSON path shape',
  rb1.length === 0, rb1.join(' | '));
defect('ROLLBACK: protobuf-written empty row reads back with the JSON path shape',
  rb2.length === 0, rb2.join(' | '));

// ═══ 4. Opt-in off: a cache written by the new path stays usable ═════════
// lib/api.ts negotiates protobuf per call by passing a `proto` decoder; no
// decoder = the unchanged JSON path. Turning it off therefore does not touch
// the cache — the old bytes are still on disk and the cold-start paint in
// app/(tabs)/chats.tsx runs before any network call at all.
console.log('\n4. protobuf opt-in OFF, previously-written cache still usable');
const API = readFileSync(join(HERE, 'api.ts'), 'utf8');
check('opt-in is per-call and absent by default',
  /Accept: proto \? PROTOBUF_ACCEPT : 'application\/json'/.test(API),
  'a global switch would make "off" a different code path, not the same one');
const CHATS_TSX = readFileSync(join(HERE, '..', 'app', '(tabs)', 'chats.tsx'), 'utf8');
check('the cold-start paint reads the cache BEFORE any fetch',
  CHATS_TSX.indexOf('await getCachedChats()') < CHATS_TSX.indexOf('await fetchList()'));
// The cache written in 3b is still what is on disk. Read it with no network.
const offline = read();
check('offline read after opt-in off returns every cached chat', offline.length === 2);
// The two things the Chats screen actually computes off these rows.
const badge = offline.reduce((n, c) => n + (c.archived ? 0 : (c.unreadCount > 0 ? 1 : 0)), 0);
check('unread tab badge computes the same as from the JSON cache',
  badge === backJson.reduce((n, c) => n + (c.archived ? 0 : (c.unreadCount > 0 ? 1 : 0)), 0),
  String(badge));
check('every row still carries a usable string chat id',
  offline.every(c => typeof c.id === 'string' && c.id.length > 0));

// ═══ 5. unreadStore's REAL comparison, on both shapes ════════════════════
// `mine >= (r.lastMessageId ?? Infinity)` is run here, not restated. A string
// lastMessageId works only because JS coerces it in a relational compare —
// that accident is part of the contract the rollback must keep.
console.log('\n5. unread rule: the real applyLocalReadPointers');
const clone = (r: any) => JSON.parse(JSON.stringify(r));

// read up to the last message → badge clears, whichever shape the id has.
{
  const j = [clone(jsonRow)], p = [clone(adapted)];
  applyLocalReadPointers(j as any, { 'chat-7': 9412 });
  applyLocalReadPointers(p as any, { 'chat-7': 9412 });
  check('caught up: JSON path (string id) clears the badge', j[0].unreadCount === 0);
  check('caught up: protobuf path clears the badge too', p[0].unreadCount === 0);
  check('both paths agree', j[0].unreadCount === p[0].unreadCount);
}
// behind the last message → badge stays, both shapes.
{
  const j = [clone(jsonRow)], p = [clone(adapted)];
  applyLocalReadPointers(j as any, { 'chat-7': 9411 });
  applyLocalReadPointers(p as any, { 'chat-7': 9411 });
  check('behind: JSON path keeps the badge', j[0].unreadCount === 2);
  check('behind: protobuf path keeps the badge', p[0].unreadCount === 2);
}
// the `?? Infinity` path: a chat with no messages must never be cleared.
{
  const j = [clone({ ...jsonEmpty, unreadCount: 3 })];
  const p = [clone({ ...adaptedEmpty, unreadCount: 3 })];
  applyLocalReadPointers(j as any, { 'chat-8': 999999 });
  applyLocalReadPointers(p as any, { 'chat-8': 999999 });
  check('lastMessageId null → Infinity → badge survives (JSON)', j[0].unreadCount === 3);
  check('lastMessageId null → Infinity → badge survives (protobuf)', p[0].unreadCount === 3);
  check('a 0 would have wrongly cleared it (guard is load-bearing)',
    (() => { const z = [clone({ ...jsonEmpty, unreadCount: 3, lastMessageId: 0 })];
             applyLocalReadPointers(z as any, { 'chat-8': 999999 });
             return z[0].unreadCount === 0; })());
}
// no pointer at all must not clear anything.
{
  const j = [clone(jsonRow)];
  applyLocalReadPointers(j as any, {});
  check('no local read pointer leaves the server count alone', j[0].unreadCount === 2);
}
// receipt comparison: peer pointers are NUMBERS on the JSON path; a tick
// rendered from `peerLastReadMessageId >= lastMessageId` mixes number vs
// string TODAY and must keep mixing the same way after rollback.
{
  const seen = (c: any) => (c.peerLastReadMessageId ?? 0) >= (c.lastMessageId ?? Infinity);
  const del  = (c: any) => (c.peerLastDeliveredMessageId ?? 0) >= (c.lastMessageId ?? Infinity);
  check('JSON path: peer has NOT read the newest message', seen(jsonRow) === false);
  check('JSON path: peer HAS been delivered the newest message', del(jsonRow) === true);
  check('protobuf path agrees on read', seen(adapted) === seen(jsonRow));
  check('protobuf path agrees on delivered', del(adapted) === del(jsonRow));
  check('mixed number/string compare really is the live behaviour',
    (9412 as any) >= ('9412' as any) && !((9408 as any) >= ('9412' as any)));
}

// ═══ Report ══════════════════════════════════════════════════════════════
console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
if (defects.length) {
  console.log('\nROLLBACK DEFECTS (lib/ccwire/startupAdapter.ts — owned elsewhere, NOT fixed here):');
  for (const d of defects) console.log(`  · ${d}`);
}
console.log(`
ROLLBACK EVIDENCE — what this run does and does NOT prove
  COMPLETE:
    · the server contract above is re-read from chats.go/user.go, so it cannot
      drift silently underneath the fixtures;
    · the fixtures are hand-written from that contract, never produced by the
      adapter under test;
    · sections 3-5 run the REAL cacheChats/getCachedChats SQL lifted from
      lib/localDb.ts and the REAL applyLocalReadPointers.
  INCOMPLETE — and cannot be completed from here:
    · THE OLD READER IS THE SAME SOURCE TEXT AS THE NEW ONE. getCachedChats is
      untouched by this migration, so "old reader" and "current reader" are one
      function. This run asserts it carries no normalization, but it cannot
      execute a genuinely older build's reader. True rollback proof needs the
      previous release APK reading a cache written by this build, on a device.
    · encField/decField are identity here, not the real AEAD, and no op-sqlite
      engine is involved. Section 3 proves the SQL and the shape, not the
      on-device storage layer.
    · no device, no server: nothing here proves the Go handler actually emits
      the protobuf rows the wire fixtures model. The fixtures are hand-written
      from the contract re-read in section 0, not captured from a producer.
      (Corrected 2026-09-19: this bullet used to add "there is no chat-list
      .proto in proto/ccwire/v1 yet and startupChatSummary has no production
      caller". Both are now false -- proto/ccwire/v1/chats_list.proto exists,
      and startupChatSummary is called from chatService.ts:1185 inside
      decodeChatList, reached from listChats at chatService.ts:1231. The
      adapter is wired into shipped code; it is dormant only because no
      deployed server answers application/protobuf yet.)
`);
process.exit(failures ? 1 : 0);
