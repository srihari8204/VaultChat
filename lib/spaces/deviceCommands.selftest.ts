// Run: npx tsx lib/spaces/deviceCommands.selftest.ts
import assert from 'node:assert/strict';
import {
  planCommand, openCommands, parseBindings, withBinding, withoutBinding, RING_MAX_AGE_MS,
} from './deviceCommands';
import type { DeviceCommand } from './api';

const now = Date.parse('2026-10-04T12:00:00Z');
const cmd = (id: number, action: string, extra: Partial<DeviceCommand> = {}): DeviceCommand => ({
  id, action, payload: null, result: 'issued',
  issuedAt: new Date(now - 60_000).toISOString(), deliveredAt: null, executedAt: null, ...extra,
});

// What the phone does
assert.deepEqual(planCommand(cmd(1, 'ring'), now), { kind: 'ring' });
assert.deepEqual(planCommand(cmd(1, 'ring', { issuedAt: new Date(now - RING_MAX_AGE_MS - 1).toISOString() }), now),
  { kind: 'refuse', result: 'cancelled' }, 'a stale ring is cancelled, not played hours later');
assert.deepEqual(planCommand(cmd(2, 'message', { payload: '  Please call 555  ' }), now), { kind: 'message', text: 'Please call 555' });
assert.deepEqual(planCommand(cmd(2, 'message', { payload: '   ' }), now), { kind: 'refuse', result: 'failed' });
const long = planCommand(cmd(2, 'message', { payload: 'x'.repeat(500) }), now);
assert.equal(long.kind === 'message' ? long.text.length : -1, 300);
for (const a of ['lock', 'wipe', 'photo', 'locate', 'unknown']) {
  assert.deepEqual(planCommand(cmd(3, a), now), { kind: 'refuse', result: 'failed' },
    `${a} is reported as not done, never silently left waiting or pretended`);
}

// Which commands are still open
const list = [
  cmd(10, 'ring', { issuedAt: new Date(now - 1000).toISOString() }),
  cmd(11, 'message', { issuedAt: new Date(now - 5000).toISOString(), result: 'delivered' }),
  cmd(12, 'lock', { result: 'executed' }),
  cmd(13, 'ring', { result: 'failed' }),
  cmd(14, 'ring', { result: 'cancelled' }),
];
assert.deepEqual(openCommands(list, new Set()).map((c) => c.id), [11, 10], 'oldest first, settled ones skipped');
assert.deepEqual(openCommands(list, new Set([11])).map((c) => c.id), [10], 'handled this session are skipped');

// Bindings read back from disk are data
const b = { spaceId: 's', deviceId: 'd', ownerId: 'u', label: 'Phone' };
assert.deepEqual(parseBindings(JSON.stringify([b, { spaceId: 's' }, null, 7])), [b]);
assert.deepEqual(parseBindings('not json'), []);
assert.deepEqual(parseBindings(null), []);
assert.deepEqual(parseBindings('{"a":1}'), []);
assert.deepEqual(withBinding([b], { ...b, label: 'Renamed' }), [{ ...b, label: 'Renamed' }], 'rebinding replaces, never duplicates');
assert.deepEqual(withoutBinding([b, { ...b, deviceId: 'e' }], b).map((x) => x.deviceId), ['e']);

console.log('spaces/deviceCommands self-check OK');
