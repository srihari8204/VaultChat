// lib/golive/hostPasscodeMemo.selftest.ts — npx tsx lib/golive/hostPasscodeMemo.selftest.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { forgetHostPasscode, hostPasscodeFor, rememberHostPasscode } from './hostPasscodeMemo';

rememberHostPasscode('b1', '4321');
assert.equal(hostPasscodeFor('b1'), '4321', '1. a remembered passcode is returned for its broadcast');
assert.equal(hostPasscodeFor('b2'), '', '2. another broadcast gets nothing');
rememberHostPasscode('b1', '');
assert.equal(hostPasscodeFor('b1'), '', '3. an empty passcode clears the entry');
rememberHostPasscode('b3', 'x');
forgetHostPasscode('b3');
assert.equal(hostPasscodeFor('b3'), '', '4. forget removes it');

// 5. The secret no longer rides the route: live.tsx must not pass `pc` as a
// param, and live-view.tsx must not read it from useLocalSearchParams.
const ROOT = join(__dirname, '..', '..');
const live = readFileSync(join(ROOT, 'app/live.tsx'), 'utf8');
const view = readFileSync(join(ROOT, 'app/live-view.tsx'), 'utf8');
assert.ok(!/^\s*pc,\s*$/m.test(live), '5. live.tsx does not put the passcode in route params');
assert.ok(!/useLocalSearchParams<\{[^}]*\bpc\?/.test(view), '5a. live-view.tsx does not read a pc param');
console.log('hostPasscodeMemo.selftest: 6 assertions passed');
