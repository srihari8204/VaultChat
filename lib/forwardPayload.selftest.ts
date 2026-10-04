// lib/forwardPayload.selftest.ts — run: npx tsx lib/forwardPayload.selftest.ts
//
// A forward now goes through the outbox (app/chat.tsx doForward →
// messageQueue.enqueueMessage) instead of chatService.forwardMessage, so the
// rules that function applied must hold for the payload handed to the queue:
// protected content never travels, a local path never travels, the hop count
// keeps counting, and the body and type are the source's.

import assert from 'node:assert/strict';
import { forwardPayload } from './forwardPayload';

const src = { id: 41, chatId: 'c-src', senderId: 'u-alice', type: 'text', content: 'hello' };

// 1. Protected content is refused, not stripped and re-sent as permanent.
assert.throws(() => forwardPayload({ ...src, meta: { viewOnce: true } }), /cannot be forwarded/);
assert.throws(() => forwardPayload({ ...src, meta: { invisibleInk: true } }), /cannot be forwarded/);

// 2. An ordinary text forward: same body and type, labelled, first hop.
const p = forwardPayload(src);
assert.equal(p.type, 'text');
assert.equal(p.plaintext, 'hello');
assert.deepEqual(p.meta.forwardedFrom, { messageId: 41, chatId: 'c-src', senderId: 'u-alice' });
assert.equal(p.meta.forwardScore, 1);

// 3. A chain keeps counting from the SOURCE's score.
assert.equal(forwardPayload({ ...src, meta: { forwardScore: 4 } }).meta.forwardScore, 5);
// ...and a pre-score forward (forwardedFrom only) counts as one hop already.
assert.equal(forwardPayload({ ...src, meta: { forwardedFrom: { messageId: 1, chatId: 'x', senderId: 'y' } } }).meta.forwardScore, 2);

// 4. Media: the attachment reference travels, the sender's local file path does not.
const media = forwardPayload({
  ...src, type: 'image', content: null,
  meta: { attachmentId: 'att-9', mime: 'image/jpeg', thumb: 'AAAA', localUri: 'file:///data/user/0/x.jpg' },
});
assert.equal(media.type, 'image');
assert.equal(media.plaintext, '', 'an uncaptioned photo forwards an empty body, not "null"');
assert.equal(media.meta.attachmentId, 'att-9');
assert.equal(media.meta.thumb, 'AAAA');
assert.ok(!('localUri' in media.meta), 'a device path must never be forwarded');

// 5. The source meta object is not mutated (it is the bubble's live meta).
const liveMeta = { attachmentId: 'a', localUri: 'file:///x' };
forwardPayload({ ...src, meta: liveMeta });
assert.equal(liveMeta.localUri, 'file:///x');

console.log('forwardPayload: all passed');
