// lib/missingRoute.selftest.ts — run: npx tsx lib/missingRoute.selftest.ts
import assert from 'node:assert/strict';
import { isMissingRoute } from './missingRoute';

assert.equal(isMissingRoute({ status: 404 }), true, 'plain-text 404: route not deployed');
assert.equal(isMissingRoute({ status: 405, body: undefined }), true, '405 on an existing path');
assert.equal(isMissingRoute({ status: 404, body: { error: 'Channel not found' } }), false, 'a real 404 is not a missing route');
assert.equal(isMissingRoute({ status: 409, body: { error: 'The admin cannot leave' } }), false);
assert.equal(isMissingRoute({ status: 500 }), false);
assert.equal(isMissingRoute(new Error('Network request failed')), false, 'no status: network, not a missing route');
assert.equal(isMissingRoute(null), false);
console.log('missingRoute selftest: ok');
