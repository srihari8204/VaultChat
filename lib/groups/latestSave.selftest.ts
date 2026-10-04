// lib/groups/latestSave.selftest.ts — run: npx tsx lib/groups/latestSave.selftest.ts
//
// makeLatestSaver (group-admin settings): a different choice made while a save
// runs is shown at once and written after it; only the latest is written; a
// failure returns the control to the last value the server accepted.

import assert from 'node:assert/strict';
import { makeLatestSaver } from './latestSave';

function deferredWriter<T = string>() {
  const writes: T[] = [];
  const pending: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  const write = (v: T) => {
    writes.push(v);
    return new Promise<void>((resolve, reject) => pending.push({ resolve, reject }));
  };
  return { writes, pending, write };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

async function main() {
  // 1. Plain save.
  {
    const save = makeLatestSaver();
    const shown: string[] = [];
    const w = deferredWriter();
    const p = save('slow', 'off', '10s', w.write, (v) => shown.push(v));
    await tick();
    w.pending[0].resolve();
    assert.deepEqual(await p, { status: 'saved', value: '10s' });
    assert.deepEqual(w.writes, ['10s']);
    assert.deepEqual(shown, ['10s']);
  }

  // 2. Same value: nothing written.
  {
    const save = makeLatestSaver();
    const w = deferredWriter();
    assert.deepEqual(await save('slow', 'off', 'off', w.write, () => {}), { status: 'unchanged' });
    assert.deepEqual(w.writes, []);
  }

  // 3. Two taps during a running save: the middle one is skipped, the last is written.
  {
    const save = makeLatestSaver();
    const shown: string[] = [];
    const w = deferredWriter();
    const first = save('slow', 'off', '10s', w.write, (v) => shown.push(v));
    await tick();
    assert.deepEqual(await save('slow', '10s', '30s', w.write, (v) => shown.push(v)), { status: 'queued' });
    assert.deepEqual(await save('slow', '30s', '1m', w.write, (v) => shown.push(v)), { status: 'queued' });
    assert.deepEqual(shown, ['10s', '30s', '1m'], 'every choice is shown at once');
    w.pending[0].resolve();
    await tick();
    assert.deepEqual(w.writes, ['10s', '1m'], 'only the latest queued choice is written');
    w.pending[1].resolve();
    assert.deepEqual(await first, { status: 'saved', value: '1m' });
  }

  // 4. Back to the saved value while saving: written back (the server holds the in-flight one).
  {
    const save = makeLatestSaver();
    const w = deferredWriter();
    const first = save('send', 'everyone', 'admins', w.write, () => {});
    await tick();
    await save('send', 'admins', 'everyone', w.write, () => {});
    w.pending[0].resolve();
    await tick();
    w.pending[1].resolve();
    assert.deepEqual(await first, { status: 'saved', value: 'everyone' });
    assert.deepEqual(w.writes, ['admins', 'everyone']);
  }

  // 5. A failure shows the last accepted value.
  {
    const save = makeLatestSaver();
    const shown: string[] = [];
    const w = deferredWriter();
    const first = save('slow', 'off', '10s', w.write, (v) => shown.push(v));
    await tick();
    await save('slow', '10s', '30s', w.write, (v) => shown.push(v));
    w.pending[0].resolve();
    await tick();
    w.pending[1].reject(new Error('offline'));
    const r = await first;
    assert.equal(r.status, 'failed');
    assert.equal((r as { value: string }).value, '10s', '10s reached the server, 30s did not');
    assert.equal(shown[shown.length - 1], '10s');
  }

  // 6. Keys are independent, and a key is free again after its chain ends.
  {
    const save = makeLatestSaver();
    const w = deferredWriter<number>();
    const a = save('a', 0, 1, w.write, () => {});
    const b = save('b', 0, 2, w.write, () => {});
    await tick();
    assert.equal(w.writes.length, 2);
    w.pending[0].resolve(); w.pending[1].resolve();
    assert.equal((await a).status, 'saved');
    assert.equal((await b).status, 'saved');
    const again = save('a', 1, 3, w.write, () => {});
    await tick();
    w.pending[2].resolve();
    assert.deepEqual(await again, { status: 'saved', value: 3 });
  }

  console.log('latestSave selftest: ok');
}

main().catch((e) => { console.error(e); process.exit(1); });
