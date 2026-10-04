// lib/groups/mediaPageCache.selftest.ts — group-info reads the server media page
// at most once per TTL per chat, and never caches a failure.
import assert from 'node:assert/strict';
import { MEDIA_PAGE_TTL_MS, recentServerMedia } from './mediaPageCache';

type M = { id: number; type: string };
const page: M[] = [{ id: 1, type: 'text' }, { id: 2, type: 'image' }, { id: 3, type: 'video' }];

async function main() {
  let calls = 0;
  const fetchOk = async () => { calls++; return page; };
  const fetchFail = async (): Promise<M[]> => { calls++; throw new Error('offline'); };

  const t0 = 1_000_000;
  assert.deepEqual((await recentServerMedia('a', fetchOk, t0))!.map(m => m.id), [2, 3], 'keeps only media rows');
  assert.equal(calls, 1);
  await recentServerMedia('a', fetchOk, t0 + MEDIA_PAGE_TTL_MS - 1);
  assert.equal(calls, 1, 'a revisit inside the TTL does not refetch');
  await recentServerMedia('a', fetchOk, t0 + MEDIA_PAGE_TTL_MS);
  assert.equal(calls, 2, 'after the TTL it reads again');
  await recentServerMedia('b', fetchOk, t0);
  assert.equal(calls, 3, 'per chat');

  assert.equal(await recentServerMedia('c', fetchFail, t0), null, 'a failure returns null');
  await recentServerMedia('c', fetchOk, t0 + 1);
  assert.equal(calls, 5, 'a failure is not cached');

  // Bounded: 20 chats; the oldest-read is dropped first.
  for (let i = 0; i < 25; i++) await recentServerMedia('x' + i, fetchOk, t0);
  const before = calls;
  await recentServerMedia('x0', fetchOk, t0 + 1);
  assert.equal(calls, before + 1, 'evicted beyond 20 chats');
  await recentServerMedia('x24', fetchOk, t0 + 1);
  assert.equal(calls, before + 1, 'recent chats stay cached');
  console.log('mediaPageCache selftest: ok');
}
void main().catch(e => { console.error(e); process.exit(1); });
