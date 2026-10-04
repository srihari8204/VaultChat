// lib/peerSafetySummary.selftest.ts — run: npx tsx lib/peerSafetySummary.selftest.ts
import assert from 'node:assert/strict';
import { peerSafetySummary } from './peerSafetySummary';

assert.equal(peerSafetySummary([], 0), 'No direct chats yet.');
assert.equal(peerSafetySummary([], 3), '0 of 3 direct chats verified · checking 3 more…');
assert.equal(peerSafetySummary(['verified'], 1), '1 of 1 direct chat verified');
assert.equal(
  peerSafetySummary(['verified', 'changed', 'unverified', 'verified', 'nokey', 'unknown'], 8),
  '2 of 8 direct chats verified · 1 security code changed · 1 without end-to-end encryption yet · 1 could not be checked · checking 2 more…',
);
assert.equal(peerSafetySummary(['changed', 'changed'], 2), '0 of 2 direct chats verified · 2 security codes changed');
console.log('peerSafetySummary.selftest: all checks passed');
