/**
 * Node self-test for chunkedKV — simulates a size-capped backing store
 * (like expo-secure-store's ~2 KB/item limit). Run via esbuild bundle.
 */
import { chunkedKV } from './e2eeStorage';
import type { KVStore } from './e2eeSession';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log((cond ? '  ✓ PASS' : '  ✗ FAIL') + '  ' + name);
  if (!cond) failures++;
}

// Backing store that REFUSES values larger than `cap` bytes (mimics SecureStore).
function cappedStore(cap: number): { kv: KVStore; size(): number; raw: Map<string, string> } {
  const m = new Map<string, string>();
  return {
    raw: m,
    size: () => m.size,
    kv: {
      async get(k) { return m.has(k) ? (m.get(k) as string) : null; },
      async set(k, v) {
        if (Buffer.byteLength(v, 'utf8') > cap) throw new Error(`value too large for backing store (${Buffer.byteLength(v)} > ${cap})`);
        m.set(k, v);
      },
      async del(k) { m.delete(k); },
    },
  };
}

(async () => {
  console.log('\nVaultChat E2EE chunked-storage self-test\n────────────────────────────────────────');
  const CAP = 2048;
  const backing = cappedStore(CAP);
  const kv = chunkedKV(backing.kv, 1800);

  // Small value passes straight through
  await kv.set('small', 'hello');
  check('small value round-trips', (await kv.get('small')) === 'hello');
  check('small value stored as a single backing item', backing.raw.has('small') && !backing.raw.has('small__c0'));

  // Large value (~10 KB) would exceed the cap if stored whole
  const big = 'a'.repeat(10000);
  let directThrew = false;
  try { await backing.kv.set('raw-big', big); } catch { directThrew = true; }
  check('backing store rejects a raw 10 KB value (cap works)', directThrew);

  await kv.set('big', big);
  check('large value round-trips through chunkedKV', (await kv.get('big')) === big);
  const chunkCount = [...backing.raw.keys()].filter((k) => k.startsWith('big__c')).length;
  check('large value was split into multiple backing items', chunkCount > 1);

  // Overwrite large → small must clean up stale chunks
  await kv.set('big', 'now small');
  check('overwrite large→small round-trips', (await kv.get('big')) === 'now small');
  check('stale chunks cleaned on shrink', [...backing.raw.keys()].filter((k) => k.startsWith('big__c')).length === 0);

  // Delete cleans chunks
  await kv.set('big2', big);
  await kv.del('big2');
  check('delete removes the value', (await kv.get('big2')) === null);
  check('delete removes all chunks', [...backing.raw.keys()].filter((k) => k.startsWith('big2')).length === 0);

  // Missing key
  check('missing key → null', (await kv.get('nope')) === null);

  // Realistic: an identity blob with a 20-key OTPK pool (~5 KB)
  const identityLike = JSON.stringify({ opks: Array.from({ length: 20 }, (_, i) => ({ id: i, priv: 'a'.repeat(64), pub: 'b'.repeat(64) })) });
  await kv.set('vc_e2ee_identity', identityLike);
  check('realistic 5 KB identity blob survives the 2 KB cap', (await kv.get('vc_e2ee_identity')) === identityLike);

  console.log('────────────────────────────────────────');
  if (failures === 0) { console.log('ALL STORAGE TESTS PASSED ✓\n'); process.exit(0); }
  else { console.log(`${failures} STORAGE TEST(S) FAILED ✗\n`); process.exit(1); }
})().catch((e) => { console.error('UNCAUGHT', e); process.exit(1); });
