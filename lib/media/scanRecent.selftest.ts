// lib/media/scanRecent.selftest.ts — run: npx tsx lib/media/scanRecent.selftest.ts
import assert from 'node:assert/strict';
import { updateRecent, serialQueue, resolveScanKey, RecentListUnavailable, type RecentStore, type ScanKeyStore } from './scanRecent';

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

  // A sealed list next to a not-yet-removed legacy list is the migrated list:
  // it is used, not refused.
  const both = memStore({ sealed: 'ok:' + JSON.stringify([{ id: 'm' }]), legacy: true });
  assert.deepEqual((await updateRecent(both.store, add({ id: 'n' }))).map(d => d.id), ['n', 'm']);

  // Read order closes the migration window: the migration writes the sealed
  // list, then removes the legacy one. A change that saw "legacy" before the
  // removal reads the sealed list after it, so it never writes [doc] over the
  // migrated list.
  {
    // The migration finishes (sealed written, legacy removed) between the
    // change's first and second storage read.
    const order: string[] = [];
    let sealed: string | null = null;
    let legacy = true;
    const migrateAfterFirstRead = () => { if (order.length === 1) { sealed = 'ok:' + JSON.stringify([{ id: 'old' }]); legacy = false; } };
    const store: RecentStore<Doc> = {
      hasLegacy: async () => { const v = legacy; order.push('legacy'); migrateAfterFirstRead(); return v; },
      readSealed: async () => { const v = sealed; order.push('sealed'); migrateAfterFirstRead(); return v; },
      open: async (x: string) => JSON.parse(x.slice(3)) as Doc[],
      write: async (docs: Doc[]) => { sealed = 'ok:' + JSON.stringify(docs); },
    };
    assert.deepEqual((await updateRecent(store, add({ id: 'new' }))).map(d => d.id), ['new', 'old']);
    assert.deepEqual(order, ['legacy', 'sealed']);
  }

  // The queue: a delete whose write is slow, issued together with a save.
  // Unqueued, both read [a, b]; the save writes [c, a, b] and the delete's
  // later write of [b] drops c — the new scan's only key. Queued, the delete
  // reads the save's result.
  {
    const run = async (q: <R>(t: () => Promise<R>) => Promise<R>) => {
      const m2 = memStore({ sealed: 'ok:' + JSON.stringify([{ id: 'a' }, { id: 'b' }]) });
      const slowWrite: RecentStore<Doc> = {
        ...m2.store,
        write: async (docs: Doc[]) => { await new Promise(r => setTimeout(r, 5)); await m2.store.write(docs); },
      };
      await Promise.all([
        q(() => updateRecent(m2.store, add({ id: 'c' }))),
        q(() => updateRecent(slowWrite, (docs: Doc[]) => docs.filter(d => d.id !== 'a'))),
      ]);
      return (JSON.parse(m2.sealed!.slice(3)) as Doc[]).map(d => d.id);
    };
    assert.deepEqual(await run(t => t()), ['b'], 'the race is real without the queue');
    const q = serialQueue();
    assert.deepEqual(await run(q), ['c', 'b']);
    // A failed task does not block the next one.
    await assert.rejects(q(async () => { throw new Error('boom'); }), /boom/);
    assert.equal(await q(async () => 7), 7);
  }

  // The scan key: never minted while a sealed list exists.
  {
    const keyStore = (init: { key?: string | null; list?: boolean; getFails?: boolean }) => {
      const k = { key: init.key ?? null, sets: 0 };
      const store: ScanKeyStore = {
        get: async () => { if (init.getFails) throw new Error('keystore'); return k.key; },
        set: async (hex: string) => { k.sets++; k.key = hex; },
        sealedListExists: async () => !!init.list,
      };
      return { k, store };
    };
    // Stored key is returned as is.
    const has = keyStore({ key: 'aa', list: true });
    assert.equal(await resolveScanKey(has.store, () => 'new'), 'aa');
    assert.equal(has.k.sets, 0);
    // First use: nothing sealed yet → minted and stored.
    const first = keyStore({});
    assert.equal(await resolveScanKey(first.store, () => 'new'), 'new');
    assert.equal(first.k.key, 'new');
    // Key reads back empty while a sealed list exists → keyLost, nothing written.
    const lost = keyStore({ list: true });
    await assert.rejects(resolveScanKey(lost.store, () => 'new'), (e: unknown) => e instanceof RecentListUnavailable && e.reason === 'keyLost');
    assert.equal(lost.k.sets, 0);
    // A failed key read never mints.
    const failing = keyStore({ getFails: true });
    await assert.rejects(resolveScanKey(failing.store, () => 'new'), /keystore/);
    assert.equal(failing.k.sets, 0);
    // A failed list check never mints.
    const listFails: ScanKeyStore = { ...keyStore({}).store, sealedListExists: async () => { throw new Error('io'); } };
    let minted = false;
    await assert.rejects(resolveScanKey(listFails, () => { minted = true; return 'new'; }), /io/);
    assert.ok(!minted);
  }

  console.log('scanRecent selftest: all passed');
})().catch(e => { console.error(e); process.exit(1); });
