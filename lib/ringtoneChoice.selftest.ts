// lib/ringtoneChoice.selftest.ts — the chosen ringtone is the one that rings.
//
//   npx tsx lib/ringtoneChoice.selftest.ts

import assert from 'assert';
import { RINGTONE_PREFS_VERSION, SYSTEM_RINGTONE, migrateRingtone, resolveRingtone } from './ringtoneChoice';

const IDS = ['ring_pulse', 'ring_chime', 'ring_classic'] as const;

// The bug: a bundled pick was ignored whenever the native ringer existed.
assert.deepStrictEqual(resolveRingtone('ring_chime', true, IDS), { kind: 'bundled', id: 'ring_chime' });
assert.deepStrictEqual(resolveRingtone('ring_classic', false, IDS), { kind: 'bundled', id: 'ring_classic' });
// The phone ringtone, where it can be played.
assert.deepStrictEqual(resolveRingtone(SYSTEM_RINGTONE, true, IDS), { kind: 'system' });
// ...and a bundled stand-in where it cannot (iOS, Expo Go).
assert.deepStrictEqual(resolveRingtone(SYSTEM_RINGTONE, false, IDS), { kind: 'bundled', id: 'ring_pulse' });
// Unknown id never means silence.
assert.deepStrictEqual(resolveRingtone('gone', true, IDS), { kind: 'bundled', id: 'ring_pulse' });

// Migration of prefs written before 'system' existed.
assert.strictEqual(migrateRingtone(null, 'ring_pulse'), SYSTEM_RINGTONE);
assert.strictEqual(migrateRingtone({}, 'ring_pulse'), SYSTEM_RINGTONE);
// The old default was written by any settings change while the phone ringtone
// actually rang, so it keeps ringing the phone ringtone.
assert.strictEqual(migrateRingtone({ ringtone: 'ring_pulse' }, 'ring_pulse'), SYSTEM_RINGTONE);
// An explicit old pick of another tone is kept (and now honoured).
assert.strictEqual(migrateRingtone({ ringtone: 'ring_chime' }, 'ring_pulse'), 'ring_chime');
// Current-version prefs are taken as written, including a deliberate Pulse.
assert.strictEqual(migrateRingtone({ ringtone: 'ring_pulse', ringtoneVersion: RINGTONE_PREFS_VERSION }, 'ring_pulse'), 'ring_pulse');
assert.strictEqual(migrateRingtone({ ringtone: SYSTEM_RINGTONE, ringtoneVersion: RINGTONE_PREFS_VERSION }, 'ring_pulse'), SYSTEM_RINGTONE);
assert.strictEqual(migrateRingtone({ ringtone: 42 }, 'ring_pulse'), SYSTEM_RINGTONE);

console.log('ringtoneChoice selftest: all assertions passed');
