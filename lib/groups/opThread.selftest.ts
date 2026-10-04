// lib/groups/opThread.selftest.ts — run: npx tsx lib/groups/opThread.selftest.ts
//
// The op-index read (round 7): index + one legacy scan per session + local
// history must fold to exactly what the old paging read folds to, without
// re-reading the legacy pages on later visits; a server without the index
// (404/405) falls back to the paging read; the sender check and unreadable
// counting hold on every path.
import assert from 'node:assert/strict';
import type { Message } from '../chatService';
import {
  collectGroupOps, collectIndexedOps, collectOps, isNoOpIndex, OP_PAGE, OP_LOCAL_LIMIT, UNREADABLE_BODY,
  type IndexedOpThreadIO, type LegacyScan, type LegacyScanCache,
} from './opThread';
import { encodeNoteOp, decodeNoteOp, foldNotes, type NoteOp } from './notes';

const T0 = 1_700_000_000_000;
type Row = Message & { tagged?: boolean };
const row = (id: number, senderId: string, content: string | null, extra: Partial<Row> = {}): Row =>
  ({ id, chatId: 'g', senderId, type: 'text', content, replyToId: null, editedAt: null, deletedAt: null,
    createdAt: new Date(T0 + id).toISOString(), ...extra });
type WithoutBy<T> = T extends unknown ? Omit<T, 'by'> : never;
const op = (id: number, by: string, o: WithoutBy<NoteOp>, extra: Partial<Row> = {}) =>
  row(id, by, encodeNoteOp({ ...o, by } as NoteOp), extra);

function memCache<Op>(): LegacyScanCache<Op> & { scan?: LegacyScan<Op>; sets: number } {
  const c = { scan: undefined as LegacyScan<Op> | undefined, sets: 0,
    get: () => c.scan, set: (s: LegacyScan<Op>) => { c.scan = s; c.sets++; } };
  return c;
}

/** A fake server + device. `thread` is every server message; `local` is this device's history. */
function world(thread: Row[], local: Row[], opts: { noIndex?: number; indexFails?: boolean; pageFails?: boolean } = {}) {
  const calls = { page: 0, index: 0, decrypt: new Map<number, number>() };
  const newestFirst = (rows: Row[], before?: number) =>
    rows.filter((m) => before == null || m.id < before).sort((a, b) => b.id - a.id).slice(0, OP_PAGE);
  const io: IndexedOpThreadIO = {
    page: async (before) => { calls.page++; if (opts.pageFails) throw new Error('offline'); return newestFirst(thread, before); },
    indexPage: async (before) => {
      calls.index++;
      if (opts.noIndex) throw Object.assign(new Error('Not found'), { status: opts.noIndex });
      if (opts.indexFails) throw Object.assign(new Error('Server error'), { status: 500 });
      return newestFirst(thread.filter((m) => m.tagged), before);
    },
    // Same rule as lib/messageHistory: server wins unless its body was reclaimed and ours was not.
    withLocal: async (server) => {
      const byId = new Map<number, Message>(local.map((m) => [m.id, m]));
      for (const m of server) {
        const mine = byId.get(m.id);
        byId.set(m.id, mine && mine.content && !m.content && !m.deletedAt ? mine : m);
      }
      return [...byId.values()].sort((a, b) => a.id - b.id);
    },
    decrypt: async (m) => {
      calls.decrypt.set(m.id, (calls.decrypt.get(m.id) ?? 0) + 1);
      if (m.content === 'THROW') throw new Error('no sender key');
      return String(m.content);
    },
  };
  return { io, calls };
}

const fold = (ops: NoteOp[]) => JSON.stringify(foldNotes(ops));

