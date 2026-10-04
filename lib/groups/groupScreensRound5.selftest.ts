// lib/groups/groupScreensRound5.selftest.ts — run: npx tsx lib/groups/groupScreensRound5.selftest.ts
//
// Round-5 group fixes:
//   1. queueMerged — group-admin stops listing invite-link requests itself once
//      the approval queue answers in the merged (C8) shape, so a request is
//      shown in one place (Add people → Waiting), never two.
//   2. managementProbeResult — communities hides edit/delete/leave/attach when
//      the probe shows the C9 routes are missing, keeps them when they exist,
//      and cannot tell from an offline or 5xx answer.
//   3. GROUP_COLORS — the group-create palette lives in the catalog (the
//      catalog's own self-check asserts its contrast).
// The "latest choice wins" saver for group-admin has its own latestSave.selftest.ts.

import assert from 'node:assert/strict';
import { queueMerged, managementProbeResult, type QueueRow } from './serverContracts';
import { GROUP_COLORS, inkOn } from './catalog';

const row = (over: Partial<QueueRow>): QueueRow => ({
  id: 1, userId: 'u1', name: 'A', photoURL: null, status: 'accepted', requested: false,
  inviterName: null, createdAt: '2026-10-04T00:00:00Z', acceptedAt: null, canApprove: true, canReject: true,
  ...over,
});

// ── 1. queueMerged ──
assert.equal(queueMerged([]), false, 'an empty queue says nothing; group-admin keeps its (then empty) list');
assert.equal(queueMerged([row({})]), false, "today's server: rows have no source");
assert.equal(queueMerged([row({ source: 'invitation' })]), true, 'C8: invitation rows carry source');
assert.equal(queueMerged([row({ source: 'invitation' }), row({ id: null, source: 'link', userId: 'u2' })]), true);

// ── 2. managementProbeResult ──
assert.equal(managementProbeResult({ status: 405, message: 'Method Not Allowed' }), false, 'route missing');
assert.equal(managementProbeResult({ status: 404, message: 'route not migrated to go backend' }), false, 'gateway catch-all');
assert.equal(managementProbeResult({ status: 400, message: 'name or description required' }), true, 'owner, empty patch refused');
assert.equal(managementProbeResult({ status: 403, message: 'Only the community owner can edit it' }), true, 'non-owner');
assert.equal(managementProbeResult({ status: 404, message: 'Community not found' }), true, 'the route answered');
assert.equal(managementProbeResult({ message: 'Network request failed' }), null, 'offline: cannot tell');
assert.equal(managementProbeResult({ status: 502, message: 'Bad Gateway' }), null, '5xx: cannot tell');
assert.equal(managementProbeResult(null), true, 'a 2xx means the route exists');

// ── 3. GROUP_COLORS ──
assert.equal(GROUP_COLORS.length, 8);
for (const c of GROUP_COLORS) assert.ok(inkOn(c.hex), c.name);

console.log('groupScreensRound5 selftest: ok');
