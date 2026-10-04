// services/security/pinFormat.selftest.ts — run: npx tsx services/security/pinFormat.selftest.ts
//
// PIN length parity: the vault must accept every PIN the app can set.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isPinFormat, PIN_MAX, PIN_MIN } from './pinFormat';

for (let n = PIN_MIN; n <= PIN_MAX; n++) assert.ok(isPinFormat('7'.repeat(n)), `${n} digits accepted`);
assert.equal(isPinFormat('123'), false, 'too short');
assert.equal(isPinFormat('123456789'), false, 'too long');
assert.equal(isPinFormat('12a4'), false, 'digits only');
assert.equal(isPinFormat('١٢٣٤'), false, 'ASCII digits only');
assert.equal(isPinFormat(''), false);

// The setter and the vault gate both use this definition, and backup-pin's
// fixed length lies inside it — the 8-vs-6 mismatch cannot come back silently.
const root = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
assert.match(read('services/security/pinStore.ts'), /isPinFormat\(pin\)/, 'pinStore.setPin validates with isPinFormat');
// The vault PIN gate lives in these files; if it moves out of app/vault.tsx,
// add (or swap in) its new file here.
const VAULT_GATE_FILES = ['app/vault.tsx', 'components/vault/VaultPinGate.tsx'];
assert.match(VAULT_GATE_FILES.map(read).join('\n'), /isPinFormat/, 'the vault gate validates with isPinFormat');
const bp = read('app/backup-pin.tsx');
const m = bp.match(/const NEW_PIN_LENGTH = (\d+);/);
assert.ok(m, 'backup-pin declares NEW_PIN_LENGTH');
assert.ok(isPinFormat('1'.repeat(Number(m![1]))), 'the length backup-pin sets is one the vault accepts');

console.log('pinFormat.selftest: all checks passed');