async function main() {
  // ── A thread with every kind of op ──
  // 1..1000 chat text; legacy untagged ops at 5 and 40; tagged ops at 300 and
  // 950; a tagged op whose server body was reclaimed (700, readable only from
  // local history); a forged tagged op (960: u2 claims to be u1); a local-only
  // untagged op (1001: arrived via sync, from an older app).
  const thread: Row[] = [];
  for (let id = 1; id <= 1000; id++) thread.push(row(id, 'u1', `chat ${id}`));
  const put = (r: Row) => { thread[r.id - 1] = r; };
  put(op(5, 'u1', { k: 'add', id: 'a', at: T0 + 5, title: 'Legacy A', body: 'one' }));
  put(op(40, 'u2', { k: 'edit', id: 'a', at: T0 + 40, body: 'two' }));
  put({ ...op(300, 'u2', { k: 'pin', id: 'a', at: T0 + 300, pinned: true }), tagged: true });
  put({ ...row(700, 'u1', null), tagged: true });
  put({ ...op(950, 'u1', { k: 'add', id: 'b', at: T0 + 950, title: 'Tagged B' }), tagged: true });
  put(row(960, 'u2', encodeNoteOp({ k: 'edit', id: 'b', at: T0 + 960, by: 'u1', title: 'Forged' }), { tagged: true }));
  const local: Row[] = [
    op(700, 'u1', { k: 'edit', id: 'b', at: T0 + 700, title: 'Reclaimed edit (older)' }),
    op(1001, 'u3', { k: 'add', id: 'c', at: T0 + 1001, title: 'Local C' }),
    row(990, 'u1', 'chat 990'),
  ];

  // The reference: the old paging read over the WHOLE thread (no page cap).
  const ref = await collectOps<NoteOp>(world(thread, local).io, decodeNoteOp, 100);
  assert.equal(ref.ops.length, 6, 'reference finds 5 genuine ops + the reclaimed one');

  // ── 1. First visit: index + one legacy scan + local; same fold as the reference ──
  const cache = memCache<NoteOp>();
  const w1 = world(thread, local);
  const v1 = await collectIndexedOps<NoteOp>(w1.io, decodeNoteOp, cache, T0);
  assert.equal(fold(v1.ops), fold(ref.ops), 'index + legacy + local folds like the full paging read');
  assert.equal(v1.ops.length, 6, 'each op once: index, legacy scan and local overlap are deduped by message id');
  assert.ok(!fold(v1.ops).includes('Forged'), 'a forged author is dropped on the index path too');
  assert.equal(v1.complete, true);
  assert.equal(w1.calls.page, 6, 'the legacy scan pages the 1000-message thread once (5 full pages + the empty end)');
  assert.equal(cache.sets, 1, 'the scan is remembered for the session');
  // Arrival order does not matter: shuffled input folds the same.
  assert.equal(fold([...v1.ops].reverse()), fold(v1.ops));

  // ── 2. Later visit: no legacy paging; only index and local rows are read ──
  const w2 = world(thread, local);
  const v2 = await collectIndexedOps<NoteOp>(w2.io, decodeNoteOp, cache, T0);
  assert.equal(fold(v2.ops), fold(ref.ops), 'a later visit folds the same');
  assert.equal(w2.calls.page, 0, 'no legacy pages on a later visit');
  const decrypted = [...w2.calls.decrypt.keys()].sort((a, b) => a - b);
  assert.deepEqual(decrypted, [300, 700, 950, 960, 990, 1001], 'only index ops and local rows are decrypted');

  // A new op from another member reaches the index; a new untagged op (older app) reaches local history.
  const thread3 = [...thread, { ...op(1002, 'u2', { k: 'edit', id: 'c', at: T0 + 1002, title: 'C2' }), tagged: true }];
  const local3 = [...local, op(1003, 'u4', { k: 'pin', id: 'b', at: T0 + 1003, pinned: true })];
  const v3 = await collectIndexedOps<NoteOp>(world(thread3, local3).io, decodeNoteOp, cache, T0);
  const notes3 = foldNotes(v3.ops);
  assert.equal(notes3.find((n) => n.id === 'c')?.title, 'C2', 'new tagged op is read from the index');
  assert.equal(notes3.find((n) => n.id === 'b')?.pinned, true, 'new untagged op is read from local history');

  // ── 3. Unreadable: counted, remembered, retried, recovered ──
  const thread4 = thread.map((m) => (m.id === 40 ? { ...m, content: 'THROW' } : m.id === 41 ? { ...m, content: UNREADABLE_BODY } : m));
  const c4 = memCache<NoteOp>();
  const v4 = await collectIndexedOps<NoteOp>(world(thread4, local).io, decodeNoteOp, c4, T0);
  assert.equal(v4.unreadable, 2, 'a thrown decrypt and the placeholder both count');
  assert.equal(foldNotes(v4.ops).find((n) => n.id === 'a')?.body, 'one', 'the unreadable edit is missing');
  const v4b = await collectIndexedOps<NoteOp>(world(thread4, local).io, decodeNoteOp, c4, T0);
  assert.equal(v4b.unreadable, 2, 'still unreadable on the next visit, still counted');
  // The sender key arrived: the remembered message now opens.
  const w4c = world(thread, local);
  const v4c = await collectIndexedOps<NoteOp>({ ...w4c.io, decrypt: async (m) => (m.id === 40 ? String(thread[39].content) : w4c.io.decrypt(m)) }, decodeNoteOp, c4, T0);
  assert.equal(v4c.unreadable, 1, 'the recovered message is no longer counted');
  assert.equal(foldNotes(v4c.ops).find((n) => n.id === 'a')?.body, 'two', 'and its op is applied');
  assert.equal(w4c.calls.page, 0, 'without re-paging the thread');

  // ── 4. Disappearing and deleted legacy ops leave the cache ──
  const thread5 = thread.map((m) => (m.id === 5 ? { ...m, expiresAt: new Date(T0 + 10_000).toISOString() } : m));
  const c5 = memCache<NoteOp>();
  await collectIndexedOps<NoteOp>(world(thread5, local).io, decodeNoteOp, c5, T0);
  const later = await collectIndexedOps<NoteOp>(world(thread5, local).io, decodeNoteOp, c5, T0 + 20_000);
  assert.equal(foldNotes(later.ops).find((n) => n.id === 'a'), undefined, 'an expired legacy op is not served from memory');
  const c6 = memCache<NoteOp>();
  await collectIndexedOps<NoteOp>(world(thread, local).io, decodeNoteOp, c6, T0);
  const deletedLocal = [...local, { ...row(5, 'u1', null), deletedAt: '2026-10-04T00:00:00Z' }];
  const v6 = await collectIndexedOps<NoteOp>(world(thread, deletedLocal).io, decodeNoteOp, c6, T0);
  assert.equal(foldNotes(v6.ops).find((n) => n.id === 'a'), undefined, 'a legacy op whose message was deleted is dropped');

  // ── 5. A busy group outruns local history: the legacy scan runs again ──
  const c7 = memCache<NoteOp>();
  await collectIndexedOps<NoteOp>(world(thread, local).io, decodeNoteOp, c7, T0);
  const flood: Row[] = Array.from({ length: OP_LOCAL_LIMIT }, (_, i) => row(5000 + i, 'u1', 'chat'));
  const wFlood = world([...thread, ...flood], flood);
  const v7 = await collectIndexedOps<NoteOp>(wFlood.io, decodeNoteOp, c7, T0);
  assert.ok(wFlood.calls.page > 0, 'a gap between local history and the last scan triggers a rescan');
  assert.equal(foldNotes(v7.ops).find((n) => n.id === 'a')?.body, 'two', 'ops found by the first scan are kept');
  assert.equal(v7.complete, false, 'the 10-page rescan does not reach the old scan, and says so');

  // ── 6. No viewer: nothing is remembered ──
  const w8 = world(thread, local);
  await collectIndexedOps<NoteOp>(w8.io, decodeNoteOp, null, T0);
  await collectIndexedOps<NoteOp>(w8.io, decodeNoteOp, null, T0);
  assert.equal(w8.calls.page, 12, 'without a viewer the legacy scan runs on every visit');

  // ── 7. The legacy scan failing does not fail the visit, and is not remembered ──
  const c9 = memCache<NoteOp>();
  const v9 = await collectIndexedOps<NoteOp>(world(thread, local, { pageFails: true }).io, decodeNoteOp, c9, T0);
  assert.deepEqual(foldNotes(v9.ops).map((n) => n.id).sort(), ['b', 'c'], 'index and local ops still show (legacy-only note a cannot)');
  assert.equal(v9.complete, false, 'and the gap is reported');
  assert.equal(c9.sets, 0, 'a failed scan is retried next visit');

  // ── 8. Fallback: a server without the index ──
  assert.equal(isNoOpIndex({ status: 404 }), true);
  assert.equal(isNoOpIndex({ status: 405 }), true);
  assert.equal(isNoOpIndex({ status: 500 }), false);
  assert.equal(isNoOpIndex(new Error('Network unavailable')), false);
  assert.equal(isNoOpIndex(null), false);
  for (const status of [404, 405]) {
    const c = memCache<NoteOp>();
    const w = world(thread, local, { noIndex: status });
    const r = await collectGroupOps<NoteOp>(w.io, decodeNoteOp, c);
    const today = await collectOps<NoteOp>(world(thread, local).io, decodeNoteOp);
    assert.equal(fold(r.ops), fold(today.ops), `${status}: the paging read, unchanged`);
    assert.equal(r.complete, today.complete);
    assert.equal(w.calls.index, 1, `${status}: the index is asked once`);
    assert.equal(c.sets, 0, `${status}: the paging read keeps nothing in memory`);
  }
  // Any other index failure is the load failing, as the first page always was.
  await assert.rejects(collectGroupOps<NoteOp>(world(thread, local, { indexFails: true }).io, decodeNoteOp, memCache()));

  console.log('groups/opThread self-check OK');
}

main().catch((e) => { console.error(e); process.exit(1); });
