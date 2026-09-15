import assert from 'node:assert/strict';
import {
  decodeCursorBatch,
  decodeCursorSync,
  encodeCursorBatch,
  encodeCursorSync,
} from './codec';

const sync = encodeCursorSync({
  cursors: [{ chat_id: 'c1', kind: 3, position: '9007199254740993', updated_at_ms: '42' }],
  mutation_continuation: '2026-09-15T00:00:00Z|7',
});
const decodedSync = decodeCursorSync(sync);
assert.equal(decodedSync.ok, true);
assert.equal(decodedSync.value?.cursors?.[0].position, '9007199254740993');
assert.equal(decodedSync.value?.mutation_continuation, '2026-09-15T00:00:00Z|7');

const batch = encodeCursorBatch({
  cursors: [{ chat_id: 'c1', kind: 3, position: '8' }],
  more: true,
  mutation_continuation: '2026-09-15T00:00:01Z|8',
});
const decodedBatch = decodeCursorBatch(batch);
assert.equal(decodedBatch.ok, true);
assert.equal(decodedBatch.value?.more, true);
assert.equal(decodedBatch.value?.mutation_continuation, '2026-09-15T00:00:01Z|8');

// A pre-extension peer sends no field 2/4; proto3 defaults preserve its shape.
assert.equal(decodeCursorSync(Uint8Array.of(10, 0)).value?.mutation_continuation, '');
assert.equal(decodeCursorBatch(Uint8Array.of(10, 0)).value?.mutation_continuation, '');

// Unknown legal fields remain inert rather than enabling a capability.
const unknown = Uint8Array.of(...batch, 0x2d, 1, 2, 3, 4);
assert.equal(decodeCursorBatch(unknown).ok, true);
assert.equal(decodeCursorBatch(unknown).value?.unknown?.length, 1);

console.log('PASS: CC-Wire cursor mutation continuation TypeScript codec');
