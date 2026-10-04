// Run: npx tsx lib/spaces/sosOutboxCore.selftest.ts
// Drives the SOS outbox through stub storage, user, clock and server: the
// round-7 review's D1–D7 (SP/rerate7/H.md), each as a scenario.
import assert from 'node:assert/strict';
import { createSosOutbox, SosNotKept, SosUnknown, SOS_QUEUE_KEY, type SosEvent } from './sosOutboxCore';
import {
  parseSosQueue, sosBody, SOS_FRESH_MS, SOS_PRUNE_MS, SOS_MAX_AGE_MS, RUN_ENDED_TEXT, EXPIRED_TEXT, type PendingSos,
} from './sosQueue';

const T0 = Date.parse('2026-10-04T08:00:00Z');
type Reply = 'ok' | 'ended' | number | (() => Promise<unknown>);
const httpErr = (status: number, message?: string) => Object.assign(new Error(message ?? `HTTP ${status}`), { status });

function harness(init: PendingSos[] = []) {
  const h = {
    data: init.length ? JSON.stringify(init) as string | null : null,
    failGet: false, failSet: false,
    me: 'u1' as string | Error,
    now: T0,
    replies: [] as Reply[],
    sent: [] as { e: PendingSos; expected: string }[],
    run: 'started' as string | number,
    runChecks: 0,
    onRunCheck: null as null | (() => Promise<unknown>),
    sets: 0,
    n: 0,
  };
  const box = createSosOutbox({
    store: {
      getItem: async () => { if (h.failGet) throw new Error('read failed'); return h.data; },
      setItem: async (_k, v) => { if (h.failSet) throw new Error('write failed'); h.sets++; h.data = v; },
    },
    me: async () => { if (h.me instanceof Error) throw h.me; return h.me; },
    send: async (e, expected) => {
      h.sent.push({ e, expected });
      const r = h.replies.length ? h.replies.shift()! : 0; // default: offline
      if (typeof r === 'function') { await r(); return; }
      if (r === 'ok') return { id: 'inc' };
      if (r === 'ended') return { id: 'inc', runEnded: true };
      throw httpErr(r, r === 403 ? 'You cannot report incidents in this space' : undefined);
    },
    runStatus: async () => { h.runChecks++; if (h.onRunCheck) await h.onRunCheck(); if (typeof h.run === 'number') throw httpErr(h.run); return h.run; },
    now: () => h.now,
    newId: () => `00000000-0000-4000-8000-00000000000${++h.n}`,
  });
  const events: SosEvent[] = [];
  box.onSosEvent((e) => events.push(e));
  const stored = () => parseSosQueue(h.data);
  return { h, box, events, stored };
}
const entry = (id: string, over: Partial<PendingSos> = {}): PendingSos =>
  ({ id, spaceId: 's1', runId: 'r1', reporterId: 'u1', at: T0 - 10_000, ...over });

