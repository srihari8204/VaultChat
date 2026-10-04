// lib/statusAudienceBase.selftest.ts — run: npx tsx lib/statusAudienceBase.selftest.ts
//
// Today's server ignores `?base=1` and answers `{ viewerIds }`: that must read
// as "not supported" (null), never as "nobody to list". A deployed server's
// `people` list is used, cleaned, and merged with the direct-chat peers.

import assert from 'node:assert/strict';
import { parseAudienceBase, pickerPeople } from './statusAudienceBase';

// Not supported: anything without a `people` array.
assert.equal(parseAudienceBase({ viewerIds: ['a', 'b'] }), null, "today's server reply");
assert.equal(parseAudienceBase(null), null);
assert.equal(parseAudienceBase(undefined), null);
assert.equal(parseAudienceBase({ people: 'x' }), null);

// Supported, possibly empty.
assert.deepEqual(parseAudienceBase({ people: [] }), []);
assert.deepEqual(parseAudienceBase({ people: [
  { id: 'g1', name: 'Group Pal', photoURL: null },
  { id: 'g1', name: 'dup', photoURL: null },          // once
  { id: '', name: 'no id' },                           // dropped
  { name: 'missing id' },                              // dropped
  null,                                                // dropped
  { id: 'g2', name: '  ', photoURL: '' },              // fallback name, no photo
  { id: 'g3', name: 'Pic', photoURL: 'att/123' },
] }), [
  { id: 'g1', name: 'Group Pal', photoURL: null },
  { id: 'g2', name: 'crazzychat user', photoURL: null },
  { id: 'g3', name: 'Pic', photoURL: 'att/123' },
]);

const direct = [
  { id: 'd1', name: 'Direct One', photoURL: null },
  { id: 'g1', name: 'Group Pal (direct)', photoURL: 'p' },
];
// Without the server's set: the direct peers as they were.
assert.deepEqual(pickerPeople(null, direct), direct);
// With it: the server's people first, then direct peers it did not name, each once.
assert.deepEqual(pickerPeople([{ id: 'g1', name: 'Group Pal', photoURL: null }, { id: 'g2', name: 'G2', photoURL: null }], direct).map((p) => p.id),
  ['g1', 'g2', 'd1']);
assert.deepEqual(pickerPeople([], direct), direct, 'an empty server set still lists the direct peers');

console.log('statusAudienceBase.selftest: all checks passed');
