/**
 * Node self-test for messageStore.ts (plaintext cache + keyed lock).
 * Run via esbuild bundle — dev-only.
 */
import { createMessageStore, createKeyedLock } from './messageStore';
import type { KVStore } from './e2eeSession';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log((cond ? '  ✓ PASS' : '  ✗ FAIL') + '  ' + name);
  if (!cond) failures++;
}
function makeKV(): KVStore {
  const m = new Map<string, string>();
  return {
    async get(k) { return m.has(k) ? (m.get(k) as string) : null; },
    async set(k, v) { m.set(k, v); },
    async del(k) { m.delete(k); },
  };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\nVaultChat E2EE message-store self-test\n──────────────────────────────────────');

  // Plaintext cache
  const store = createMessageStore(makeKV());
  check('missing message → null', (await store.get('chatA', 1)) === null);
  await store.put('chatA', 1, 'hello world');
  check('put/get round-trips', (await store.get('chatA', 1)) === 'hello world');
  check('keys are per (chat,id)', (await store.get('chatA', 2)) === null);
  await store.put('chatB', 1, 'other chat');
  check('different chat, same id, isolated', (await store.get('chatA', 1)) === 'hello world' && (await store.get('chatB', 1)) === 'other chat');
  await store.del('chatA', 1);
  check('delete removes only the addressed plaintext',
    (await store.get('chatA', 1)) === null && (await store.get('chatB', 1)) === 'other chat');

  // Keyed lock: same key serializes
  console.log('Keyed lock:');
  const withLock = createKeyedLock();
  const order: string[] = [];
  async function critical(tag: string, delay: number) {
    order.push(`${tag}:start`);
    await sleep(delay);
    order.push(`${tag}:end`);
  }
  // Two ops on the SAME key launched together must NOT interleave.
  const p1 = withLock('peer1', () => critical('A', 30));
  const p2 = withLock('peer1', () => critical('B', 5));
  await Promise.all([p1, p2]);
  check('same-key ops run serially (no interleave)',
    JSON.stringify(order) === JSON.stringify(['A:start', 'A:end', 'B:start', 'B:end']));

  // Different keys may overlap
  const order2: string[] = [];
  async function crit2(tag: string, delay: number) { order2.push(`${tag}:start`); await sleep(delay); order2.push(`${tag}:end`); }
  const q1 = withLock('peerX', () => crit2('X', 30));
  const q2 = withLock('peerY', () => crit2('Y', 5));
  await Promise.all([q1, q2]);
  check('different-key ops may overlap', order2[0] === 'X:start' && order2[1] === 'Y:start');

  // A throwing op must not break the chain for that key
  const after: string[] = [];
  const r1 = withLock('peerZ', async () => { throw new Error('boom'); }).catch(() => after.push('caught'));
  const r2 = withLock('peerZ', async () => { after.push('next-ran'); });
  await Promise.all([r1, r2]);
  check('lock survives a rejecting op', after.includes('caught') && after.includes('next-ran'));

  console.log('──────────────────────────────────────');
  if (failures === 0) { console.log('ALL MESSAGE-STORE TESTS PASSED ✓\n'); process.exit(0); }
  else { console.log(`${failures} TEST(S) FAILED ✗\n`); process.exit(1); }
})().catch((e) => { console.error('UNCAUGHT', e); process.exit(1); });
