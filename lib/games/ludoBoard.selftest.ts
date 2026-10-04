// lib/games/ludoBoard.selftest.ts — run: npx tsx lib/games/ludoBoard.selftest.ts
import assert from 'node:assert/strict';
import { RING, START_OFFSET, HOME_STEP, CENTER_RC, HOME_COORDS, BASE_SPOTS, coord, pid } from './ludoBoard';

let n = 0;
const eq = (a: unknown, b: unknown, what: string) => { assert.deepEqual(a, b, what); n++; };

eq(RING.length, 52, '1a. the ring has 52 cells');
eq(new Set(RING.map(([r, c]) => `${r},${c}`)).size, 52, '1b. ...all distinct');
eq(RING.every(([r, c]) => r >= 0 && r < 15 && c >= 0 && c < 15), true, '1c. ...all on the 15x15 board');
eq(START_OFFSET, [0, 13, 26, 39], '1d. starts are a quarter-turn apart');

for (let seat = 0; seat < 4; seat++) {
  eq(coord(seat, 2, -1), BASE_SPOTS[seat][2], `2a. seat ${seat}: base is its yard spot`);
  eq(coord(seat, 0, 0), RING[START_OFFSET[seat]], `2b. seat ${seat}: step 0 is its start`);
  eq(coord(seat, 0, 51), HOME_COORDS[seat][0], `2c. seat ${seat}: step 51 enters its home column`);
  eq(coord(seat, 0, HOME_STEP), CENTER_RC, `2d. seat ${seat}: home is the centre`);
}
eq(coord(1, 0, 45), RING[(13 + 45) % 52], '2e. the ring wraps for later seats');

// Total by construction: junk off the wire places a token, never crashes.
eq(coord(9, 9, Number.NaN), BASE_SPOTS[0][0], '3a. unknown seat/index/step → seat 0 base');
eq(coord(2, 1, 99), CENTER_RC, '3b. past home is home');
eq(Array.isArray(coord(-1, -1, 53)), true, '3c. negative seat still yields a cell');

eq(pid({ id: 'a', vaultId: 'b', name: '', seat: 0, tokens: [] }), 'a', '4a. id wins');
eq(pid({ vaultId: 'b', name: '', seat: 0, tokens: [] }), 'b', '4b. vaultId fallback');
eq(pid({ name: '', seat: 0, tokens: [] }), '', '4c. never undefined');

console.log(`ludoBoard.selftest: ${n} passed`);
