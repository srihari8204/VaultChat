// lib/bookmarkBodies.selftest.ts — run: npx tsx lib/bookmarkBodies.selftest.ts
import assert from 'node:assert/strict';
import { bookmarkBody, hasBodies, withoutBodies } from './bookmarkBodies';

const isCipher = (s: string) => s.startsWith('GSK1:') || s.startsWith('{"v":"dr1"');

// The sealed local snapshot wins — it is the decrypted copy.
assert.equal(bookmarkBody('GSK1:abc', 'hello', isCipher), 'hello');
assert.equal(bookmarkBody('server text', 'local text', isCipher), 'local text');
// Ciphertext is never shown as if it were a message.
assert.equal(bookmarkBody('GSK1:abc', null, isCipher), null);
assert.equal(bookmarkBody('{"v":"dr1","c":"x"}', undefined, isCipher), null);
// A non-envelope server body (legacy plaintext) is still shown.
assert.equal(bookmarkBody('plain', null, isCipher), 'plain');
assert.equal(bookmarkBody(null, null, isCipher), null);

// The cached list never carries a body.
const rows = [
  { id: '1', message: { id: 1, content: 'secret' } },
  { id: '2', message: null },
  { id: '3', message: { id: 3, content: null } },
];
const stripped = withoutBodies(rows);
assert.equal(hasBodies(rows), true);
assert.equal(hasBodies(stripped), false);
assert.equal(stripped[0].message!.content, null);
assert.equal((stripped[0].message as any).id, 1, 'other fields kept');
assert.equal(rows[0].message!.content, 'secret', 'input not mutated');
assert.equal(stripped[1], rows[1]);

console.log('bookmarkBodies selftest: ok');
