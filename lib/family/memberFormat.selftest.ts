// lib/family/memberFormat.selftest.ts — run: npx tsx lib/family/memberFormat.selftest.ts
import assert from 'node:assert/strict';
import { AVATAR_COLORS, AVATAR_INK, colorFor, ago } from './memberFormat';

// colorFor: stable per id, always one of the palette.
assert.equal(colorFor('abc'), colorFor('abc'));
for (const id of ['1', '42', 'user-7', 'ü😀']) assert.ok(AVATAR_COLORS.includes(colorFor(id)));
assert.equal(colorFor(''), AVATAR_COLORS[0]);

// ago: buckets, rounding, and the future reads as now.
const now = 1_000_000_000_000;
assert.equal(ago(now, now), 'just now');
assert.equal(ago(now + 60_000, now), 'just now');
assert.equal(ago(now - 44_000, now), 'just now');
assert.equal(ago(now - 46_000, now), '1m ago');
assert.equal(ago(now - 5 * 60_000, now), '5m ago');
assert.equal(ago(now - 3 * 3600_000, now), '3h ago');
assert.equal(ago(now - 2 * 86400_000, now), '2d ago');

// Ink is defined for both schemes and differs between them.
assert.notEqual(AVATAR_INK.dark, AVATAR_INK.light);

console.log('memberFormat selftest: ok');
