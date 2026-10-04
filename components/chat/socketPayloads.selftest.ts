// Run: npx tsx components/chat/socketPayloads.selftest.ts
//
// The chat screen's live-location and pin socket payloads are network input:
// typed, narrowed, and the legacy plaintext coordinates range-checked before
// they reach the banner and the map pin (components/chat/useChatSocket.ts).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { legacyLivePosition, pinnedIdOf } from './socketPayloads';

// Legacy live location
assert.deepEqual(legacyLivePosition({ userId: 'u', latitude: 12.97, longitude: 77.59, address: 'MG Road' }),
  { latitude: 12.97, longitude: 77.59, address: 'MG Road' });
assert.deepEqual(legacyLivePosition({ latitude: -90, longitude: 180 }), { latitude: -90, longitude: 180, address: undefined },
  'the range is inclusive');
assert.equal(legacyLivePosition({ latitude: 0, longitude: 0, address: '' })?.address, undefined, 'an empty address is no address');
assert.equal(legacyLivePosition({ latitude: 0, longitude: 0, address: { x: 1 } })?.address, undefined, 'a non-string address is dropped');
for (const [lat, lng] of [[91, 0], [0, 181], [-90.5, 10], [NaN, 0], [0, Infinity], ['12.9', '77.5'], [null, 1], [{}, []]] as const) {
  assert.equal(legacyLivePosition({ latitude: lat, longitude: lng }), null, `rejects ${String(lat)},${String(lng)}`);
}

// Pins
assert.equal(pinnedIdOf({ messageId: '1234567890123' }), '1234567890123', 'the server\'s string id is kept');
assert.equal(pinnedIdOf({ messageId: 42 }), '42', 'a numeric id is stored as PinnedBar compares it (String(m.id))');
assert.equal(pinnedIdOf({ messageId: null }), null, 'unpinned');
assert.equal(pinnedIdOf({ messageId: '' }), null);
assert.equal(pinnedIdOf({}), null);
assert.equal(pinnedIdOf(null), null);
assert.equal(pinnedIdOf({ messageId: NaN }), null);

// Wiring: the hook takes no `any` payloads and uses the checks.
const hook = readFileSync(join(__dirname, 'useChatSocket.ts'), 'utf8').replace(/\/\/.*$/gm, '');
assert.doesNotMatch(hook, /\(e: any\)/, 'no untyped socket payloads in the hook');
assert.match(hook, /const onLiveLocation = \(e: LiveLocationEvent\)/);
assert.match(hook, /const onLiveLocationStop = \(e: LiveLocationStopEvent\)/);
assert.match(hook, /const pos = legacyLivePosition\(e\);\s*if \(pos\) setLiveLoc\(\{ userId: e\.userId, \.\.\.pos \}\);/,
  'the legacy plaintext path is range-checked');
assert.match(hook, /const onPinned = \(e: PinnedEvent\) => setPinnedId\(pinnedIdOf\(e\)\);/);

console.log('socketPayloads selftest: OK');
