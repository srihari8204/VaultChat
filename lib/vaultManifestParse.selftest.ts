// Run: npx tsx lib/vaultManifestParse.selftest.ts
import assert from 'node:assert/strict';
import { parseVaultManifest } from './vaultManifestParse';

assert.deepEqual(parseVaultManifest(null), []);
assert.deepEqual(parseVaultManifest(''), []);
assert.deepEqual(parseVaultManifest('[]'), []);
assert.deepEqual(parseVaultManifest('[{"id":"a"}]'), [{ id: 'a' }]);
// Damaged data must throw, never read as an empty vault.
assert.throws(() => parseVaultManifest('{"id":"a"}'));
assert.throws(() => parseVaultManifest('null'));
assert.throws(() => parseVaultManifest('not json'));

console.log('vaultManifestParse selftest passed');
