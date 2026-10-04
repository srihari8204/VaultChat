// lib/groups/groupScreensRound7.selftest.ts — run: npx tsx lib/groups/groupScreensRound7.selftest.ts
//
// Round-7 group changes are structural (no new pure logic), so this pins them
// in the source:
//   1. group-calendar's new/edit sheet lives in components/groups/GroupEventComposer
//      and is remounted per open (a fresh draft each time).
//   2. group-invites lays its three lists out in a SectionList, not .map in a
//      ScrollView, with non-sticky headers.
//   3. group-admin keeps a join request on screen until the server answers
//      (busy spinner), instead of removing it before the call.
//   4. Modal scrims in the group screens use the theme's `scrim` token.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── 1. calendar composer ──
const cal = read('app/group-calendar.tsx');
const composer = read('components/groups/GroupEventComposer.tsx');
assert.match(cal, /<GroupEventComposer key=\{composeKey\}/, 'the composer is remounted per open');
assert.doesNotMatch(cal, /<Modal\b|<TextInput\b|DateTimePicker/, 'the screen no longer draws the sheet itself');
assert.match(composer, /<Modal visible=\{visible\}/, 'the composer owns its Modal');
assert.match(composer, /\{picker\.element\}\s*<\/>/, 'the date-picker element stays outside the Modal');
assert.ok(cal.split('\n').length < 450, 'group-calendar stays well under its old 583 lines');

// ── 2. invites SectionList ──
const inv = read('app/group-invites.tsx');
assert.match(inv, /<SectionList<Row, Section>/);
assert.match(inv, /stickySectionHeadersEnabled=\{false\}/, 'iOS would otherwise pin the section titles');
assert.doesNotMatch(inv, /<ScrollView\b/);
assert.doesNotMatch(inv, /\{(results|waiting|unanswered)\.map\(/, 'no row list is laid out in full');

// ── 3. admin join requests ──
const admin = read('app/group-admin.tsx');
const settle = admin.slice(admin.indexOf('const settleReq'), admin.indexOf('const approveReq'));
assert.ok(settle.length > 0, 'settleReq exists');
assert.ok(settle.indexOf('await approveJoinRequest') < settle.indexOf('setJoinReqs('),
  'the row is removed only after the server accepted');
// Round 8: the lock also covers an open Reject confirmation (`asking`).
assert.match(admin, /const reqLocked = !!acting \|\| !!asking;/);
assert.match(admin, /accessibilityState=\{\{ busy: approving, disabled: reqLocked \}\}/);

// ── 4. scrims ──
for (const f of ['app/group-calendar.tsx', 'app/group-members.tsx', 'components/groups/GroupEventComposer.tsx', 'components/groups/communityStyles.ts']) {
  assert.doesNotMatch(read(f), /backgroundColor: 'rgba\(0,0,0,0\.5/, `${f}: modal scrim uses colors.scrim`);
}

console.log('groupScreensRound7 selftest: ok');
