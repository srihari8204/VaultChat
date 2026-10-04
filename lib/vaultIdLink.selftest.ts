// lib/vaultIdLink.selftest.ts — run: npx tsx lib/vaultIdLink.selftest.ts
import assert from 'node:assert/strict';
import { parseVaultIdPayload as p } from './vaultIdLink';

// what the app produces
assert.equal(p('vaultchat://add/v0a1b2c3d4e5f/Alice%20B'), 'v0a1b2c3d4e5f');
assert.equal(p('crazzychat://add/v0a1b2c3d4e5f'), 'v0a1b2c3d4e5f');
assert.equal(p('https://vaultchat.app/add/v0a1b2c3d4e5f'), 'v0a1b2c3d4e5f');
assert.equal(p('https://vaultchat.app/add/v0a1b2c3d4e5f?x=1'), 'v0a1b2c3d4e5f');
assert.equal(p('@v0a1b2c3d4e5f'), 'v0a1b2c3d4e5f');
assert.equal(p('  v0a1b2c3d4e5f  '), 'v0a1b2c3d4e5f');

// not ours
assert.equal(p('https://evil.example/add/v0a1b2c3d4e5f'), '', 'foreign host with /add/');
assert.equal(p('http://vaultchat.app/add/v0a1b2c3d4e5f'), '', 'plain http');
assert.equal(p('WIFI:S:home;T:WPA;P:secret;;'), '', 'other QR schemes');
assert.equal(p('hello world'), '', 'spaces are not in a VaultID');
assert.equal(p('vaultchat://add/'), '', 'empty id');
assert.equal(p('vaultchat://add/../../x'), '', 'path tricks');
assert.equal(p(''), '');
assert.equal(p('x'.repeat(200)), '', 'too long');

console.log('vaultIdLink selftest: ok');
