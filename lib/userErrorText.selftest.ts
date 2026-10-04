// lib/userErrorText.selftest.ts — run: npx tsx lib/userErrorText.selftest.ts
import assert from 'node:assert/strict';
import { userErrorText, isConnectionError } from './userErrorText';

const apiErr = (status: number, message: string) => Object.assign(new Error(message), { status });

assert.equal(userErrorText(apiErr(409, 'That changed while you were working.'), 'F'), 'That changed while you were working.', 'lib/api copy passes through');
assert.equal(userErrorText(apiErr(500, ''), 'F'), 'F', 'an empty server message falls back');
assert.equal(userErrorText(new TypeError('Network request failed'), 'F'), 'Check your connection and try again.');
assert.equal(userErrorText(Object.assign(new Error('x'), { name: 'AbortError' }), 'F'), 'Check your connection and try again.');
assert.equal(userErrorText(new TypeError("undefined is not an object (evaluating 'a.b')"), 'F'), 'F', 'no JS internals');
assert.equal(userErrorText(new Error('aes/gcm: invalid ghash tag'), 'F'), 'F', 'no crypto internals');
assert.equal(userErrorText(null, 'F'), 'F');
assert.equal(userErrorText('boom', 'F'), 'F');
assert.equal(isConnectionError(apiErr(504, 'Gateway timed out')), false, 'an HTTP answer is not a connection error');
console.log('userErrorText selftest: all passed');
