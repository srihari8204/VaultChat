// lib/serverOrigin.selftest.ts — run: npx tsx lib/serverOrigin.selftest.ts
import assert from 'node:assert/strict';
import { isOwnServerUrl } from './serverOrigin';
import { SERVER_URL } from '../constants/server';

const S = 'https://api.example.com';
assert.equal(isOwnServerUrl('https://api.example.com/uploads/abc', S), true);
assert.equal(isOwnServerUrl('https://api.example.com', S), true);
assert.equal(isOwnServerUrl('https://api.example.com?x=1', S), true);
assert.equal(isOwnServerUrl('HTTPS://API.EXAMPLE.COM/uploads/a', S), true, 'scheme/host are case-insensitive');
assert.equal(isOwnServerUrl('https://api.example.com/uploads/a', S + '/'), true, 'trailing slash on the base');

assert.equal(isOwnServerUrl('https://api.example.com.evil.net/x', S), false, 'suffix host');
assert.equal(isOwnServerUrl('https://api.example.com@evil.net/x', S), false, 'userinfo trick');
assert.equal(isOwnServerUrl('https://api.example.com:8443/x', S), false, 'other port');
assert.equal(isOwnServerUrl('https://evil.net/?u=https://api.example.com/', S), false);
assert.equal(isOwnServerUrl('http://api.example.com/x', S), false, 'downgraded scheme');
assert.equal(isOwnServerUrl('file:///data/x.jpg', S), false);
assert.equal(isOwnServerUrl('', S), false);
assert.equal(isOwnServerUrl('https://api.example.com/x', ''), false, 'no server configured');

// The default argument is the real SERVER_URL.
assert.equal(isOwnServerUrl(`${SERVER_URL}/uploads/1`), true);

console.log('serverOrigin selftest: ok');
