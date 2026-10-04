// lib/tintColor.selftest.ts — run: npx tsx lib/tintColor.selftest.ts
import assert from 'node:assert/strict';
import { tint } from './tintColor';
import { AuroraDark, AuroraLight } from '../constants/theme';

assert.equal(tint('#1552E0', 0.1), 'rgba(21, 82, 224, 0.1)');
assert.equal(tint('#fff', 0.5), 'rgba(255, 255, 255, 0.5)');
assert.equal(tint('rgba(255,255,255,0.96)', 0.2), 'rgba(255, 255, 255, 0.2)');
assert.equal(tint('rgb(1, 2, 3)', 1), 'rgba(1, 2, 3, 1)');
assert.equal(tint('#EF4444', 2), 'rgba(239, 68, 68, 1)', 'alpha is clamped');
assert.equal(tint('red', 0.3), 'red', 'named colours pass through');
// Every palette role this is used on must parse in both themes.
for (const p of [AuroraDark, AuroraLight]) {
  for (const k of ['primary', 'danger', 'success', 'text', 'textDim'] as const) {
    assert.match(tint(p[k], 0.1), /^rgba\(\d+, \d+, \d+, 0\.1\)$/, `${k} parses`);
  }
}
console.log('tintColor selftest: ok');
