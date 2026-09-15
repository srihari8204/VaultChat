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
  // Accepts the legacy `__c<i>` and the generation-tagged `__g<gen>c<i>` form.
  // The generation is what makes a write atomic - see chunkedKV.set.
  const chunkCount = [...backing.raw.keys()]
    .filter((k) => /^big__(c\d+|g\d+c\d+)$/.test(k)).length;
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

  // ── THE TORN WRITE ────────────────────────────────────────────────────────
  //
  // The bug this guards: set() used to delete the old chunks FIRST, then write
  // the new parts, then the head. A process death in that window (Android
  // killing a backgrounded app during the OPK top-up) left a head naming parts
  // that were gone. get() reported that as "absent", and for the identity blob
  // absent means createIdentity() - so the app minted a NEW keypair and
  // published it: every peer session dead, every peer warned of a key change,
  // all history undecryptable, silently.
  //
  // Simulated by killing the store partway through a set(). The old value must
  // survive intact, because nothing the new write touches is named by the head
  // that is still live.
  {
    const tornBacking = cappedStore(2000);
    const torn = tornBacking.kv;
    const tkv = chunkedKV(torn, 1800);
    const v1 = 'A'.repeat(5000);
    await tkv.set('vc_e2ee_identity', v1);

    let writes = 0;
    const realSet = torn.set.bind(torn);
    (torn as any).set = async (k: string, v: string): Promise<void> => {
      // Die after the first new part, BEFORE the head is replaced.
      if (++writes > 1) throw new Error('process died');
      return realSet(k, v);
    };
    let died = false;
    try { await tkv.set('vc_e2ee_identity', 'B'.repeat(5000)); } catch { died = true; }
    (torn as any).set = realSet;

    check('the interrupted write actually failed', died);
    // THE PROPERTY. Not null, not a mixture - the previous value, whole.
    let after: string | null = null;
    let threw = false;
    try { after = await tkv.get('vc_e2ee_identity'); } catch { threw = true; }
    check('a torn write does not report the identity as ABSENT', !(after === null && !threw));
    check('a torn write leaves the PREVIOUS identity readable and intact', after === v1);
  }

  // A backup reader and the live session use different wrappers of one store.
  {
    const backing = cappedStore(2000);
    const reader = chunkedKV(backing.kv, 1800);
    const writer = chunkedKV(backing.kv, 1800);
    await writer.set('shared', 'A'.repeat(5000));
    const originalGet = backing.kv.get;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const started = new Promise<void>(r => { entered = r; });
    backing.kv.get = async key => {
      if (key === 'shared__g0c0') { entered(); await gate; }
      return originalGet(key);
    };
    const reading = reader.get('shared');
    await started;
    const writing = writer.set('shared', 'B'.repeat(5000));
    await writer.set('independent', 'other'); // unrelated keys still progress
    release();
    const result = await reading;
    await writing;
    check('a read survives a concurrent overwrite through another wrapper', result === 'A'.repeat(5000));
    check('the replacement remains whole', await reader.get('shared') === 'B'.repeat(5000));
    await Promise.all([reader.set('shared', 'C'.repeat(5000)), writer.set('shared', 'D'.repeat(5000))]);
    check('concurrent writers do not mix generations', await reader.get('shared') === 'D'.repeat(5000));
  }

  console.log('────────────────────────────────────────');
  if (failures === 0) { console.log('ALL STORAGE TESTS PASSED ✓\n'); process.exit(0); }
  else { console.log(`${failures} STORAGE TEST(S) FAILED ✗\n`); process.exit(1); }
})().catch((e) => { console.error('UNCAUGHT', e); process.exit(1); });
