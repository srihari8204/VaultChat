// lib/localCache.sealed.selftest.ts — run: npx tsx lib/localCache.sealed.selftest.ts
//
// Executes the REAL lib/localCache.ts against an in-memory AsyncStorage and the
// REAL cacheCrypto sealing (only its SecureStore/flags imports are stubbed), so
// "never plaintext" is checked on the bytes that would reach the disk.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { URL } from 'node:url';
import ts from 'typescript';
import * as vaultKeys from '../services/security/vaultKeys';
import * as nobleUtils from '@noble/hashes/utils.js';

const compile = (file: string) => ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;

function load() {
  const disk = new Map<string, string>();
  const AsyncStorage = { default: {
    getItem: async (k: string) => disk.get(k) ?? null,
    setItem: async (k: string, v: string) => { disk.set(k, v); },
    removeItem: async (k: string) => { disk.delete(k); },
  } };
  const crypto: any = {};
  vm.runInNewContext(compile('./cacheCrypto.ts'), {
    exports: crypto,
    require: (name: string) => ({
      'expo-secure-store': {},
      '@noble/hashes/utils.js': nobleUtils,
      '../services/security/vaultKeys': vaultKeys,
      '../constants/flags': { VAULT_CACHE_ENCRYPTED: true },
    } as Record<string, any>)[name] ?? assert.fail('unexpected import ' + name),
  });
  const cache: any = {};
  vm.runInNewContext(compile('./localCache.ts'), {
    exports: cache,
    require: (name: string) => ({
      react: { useCallback: () => {}, useEffect: () => {}, useRef: () => ({}), useState: () => [] },
      '@react-native-async-storage/async-storage': AsyncStorage,
      './cacheCrypto': crypto,
    } as Record<string, any>)[name] ?? assert.fail('unexpected import ' + name),
  });
  return { cache, crypto, disk };
}

let n = 0;
const ok = async (label: string, fn: () => Promise<void>) => { await fn(); n++; console.log('  ok  ' + label); };
const SECRET = [{ targetId: 'u1', name: 'Alice', ip: '203.0.113.7' }];

(async () => {
  await ok('with no cache key loaded nothing is written, and an older entry is removed', async () => {
    const { cache, disk } = load();
    disk.set('vc_cache_ghost-mode', 'stale');
    await cache.writeSealedCache('ghost-mode', SECRET);
    assert.equal(disk.has('vc_cache_ghost-mode'), false);
    assert.equal(await cache.readSealedCache('ghost-mode'), null);
  });

  await ok('with the key loaded the stored bytes are sealed, and read back intact', async () => {
    const { cache, crypto, disk } = load();
    crypto.setCacheKey(nobleUtils.randomBytes(32));
    await cache.writeSealedCache('sessions', SECRET);
    const raw = disk.get('vc_cache_sessions')!;
    assert.ok(raw.startsWith('enc:v1:'));
    assert.ok(!raw.includes('203.0.113.7') && !raw.includes('Alice'), 'plaintext reached the disk');
    // JSON round-trip: the value was parsed in the vm's realm (other prototypes).
    assert.equal(JSON.stringify(await cache.readSealedCache('sessions')), JSON.stringify(SECRET));
  });

  await ok('a plaintext entry from an older build is deleted, not returned', async () => {
    const { cache, crypto, disk } = load();
    crypto.setCacheKey(nobleUtils.randomBytes(32));
    disk.set('vc_cache_sessions', JSON.stringify(SECRET));
    assert.equal(await cache.readSealedCache('sessions'), null);
    assert.equal(disk.has('vc_cache_sessions'), false);
  });

  await ok('a sealed entry is not returned while locked or under another key', async () => {
    const { cache, crypto } = load();
    crypto.setCacheKey(nobleUtils.randomBytes(32));
    await cache.writeSealedCache('ghost-mode', SECRET);
    crypto.clearCacheKey();
    assert.equal(await cache.readSealedCache('ghost-mode'), null);
    crypto.setCacheKey(nobleUtils.randomBytes(32));
    assert.equal(await cache.readSealedCache('ghost-mode'), null);
  });

  console.log(`\nlocalCache.sealed.selftest: ${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
