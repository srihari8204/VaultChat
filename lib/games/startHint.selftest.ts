// lib/games/startHint.selftest.ts — run: npx tsx lib/games/startHint.selftest.ts
import assert from 'node:assert/strict';
import { startBlockedReason } from './startHint';

assert.equal(startBlockedReason(true, 2), null, 'a host with two players can start');
assert.equal(startBlockedReason(true, 4), null);
assert.match(startBlockedReason(true, 1) ?? '', /Two players minimum/, 'a lone host is told to find a second player');
assert.match(startBlockedReason(false, 1) ?? '', /Only the host/, 'a guest is told only the host can start');
assert.match(startBlockedReason(false, 3) ?? '', /Only the host/, '...even when the table is full enough');
console.log('startHint.selftest: 5 passed');
