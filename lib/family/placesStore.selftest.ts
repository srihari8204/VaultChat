// lib/family/placesStore.selftest.ts — run: npx tsx lib/family/placesStore.selftest.ts
//
// Saved places must never be overwritten from a list that was not read:
// getPlaces used to turn any read/parse error into [], and the next add,
// toggle or edit then saved only what the screen showed over the stored list.
import assert from 'node:assert/strict';

// In-memory AsyncStorage with failure injection.
const mem = new Map<string, string>();
const fail = { get: false };
let writes = 0;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request: string, ...rest: unknown[]) {
  if (request === '@react-native-async-storage/async-storage') {
    return { __esModule: true, default: {
      getItem: async (k: string) => { if (fail.get) throw new Error('io'); return mem.has(k) ? mem.get(k)! : null; },
      setItem: async (k: string, v: string) => { writes++; mem.set(k, v); },
      removeItem: async (k: string) => { mem.delete(k); },
    } };
  }
  return origLoad.call(this, request, ...rest);
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const S = require('./store') as typeof import('./store');

type G = import('./geofence').Geofence;
const place = (id: string): G => ({ id, name: id, center: { lat: 1, lng: 2 }, radiusM: 100 });
const KEY = 'vc_family_places_c1';
const ids = async () => (JSON.parse(mem.get(KEY)!) as G[]).map((p) => p.id);

(async () => {
  // Nothing stored yet: reads as empty, and the first add saves.
  assert.deepEqual(await S.readPlaces('c1'), []);
  assert.deepEqual((await S.updatePlaces('c1', (ps) => [place('a'), ...ps])).map((p) => p.id), ['a']);

  // The change applies to the STORED list, not to a stale screen copy.
  mem.set(KEY, JSON.stringify([place('a'), place('b')]));
  await S.updatePlaces('c1', (ps) => [place('c'), ...ps]);
  assert.deepEqual(await ids(), ['c', 'a', 'b']);

  // A read failure: readPlaces throws, getPlaces (readers) gives [], and an
  // update writes NOTHING.
  fail.get = true;
  writes = 0;
  await assert.rejects(S.readPlaces('c1'), (e: unknown) => e instanceof S.PlacesUnreadable);
  assert.deepEqual(await S.getPlaces('c1'), []);
  await assert.rejects(S.updatePlaces('c1', () => [place('x')]), (e: unknown) => e instanceof S.PlacesUnreadable);
  assert.equal(writes, 0);
  fail.get = false;
  assert.deepEqual(await ids(), ['c', 'a', 'b']);

  // Corrupt JSON, or JSON that is not a list, is unreadable — never "empty".
  for (const bad of ['{not json', '{"a":1}', '"x"']) {
    mem.set(KEY, bad);
    writes = 0;
    await assert.rejects(S.updatePlaces('c1', (ps) => [place('x'), ...ps]), (e: unknown) => e instanceof S.PlacesUnreadable);
    assert.equal(writes, 0);
    assert.equal(mem.get(KEY), bad);
    assert.deepEqual(await S.getPlaces('c1'), []);
  }

  // Two updates started together both land: the second reads the first's result.
  mem.set(KEY, JSON.stringify([place('a'), place('b')]));
  await Promise.all([
    S.updatePlaces('c1', (ps) => ps.map((p) => (p.id === 'a' ? { ...p, enabled: false } : p))),
    S.updatePlaces('c1', (ps) => ps.map((p) => (p.id === 'b' ? { ...p, enabled: false } : p))),
  ]);
  assert.deepEqual((JSON.parse(mem.get(KEY)!) as G[]).map((p) => p.enabled), [false, false]);

  // A failed update does not block the next one.
  fail.get = true;
  await assert.rejects(S.updatePlaces('c1', (ps) => ps));
  fail.get = false;
  await S.updatePlaces('c1', (ps) => ps.filter((p) => p.id !== 'a'));
  assert.deepEqual(await ids(), ['b']);

  console.log('placesStore selftest: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
