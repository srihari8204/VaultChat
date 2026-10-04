// lib/media/scanRecent.selftest.ts — run: npx tsx lib/media/scanRecent.selftest.ts
import assert from 'node:assert/strict';
import { updateRecent, RecentListUnavailable, type RecentStore } from './scanRecent';

type Doc = { id: string };
const memStore = (init: { sealed?: string | null; legacy?: boolean; readFails?: boolean } = {}) => {
  const s = {
    sealed: init.sealed ?? null,
    writes: 0,
    store: {
      readSealed: async () => { if (init.readFails) throw new Error('io'); return s.sealed; },
      hasLegacy: async () => !!init.legacy,
      open: async (x: string) => (x.startsWith('ok:') ? (JSON.parse(x.slice(3)) as Doc[]) : null),
      write: async (docs: Doc[]) => { s.writes++; s.sealed = 'ok:' + JSON.stringify(docs); },
    } as RecentStore<Doc>,
  };
  return s;
};
const add = (d: Doc) => (docs: Doc[]) => [d, ...docs.filter(x => x.id !== d.id)];

(async () => {
  // The bug: the screen's copy is [] after a failed load. The change is applied
  // to the STORED list, so older scans (and their keys) survive.
  const m = memStore({ sealed: 'ok:' + JSON.stringify([{ id: 'a' }, { id: 'b' }]) });
  const next = await updateRecent(m.store, add({ id: 'c' }));
  assert.deepEqual(next.map(d => d.id), ['c', 'a', 'b']);
  assert.equal(m.sealed, 'ok:' + JSON.stringify(next));

  // A list that exists but cannot be opened is never overwritten.
  const locked = memStore({ sealed: 'garbage' });
  await assert.rejects(updateRecent(locked.store, add({ id: 'c' })), (e: unknown) => e instanceof RecentListUnavailable && e.reason === 'locked');
  assert.equal(locked.writes, 0);
  assert.equal(locked.sealed, 'garbage');

  // A read failure writes nothing.
  const failing = memStore({ readFails: true });
  await assert.rejects(updateRecent(failing.store, add({ id: 'c' })), /io/);
  assert.equal(failing.writes, 0);

  // An unmigrated legacy list is not hidden behind a new sealed list.
  const legacy = memStore({ legacy: true });
  await assert.rejects(updateRecent(legacy.store, add({ id: 'c' })), (e: unknown) => e instanceof RecentListUnavailable && e.reason === 'legacy');
  assert.equal(legacy.writes, 0);

  // First scan ever: nothing stored, no legacy → saved.
  const fresh = memStore();
  assert.deepEqual(await updateRecent(fresh.store, add({ id: 'x' })), [{ id: 'x' }]);

  // No cap: a 21st scan keeps all 20 older keys. Delete applies to the stored list.
  const many = memStore({ sealed: 'ok:' + JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ id: String(i) }))) });
  assert.equal((await updateRecent(many.store, add({ id: 'new' }))).length, 21);
  const afterDelete = await updateRecent(many.store, (docs: Doc[]) => docs.filter(d => d.id !== '0'));
  assert.ok(!afterDelete.some(d => d.id === '0') && afterDelete[0].id === 'new');

  console.log('scanRecent selftest: all passed');
})().catch(e => { console.error(e); process.exit(1); });