async function main() {
  // ── D1: "sent" only from a 2xx; an unreadable list is unknown, never empty ──
  {
    const { h, box, events, stored } = harness();
    h.replies = [0];
    const r = await box.queueSos('s1', 'r1');
    assert.equal(r.kind, 'waiting', 'offline press: kept and waiting, not sent');
    assert.equal(stored().length, 1);
    assert.equal(events.length, 0, 'no event without an answer');

    h.failGet = true;
    await assert.rejects(box.sosForThisRun('s1', 'r1'), SosUnknown, 'a failed read is "could not check", not an empty list');
    await box.flushSos(); // must not throw, must not send, must not say anything
    assert.equal(events.length, 0);
    h.failGet = false;

    h.me = '';
    await assert.rejects(box.sosForThisRun('s1', 'r1'), SosUnknown, 'an unknown user is "could not check"');
    h.me = new Error('SecureStore');
    await assert.rejects(box.sosForThisRun('s1', 'r1'), SosUnknown);
    h.me = 'u1';
    assert.equal((await box.sosForThisRun('s1', 'r1')).length, 1, 'still waiting once readable again');

    // The retry's 2xx is the only thing that confirms it — once.
    h.replies = ['ok'];
    h.now = T0 + 5_000;
    await box.flushSos();
    assert.deepEqual(events.map((e) => [e.type, e.by]), [['sent', 'retry']], 'a retry delivery is announced once, as a retry');
    assert.equal(stored().length, 0);
    await box.flushSos();
    assert.equal(events.length, 1, 'never announced twice');
  }
  {
    // A 2xx whose follow-up write fails is still "sent" (it was), and is not
    // sent again from this session although storage still holds it.
    const { h, box, stored } = harness();
    h.replies = [async () => { h.failSet = true; }];
    const r = await box.queueSos('s1', 'r1');
    assert.equal(r.kind, 'sent');
    assert.equal(stored().length, 1, 'removal failed: still stored');
    h.failSet = false;
    await box.flushSos();
    assert.equal(h.sent.length, 1, 'not re-sent after a 2xx in this session');
    assert.equal(stored().length, 0, 'removed on the next flush');
  }

  // ── D2: never keep an alert with no reporter ──
  for (const who of ['', new Error('SecureStore')]) {
    const { h, box } = harness();
    h.me = who;
    let key: { id: string; at: number } | null = null;
    await assert.rejects(box.queueSos('s1', 'r1'), (e: unknown) => {
      if (!(e instanceof SosNotKept) || e.reason !== 'no-reporter') return false;
      key = e.key; return true;
    });
    assert.ok(key && (key as { id: string }).id && (key as { at: number }).at === T0, 'it hands over a key and press time for the direct send');
    assert.equal(h.sets, 0, 'nothing stored');
    assert.equal(h.data, null);
    // The caller's direct send carries the key and press time, and no account check.
    h.replies = ['ok'];
    await box.sendUnkept('s1', 'r1', { id: 'k-1', at: T0 });
    assert.equal(h.sent[0].e.id, 'k-1');
    assert.equal(h.sent[0].expected, '');
    assert.equal(sosBody(h.sent[0].e).clientKey, 'k-1');
  }

  // ── D3: never write the queue after a failed read ──
  {
    const keep = [entry('a'), entry('b', { runId: 'r2', dead: 'refused' })];
    const { h, box, stored } = harness(keep);
    h.failGet = true;
    await assert.rejects(box.queueSos('s1', 'r3'), (e: unknown) => e instanceof SosNotKept && e.reason === 'storage');
    await assert.rejects(box.dismissSos('b'));
    await assert.rejects(box.withdrawSos('a'));
    await box.flushSos();
    assert.equal(h.sets, 0, 'no write of any kind after a failed read');
    h.failGet = false;
    assert.deepEqual(stored(), keep, 'stored alerts untouched');

    // Writes are serialised: two presses on different runs both land.
    h.replies = [0, 0];
    await Promise.all([box.queueSos('s1', 'r5'), box.queueSos('s1', 'r6')]);
    assert.deepEqual(stored().map((e) => e.runId).sort(), ['r1', 'r2', 'r5', 'r6']);
  }

  // ── D4: a repeat press reuses the waiting alert; one key per alert ──
  {
    const { h, box, stored } = harness();
    h.replies = [0, 0];
    const a = await box.queueSos('s1', 'r1');
    h.now = T0 + 20_000;
    const b = await box.queueSos('s1', 'r1');
    assert.equal(stored().length, 1, 'no second alert queued');
    assert.equal(b.id, a.id);
    assert.ok(b.kind === 'waiting' && b.reused && !(a.kind === 'waiting' && a.reused));
    assert.equal(h.sent.length, 2, 'the repeat press retried it');
    assert.equal(sosBody(h.sent[0].e).clientKey, sosBody(h.sent[1].e).clientKey, 'same idempotency key on every try');
    assert.match(a.id, /^[0-9a-f-]{36}$/);
    // A repeat press long after, on a run since marked finished: the driver is
    // saying it again, so it is sent (no run check), under the same key.
    h.now = T0 + 10 * 60_000;
    h.run = 'completed';
    h.replies = ['ok'];
    const again = await box.queueSos('s1', 'r1');
    assert.equal(again.kind, 'sent');
    assert.equal(again.id, a.id);
    assert.equal(h.runChecks, 0);
    // Past the age limit a waiting alert is not reused: it expires, a new one goes.
    const z = harness([entry('stale', { at: T0 - SOS_MAX_AGE_MS - 1 })]);
    z.h.replies = ['ok'];
    const nz = await z.box.queueSos('s1', 'r1');
    assert.ok(nz.kind === 'sent' && nz.id !== 'stale');
    assert.equal(z.stored().find((x) => x.id === 'stale')?.dead, EXPIRED_TEXT);
    h.run = 'started';
    // Another run is another alert.
    h.replies = [0];
    const c = await box.queueSos('s1', 'r2');
    assert.notEqual(c.id, a.id);
    assert.deepEqual(stored().map((x) => x.runId), ['r2'], 'the delivered one is gone, the new one waits');
  }

  // ── D5: press time sent; never auto-sent once the run is over; withdraw ──
  {
    const { h, box, events, stored } = harness();
    h.replies = [0];
    const a = await box.queueSos('s1', 'r1');
    const body = sosBody(h.sent[0].e);
    assert.equal(body.pressedAt, new Date(T0).toISOString());
    assert.match(body.pressedClock, /^\d\d:\d\d$/);
    assert.equal(body.note, '', 'the note stays reserved for ciphertext');
    assert.equal(h.runChecks, 0, 'a fresh press is not held up by a run check');

    h.now = T0 + SOS_FRESH_MS + 1;
    h.run = 'completed';
    await box.flushSos();
    assert.equal(h.sent.length, 1, 'not sent after the run finished');
    assert.equal(stored()[0].dead, RUN_ENDED_TEXT);
    assert.deepEqual(events.map((e) => [e.type, e.by]), [['dead', 'retry']]);
    assert.equal(a.kind, 'waiting');

    // The run cannot be checked (offline): kept, not sent, not dead.
    const o = harness([entry('x', { at: T0 - SOS_FRESH_MS - 5 })]);
    o.h.run = 0;
    await o.box.flushSos();
    assert.equal(o.h.sent.length, 0);
    assert.equal(o.stored()[0].dead, undefined);
    // The run is still going: sent.
    o.h.run = 'started'; o.h.replies = ['ok'];
    await o.box.flushSos();
    assert.equal(o.h.sent.length, 1);
    assert.equal(o.stored().length, 0);

    // Withdraw: removed and never sent.
    const w = harness([entry('w')]);
    assert.deepEqual(await w.box.withdrawSos('w'), { mayHaveGone: false });
    w.h.replies = ['ok'];
    await w.box.flushSos();
    assert.equal(w.h.sent.length, 0);
    assert.equal(w.stored().length, 0);
    // Withdrawn while the flush checks its run: not sent.
    const wr = harness([entry('wr', { at: T0 - SOS_FRESH_MS - 5 })]);
    wr.h.onRunCheck = () => wr.box.withdrawSos('wr');
    wr.h.replies = ['ok'];
    await wr.box.flushSos();
    assert.equal(wr.h.sent.length, 0, 'withdrawn mid-flush: not sent');
    // Withdrawn while its request is in flight: said honestly; a late 2xx is still announced.
    const f = harness([entry('f')]);
    let withdrew: Promise<{ mayHaveGone: boolean }> | null = null;
    f.h.replies = [async () => { withdrew = f.box.withdrawSos('f'); }];
    await f.box.flushSos();
    assert.deepEqual(await withdrew, { mayHaveGone: true });
    assert.deepEqual(f.events.map((e) => e.type), ['sent']);
    // Withdrawn in flight and then refused: nothing left to say.
    const fr = harness([entry('fr')]);
    fr.h.replies = [async () => { await fr.box.withdrawSos('fr'); throw httpErr(403); }];
    await fr.box.flushSos();
    assert.deepEqual(fr.events, [], 'a withdrawn alert\'s refusal is not announced');
    assert.equal(fr.stored().length, 0);
    // Expiry: dead, said, never sent.
    const x = harness([entry('old', { at: T0 - SOS_MAX_AGE_MS - 1 })]);
    await x.box.flushSos();
    assert.equal(x.h.sent.length, 0);
    assert.equal(x.stored()[0].dead, EXPIRED_TEXT);
    assert.deepEqual(x.events.map((e) => e.type), ['dead']);
  }

  // ── D6: undelivered alerts are said app-wide, once; the press's own are not repeated ──
  {
    const { h, box } = harness([entry('d1', { dead: 'Refused.' }), entry('o1', { reporterId: 'u2', dead: 'x' })]);
    const told = await box.undeliveredToTell();
    assert.deepEqual(told.map((e) => e.id), ['d1'], 'only mine');
    assert.deepEqual(await box.undeliveredToTell(), [], 'once per session');
    h.replies = [403];
    const r = await box.queueSos('s1', 'r9');
    assert.equal(r.kind, 'dead');
    assert.equal(r.kind === 'dead' && r.why, 'You cannot report incidents in this space');
    assert.deepEqual(await box.undeliveredToTell(), [], 'the press already said its refusal');
    h.failGet = true;
    await assert.rejects(box.undeliveredToTell(), SosUnknown);
  }
  {
    // A press answered by the server as "run had ended" says so.
    const { h, box, events } = harness();
    h.replies = ['ended'];
    const r = await box.queueSos('s1', 'r1');
    assert.deepEqual(r.kind === 'sent' && r.runEnded, true);
    assert.deepEqual(events.map((e) => [e.type, e.by]), [['sent', 'press']], 'a press delivery is the press\'s to say');
  }

  // ── D7: sent as the reporter only; another account's old entries pruned ──
  {
    const { h, box, stored } = harness([
      entry('mine'),
      entry('theirsOld', { reporterId: 'u2', at: T0 - SOS_PRUNE_MS - 1 }),
      entry('theirsNew', { reporterId: 'u2', at: T0 - 60_000 }),
      entry('mineDeadOld', { at: T0 - SOS_PRUNE_MS - 1, dead: 'Refused.' }),
    ]);
    h.replies = [0];
    await box.flushSos();
    assert.deepEqual(h.sent.map((s) => [s.e.id, s.expected]), [['mine', 'u1']], 'expectedUserId is the reporter');
    assert.deepEqual(stored().map((e) => e.id), ['mine', 'theirsNew', 'mineDeadOld'], 'only another account\'s old entry is pruned');
    // A token for someone else (lib/api SessionEndedError: status 0) keeps it.
    assert.equal(stored()[0].dead, undefined);
    h.me = '';
    await box.flushSos();
    assert.equal(h.sent.length, 1, 'signed out: nothing sent');
    assert.equal(stored().length, 3, 'and nothing pruned');
  }

  void SOS_QUEUE_KEY;
  console.log('spaces/sosOutboxCore self-check OK');
}

main().catch((e) => { console.error(e); process.exit(1); });
