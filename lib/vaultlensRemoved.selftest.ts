// lib/vaultlensRemoved.selftest.ts — VaultLens stays gone.
//
// A deletion is only finished if it cannot quietly come back. VaultLens had a
// screen, a client store, a Go route module, a Node worker, a BullMQ queue, a
// ModelsLab client and two tables; a later merge, a revert, or a copied-forward
// config block could reintroduce any one of them without anyone noticing,
// because nothing would fail.
//
// So this asserts the ABSENCE, the way the rest of the suite asserts presence.
// It reads the repository rather than importing anything — there is nothing
// left to import, which is the point.
//
// Deliberately NOT a grep for the word "vaultlens": the migrations that create
// and drop the tables must keep naming it, and so must the comments explaining
// why the feature is gone. Erasing the word would erase the history. What is
// checked is that no RUNNABLE VaultLens artifact exists.

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

console.log('VaultLens removal — files that must not exist:');
const goneFiles = [
  'app/vaultlens.tsx',
  'app/vaultlens-result.tsx',
  'lib/vaultlens/api.ts',
  'lib/vaultlens/store.ts',
  'lib/vaultlens/strings.ts',
  'components/vaultlens/Shimmer.tsx',
  'vaultchat-backend-go/internal/routes/vaultlens.go',
  'vaultchat-backend-go/internal/routes/vaultlens_catalog.json',
  'vaultchat-backend/routes/vaultlens.js',
  'vaultchat-backend/workers/vaultlens.js',
  'vaultchat-backend/lib/vaultlensQueue.js',
  'vaultchat-backend/lib/modelslab.js',
  'vaultchat-backend/vaultlens-catalog.json',
  'vaultchat-backend/vaultlens-gen-previews.js',
];
for (const f of goneFiles) check(`absent: ${f}`, !existsSync(join(ROOT, f)));

console.log('\nno runtime registration:');
const mainGo = readFileSync(join(ROOT, 'vaultchat-backend-go/cmd/api/main.go'), 'utf8');
check('go-api does not register VaultLens routes', !/RegisterVaultlens/.test(mainGo));

const serverJs = readFileSync(join(ROOT, 'vaultchat-backend/server.js'), 'utf8');
check('node server does not mount /vaultlens', !/app\.use\(['"]\/vaultlens/.test(serverJs));
check('node server has no VaultLens QueueEvents listener', !/vaultlensQueue/.test(serverJs));

console.log('\nno queue / dependency:');
const backendPkg = JSON.parse(readFileSync(join(ROOT, 'vaultchat-backend/package.json'), 'utf8'));
const allDeps = { ...(backendPkg.dependencies ?? {}), ...(backendPkg.devDependencies ?? {}) };
// bullmq had exactly two consumers, both VaultLens. ioredis is NOT checked —
// redis.js, server.js and workers/fanout.js still use it.
check('bullmq is not a dependency', !('bullmq' in allDeps));

console.log('\nno docker service:');
const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
// The service KEY, not the word — a comment explaining the removal is fine.
check('no vaultlens-worker service', !/^\s{2}vaultlens-worker:/m.test(compose));
check('no MODELSLAB_API_KEY wiring', !/^\s+MODELSLAB_API_KEY:/m.test(compose));
check('no VAULTLENS_CONCURRENCY wiring', !/^\s+VAULTLENS_CONCURRENCY:/m.test(compose));

console.log('\nmigration history is intact, and the drop exists:');
check('059 (create) still present — history is immutable',
  existsSync(join(ROOT, 'vaultchat-backend/migrations/059_vaultlens.sql')));
check('098 (drop) present',
  existsSync(join(ROOT, 'vaultchat-backend/migrations/098_drop_vaultlens.sql')));
const drop = readFileSync(join(ROOT, 'vaultchat-backend/migrations/098_drop_vaultlens.sql'), 'utf8');
check('098 drops vaultlens_generation', /DROP TABLE IF EXISTS vaultlens_generation/.test(drop));
check('098 drops vaultlens_face', /DROP TABLE IF EXISTS vaultlens_face/.test(drop));
// The one thing that would make this a data-loss bug rather than a cleanup.
check('098 drops NOTHING else', (drop.match(/DROP TABLE/g) ?? []).length === 2);

console.log(failures === 0
  ? '\nVAULTLENS IS GONE ✓'
  : `\n${failures} CHECK(S) FAILED ✗`);
process.exit(failures === 0 ? 0 : 1);
