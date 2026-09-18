// lib/ccwire/startupAdapter.ts — the ONE boundary between decoded protobuf
// startup rows (GET /chats, /chats/delta, first message page) and the
// number-keyed domain shapes. Nothing downstream of here may see a
// wire-shaped value.
//
// It sits here because downstream fails silently: a string id renders fine and
// is then skipped by cacheMessages' `typeof m.id !== 'number'` guard — history
// that looks right and vanishes on the next cold start (measured: 7 shown, 1
// survived a restart). One site fails loudly instead: `b.id - a.id` inside
// syncEngine's try/finally with no catch.
//
// Type-only imports of the domain shapes: erased at compile, so this module
// and its selftest never pull react-native in.

import type { ChatSummary, Message } from '../chatService';
import { wireId } from '../msgIds';

/** A decoded startup message row. Ids are proto `string`; proto3 has no null,
 *  so absence arrives as `''`. `seq`/`server_ts_ms` and friends are
 *  `[jstype = JS_STRING]` on purpose and are not narrowed here. */
export type WireMessage = Omit<Message, 'id' | 'replyToId'> & {
  id: string;
  replyToId?: string;
};

/** A decoded startup chat row: the four id fields as proto `string`. */
export type WireChatSummary = Omit<
  ChatSummary,
  'lastMessageId' | 'myLastReadId' | 'peerLastReadMessageId' | 'peerLastDeliveredMessageId'
> & {
  lastMessageId?: string;
  myLastReadId?: string;
  peerLastReadMessageId?: string;
  peerLastDeliveredMessageId?: string;
};

/** A group both the caller and one other user are in — the row shape of
 *  GET /chats/common/{userId}, exactly as the JSON path produces it. */
export interface CommonGroup { id: string; name: string | null; photoURL: string | null }

/**
 * `ccwire.v1.CommonGroupsReply` -> the SAME object the JSON path produces.
 *
 * IT LIVES HERE, NOT AS A LAMBDA AT THE CALL SITE. chatService.getCommonGroups
 * had it inline, and lib/chatsCommonNegotiation.selftest.ts could not reach it
 * — chatService drags react-native in and will not load under tsx — so the
 * selftest carried its own COPY and proved that copy correct. The shipped
 * decoder had no test at all: change `?? null` to `?? ''` in chatService and
 * every suite stayed green. That is the same failure this endpoint already
 * produced once (a decoder with no live caller); a decoder whose only test is a
 * re-implementation of it is the same false confidence wearing a hat.
 *
 * This module is the react-native-free wire->domain boundary and is already
 * imported by chatService, so moving the decoder here costs nothing at runtime
 * and puts the SHIPPED function under the selftest.
 *
 * `?? null`, not `?? ''` and not a conditional key: `name`/`photo_url` are
 * proto3 `optional`, so absence decodes to `undefined`, and JSON.stringify
 * DROPS undefined — a key the Go handler always writes as an explicit null
 * (commonGroup has no omitempty) would vanish from anything that caches this.
 * `photoUrl` -> `photoURL`: protoc lowercases the acronym; the JSON contract,
 * which every caller reads, says photoURL.
 *
 * The dynamic import carries NO `.js` suffix: tsc accepts one under
 * moduleResolution:bundler and Metro cannot resolve it against a generated
 * `_pb.ts`. It also keeps @bufbuild/protobuf off the cold-start path — this
 * function is only ever reached from api()'s response branch, after a server
 * has actually answered in binary.
 */
export async function commonGroupsFromProtobuf(
  bytes: Uint8Array,
): Promise<{ groups: CommonGroup[] }> {
  const { CommonGroupsReply } = await import('./gen/ccwire/v1/chats_common_pb');
  return {
    groups: CommonGroupsReply.fromBinary(bytes).groups.map((g) => ({
      id: g.id,
      name: g.name ?? null,
      photoURL: g.photoUrl ?? null,
    })),
  };
}

