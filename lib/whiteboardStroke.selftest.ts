import assert from 'node:assert/strict';
import { commitWhiteboardPath } from './whiteboardStroke';

const points = [{ x: 1, y: 2 }, { x: 3, y: 4 }];

assert.equal(commitWhiteboardPath([{ x: 1, y: 2 }], 'pen', '#111827', 4), null);
assert.deepEqual(commitWhiteboardPath(points, 'pen', '#FF3C6E', 8), {
  points,
  color: '#FF3C6E',
  width: 8,
});
assert.deepEqual(commitWhiteboardPath(points, 'eraser', '#FF3C6E', 8), {
  points,
  color: '#FFFFFF',
  width: 24,
});

console.log('whiteboard.selftest: 3 assertions passed');
