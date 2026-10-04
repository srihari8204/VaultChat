/**
 * lib/shelfOpen.selftest.ts
 *   run with: npx tsx lib/shelfOpen.selftest.ts
 */
import assert from 'node:assert/strict';
import { shelfListable, shelfOpenParams } from './shelfOpen';

let n = 0;
const ok = (label: string, cond: boolean) => { assert.ok(cond, label); n++; };

const base = {
  attachmentId: 'a1', chatId: 'c1', senderId: 'u-me', filename: 'scan.pdf', mime: 'application/pdf', kind: 'document',
};

// Listing
ok('plain file is listed', shelfListable({}));
ok('view-once is never listed', !shelfListable({ viewOnce: true }));

// Flag mapping
const enc = shelfOpenParams({ ...base, encrypted: true }, 'u-me');
ok('encrypted flag reaches the viewer', enc.encrypted === '1');
ok('own file is isMine', enc.isMine === '1');
ok('document opens as file', enc.msgType === 'file');
ok('chat id carried', enc.chatId === 'c1');

const plain = shelfOpenParams({ ...base, senderId: 'u-other' }, 'u-me');
ok('plaintext is not flagged encrypted', plain.encrypted === '');
ok("someone else's file is not mine", plain.isMine === '');

ok('unknown me → never mine', shelfOpenParams(base, null).isMine === '');
ok('unknown sender → never mine', shelfOpenParams({ ...base, senderId: null }, 'u-me').isMine === '');
ok('image kind', shelfOpenParams({ ...base, kind: 'image' }, null).msgType === 'image');
ok('null mime → empty string', shelfOpenParams({ ...base, mime: null }, null).mime === '');
ok('params never carry viewOnce', !('viewOnce' in enc));

console.log(`shelfOpen selftest: ${n} checks passed`);