/**
 * Wire message row -> `Message`, or null if the row must be DROPPED.
 *
 * A row is dropped when its id is not a canonical positive decimal — including
 * `''` (absence) and any negative, which from the server is corruption, not a
 * value: the negative band belongs to `localDb.importMessages` alone. Dropping
 * is the only safe outcome; synthesising 0 would fabricate an optimistic row.
 *
 * `replyToId` rejects to `null`, never 0 — `Number(null)` is 0, which points
 * every ordinary message at message 0 as its reply target.
 */
export function startupMessage(r: WireMessage): Message | null {
  const id = wireId(r?.id);
  if (id === null || !r.chatId) return null;
  return { ...r, id, replyToId: wireId(r.replyToId) };
}

/**
 * Wire chat row -> `ChatSummary`, or null if it has no chat id.
 *
 * `lastMessageId` null means "this chat has no messages" and must stay null:
 * `unreadStore.applyLocalReadPointers` compares `mine >= (lastMessageId ??
 * Infinity)`, so a 0 there clears every unread badge.
 *
 * The optional peer pointers keep their absence rather than gaining a null key
 * — but read that as a property of THIS function, not of the rows the app
 * actually stores. Its only chat-list caller, `decodeChatList`
 * (`chatService.ts:1210-1211`), coerces `undefined -> ''` before calling, so
 * the guard below always fires and the key is always written as an explicit
 * `null` (`wireId('')` is null). That is deliberate: the Go struct has no
 * `omitempty` and always emits the key, and `JSON.stringify` would drop an
 * `undefined` one from the cache row `cacheChats` persists.
 *
 * `id` stays opaque text — never `wireId`, never `Number`.
 */
export function startupChatSummary(r: WireChatSummary): ChatSummary | null {
  if (!r?.id) return null;
  const { peerLastReadMessageId: read, peerLastDeliveredMessageId: delivered, ...rest } = r;
  // lastMessageId / myLastReadId PASS THROUGH AS STRINGS. Do not wireId() them.
  //
  // ChatSummary declares them `number | null`, and that declaration is WRONG:
  // the server emits them as JSON STRINGS (chats.go:1120,1123 -> userBigStr ->
  // strconv.FormatInt) and listChats does no coercion, so every shipped build
  // has only ever seen a string here. peerLast* really are JSON numbers
  // (chats.go:1137-1138) — three id representations in one object.
  //
  // The contract, not the type, is what must be preserved. cacheChats stores
  // JSON.stringify of the whole row (localDb.ts:1190), so emitting a number
  // here would write a shape into the cache that no older build ever wrote,
  // and an older reader — which does a bare JSON.parse with no normalization —
  // would read back the wrong type after a rollback.
  //
  // Caught by lib/chatsCacheRollback.selftest.ts before this shipped, which is
  // exactly what that gate exists for. The relational compares that consume
  // these (unreadStore.ts `mine >= (lastMessageId ?? Infinity)`) coerce, so a
  // string is correct today and stays correct.
  //
  // ponytail: fixing the ChatSummary type lie is a separate change with its own
  // blast radius — it touches the JSON path too. Not smuggled in here.
  const out: ChatSummary = {
    ...rest,
    // `?? null` is NOT enough: proto3 represents absence as '' and the empty
    // string is not nullish. A '' here would reach the cache where the JSON
    // path writes null, and `'' ?? Infinity` is '' — which compares FALSE
    // against any pointer, so an unread badge would never clear.
    lastMessageId: (r.lastMessageId || null) as unknown as ChatSummary['lastMessageId'],
    myLastReadId: (r.myLastReadId || null) as unknown as ChatSummary['myLastReadId'],
  };
  if (read !== undefined) out.peerLastReadMessageId = wireId(read);
  if (delivered !== undefined) out.peerLastDeliveredMessageId = wireId(delivered);
  return out;
}
