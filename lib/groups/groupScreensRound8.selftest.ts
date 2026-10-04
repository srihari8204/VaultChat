// lib/groups/groupScreensRound8.selftest.ts — run: npx tsx lib/groups/groupScreensRound8.selftest.ts
//
// Round-8 group screen changes that are structural (the pure logic is in
// opThread.selftest, mediaPageCache.selftest and catalog.ts's self-check), so
// this pins them in the source:
//   1. No group screen shows a raw error message: catches are typed and the
//      copy goes through userErrorText.
//   2. Confirm-then-act rows show the latch: group-invites disables (and dims)
//      the other Waiting rows and latches Turn-down / Withdraw when the
//      confirmation OPENS; group-info shows Remove in flight on the row.
//   3. group-create latches Create with a ref; its group-colour glyphs go
//      through glyphOn; group-join falls back to the primary fill when neither
//      ink is readable on the card's colour; group-members has no hex-suffix tint.
//   4. Notes and tasks screens no longer claim an offline queue, and tasks'
//      refresh banner retries in place with a busy state.
//   5. Ops are tagged only once the session has found the index.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── 1. error copy ──
const SCREENS = [
  'group-admin', 'group-calendar', 'group-create', 'group-info', 'group-insights', 'group-invitations',
  'group-invites', 'group-join', 'group-members', 'group-notes', 'group-privacy', 'group-tasks', 'group-trip',
  'group-calls', 'create-group', 'communities',
].map((n) => `app/${n}.tsx`);
for (const f of SCREENS) {
  const src = read(f);
  assert.doesNotMatch(src, /catch \(e: any\)/, `${f}: typed catch`);
  assert.doesNotMatch(src, /e\?\.message \?\?/, `${f}: no raw e.message as user copy`);
}

// ── 2. latches you can see ──
const inv = read('app/group-invites.tsx');
assert.match(inv, /const queueLocked = acting != null \|\| asking != null;/);
assert.equal((inv.match(/disabled=\{queueLocked\} accessibilityState=\{\{ disabled: queueLocked \}\}/g) ?? []).length, 2,
  'Approve and Decline on a Waiting row are disabled while another row acts');
const decline = inv.slice(inv.indexOf('const decline'), inv.indexOf('const doResend'));
assert.ok(decline.indexOf('actingRef.current = true') < decline.indexOf('Alert.alert('), 'Turn-down latches when its confirm opens');
assert.match(decline, /onDismiss: release/);
const withdraw = inv.slice(inv.indexOf('const doWithdraw'), inv.indexOf('const unanswered'));
assert.ok(withdraw.indexOf('withdrawingRef.current = true') < withdraw.indexOf('Alert.alert('), 'Withdraw latches when its confirm opens');
assert.match(withdraw, /onDismiss: release/);
const info = read('app/group-info.tsx');
assert.match(info, /removing=\{removingId === m\.userId\}/);
assert.match(read('components/groups/GroupInfoSections.tsx'), /accessibilityState=\{\{ busy: removing, disabled: removing \|\| locked \}\}/);

// ── 3. colours and the create latch ──
const create = read('app/group-create.tsx');
assert.match(create, /if \(creatingRef\.current\) return;/);
assert.doesNotMatch(create, /if \(busy\) return/);
assert.equal((create.match(/glyphOn\(/g) ?? []).length, 3, 'preview, type and icon glyphs');
const join = read('app/group-join.tsx');
assert.match(join, /const fill = inkReadable\(accent\) \? accent : colors\.primary;/);
assert.doesNotMatch(join, /backgroundColor: accent \}/, 'buttons fill with `fill`');
assert.doesNotMatch(read('app/group-members.tsx'), /colors\.\w+ \+ '[0-9a-fA-F]{2}'/, 'tint(), not a hex suffix');

// ── 4. notes / tasks ──
for (const f of ['app/group-notes.tsx', 'app/group-tasks.tsx']) {
  assert.doesNotMatch(read(f), /queues a message|just queue a message/, `${f}: no offline-queue claim`);
}
const tasks = read('app/group-tasks.tsx');
assert.match(tasks, /accessibilityState=\{\{ busy: retrying, disabled: retrying \}\} disabled=\{retrying\}\s*onPress=\{retryInPlace\}/);

// ── 5. op tag ──
const op = read('lib/groups/opThread.ts');
assert.match(op, /clientId: Crypto\.randomUUID\(\), \.\.\.opTag\(kind\) \}/, 'sendGroupOp tags only through opTag');

console.log('groupScreensRound8 selftest: ok');
