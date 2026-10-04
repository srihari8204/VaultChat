// lib/spaces/errors.selftest.ts — typed reads of a caught error.
import assert from 'node:assert/strict';
import { errCode, errMsg, errStatus } from './errors';

const apiErr = Object.assign(new Error('Stop not found'), { status: 409, body: { code: 'unknown_stop' } });
assert.equal(errMsg(apiErr), 'Stop not found');
assert.equal(errStatus(apiErr), 409);
assert.equal(errCode(apiErr), 'unknown_stop');
assert.equal(errMsg(new Error('')), undefined, 'an empty message falls back to the caller\'s copy');
assert.equal(errMsg('boom'), undefined, 'a thrown string has no message field');
assert.equal(errMsg(null), undefined);
assert.equal(errMsg({ message: 42 }), undefined);
assert.equal(errStatus({ statusCode: '404' }), 404);
assert.equal(errStatus(undefined), 0);
assert.equal(errStatus({ status: 'x' }), 0);
assert.equal(errCode({ body: 'text' }), undefined);
assert.equal(errCode(new Error('x')), undefined);
console.log('spaces/errors selftest: ok');
