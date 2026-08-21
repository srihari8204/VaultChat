// connectionEvents.selftest.ts — the Go Live connection-state wiring.
//
// SCOPE, STATED PLAINLY: these are STATIC/AUTOMATED EVENT TESTS. They prove
// that when the SDK emits an event the app reacts correctly, and — just as
// importantly — that the app does NOT retry, reconnect, re-publish or tear
// down on its own. They prove NOTHING about real network recovery: no
// transport is opened here and no packet is sent. Real recovery is a DEVICE
// RUNTIME TEST and is listed as PENDING.
//
//   npx tsx lib/golive/connectionEvents.selftest.ts

import {
  CONNECTION_EVENTS,
  assertConnectionEventNames,
  wireConnectionEvents,
  type ConnectionEventSource,
} from './connectionEvents';

let failures = 0;
function check(what: string, ok: boolean): void {
  if (!ok) { failures++; console.error('  FAIL', what); } else { console.log('  ok  ', what); }
}

/**
 * A Room stand-in that records every method anyone calls on it.
 *
 * The point is the NEGATIVE assertions. A reconnect bug in this codebase would
 * not look like a missing callback — it would look like the app helpfully
 * calling connect() again and ending up with two publishers in one room. So the
 * fake answers "was anything other than .on() touched?" and every test asserts
 * it was not.
 */
function fakeRoom() {
  const handlers = new Map<string, Array<(...a: any[]) => void>>();
  const calls: string[] = [];
  const room = {
    on(event: string, cb: (...a: any[]) => void) {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
      return room;
    },
    // Anything below being called at all is a failure.
    connect: (...a: any[]) => { calls.push('connect'); return Promise.resolve(); },
    disconnect: () => { calls.push('disconnect'); return Promise.resolve(); },
    leave: () => { calls.push('leave'); return Promise.resolve(); },
    publishTrack: () => { calls.push('publishTrack'); return Promise.resolve(); },
  };
  return {
    room: room as unknown as ConnectionEventSource,
    calls,
    emit(event: string) { (handlers.get(event) ?? []).forEach(cb => cb()); },
    listenerCount(event: string) { return (handlers.get(event) ?? []).length; },
  };
}

/** The Go Live UI state model, exactly as live-view.tsx holds it. */
type UI = 'LIVE' | 'RECONNECTING' | 'FAILED';

/** Wire a fake room to the same transitions live-view.tsx performs. */
function scenario() {
  const f = fakeRoom();
  let ui: UI = 'LIVE';
  const seen: UI[] = [];
  const set = (s: UI) => { ui = s; seen.push(s); };
  wireConnectionEvents(f.room, {
    onReconnecting: () => set('RECONNECTING'),
    onReconnected: () => set('LIVE'),
    onDisconnected: () => set('FAILED'),
  });
  return { ...f, ui: () => ui, seen };
}

(async () => {
  console.log('\nGo Live connection events — STATIC EVENT TESTS\n');

  // 1. Reconnecting is received.
  {
    const s = scenario();
    s.emit(CONNECTION_EVENTS.reconnecting);
    check('1. Reconnecting reaches the app', s.seen.length === 1);
  }

  // 2. The UI enters RECONNECTING.
  {
    const s = scenario();
    s.emit(CONNECTION_EVENTS.reconnecting);
    check('2. UI enters RECONNECTING', s.ui() === 'RECONNECTING');
  }

  // 3. Reconnected restores LIVE.
  {
    const s = scenario();
    s.emit(CONNECTION_EVENTS.reconnecting);
    s.emit(CONNECTION_EVENTS.reconnected);
    check('3. Reconnected restores LIVE', s.ui() === 'LIVE');
  }

  // 4. Disconnected is terminal.
  {
    const s = scenario();
    s.emit(CONNECTION_EVENTS.disconnected);
    check('4. Disconnected produces FAILED', s.ui() === 'FAILED');
  }

  // 5-8. The negative assertions — the app must do NOTHING but observe.
  {
    const s = scenario();
    s.emit(CONNECTION_EVENTS.reconnecting);
    check('5. Reconnecting does not call connect()', !s.calls.includes('connect'));
    check('6. Reconnecting creates no second room', s.calls.length === 0);
    check('7. Reconnecting publishes no second track', !s.calls.includes('publishTrack'));
    check('8. Reconnecting does not call leave()/disconnect()',
      !s.calls.includes('leave') && !s.calls.includes('disconnect'));
  }

  // 9. Repeated Reconnecting is idempotent — no duplicate state, no teardown.
  {
    const s = scenario();
    for (let i = 0; i < 5; i++) s.emit(CONNECTION_EVENTS.reconnecting);
    check('9. five Reconnecting events leave one state', s.ui() === 'RECONNECTING');
    check('9b. and still touch nothing on the room', s.calls.length === 0);
  }

  // 10. Reconnected after several Reconnecting returns to LIVE.
  {
    const s = scenario();
    for (let i = 0; i < 3; i++) s.emit(CONNECTION_EVENTS.reconnecting);
    s.emit(CONNECTION_EVENTS.reconnected);
    check('10. Reconnected after repeats returns to LIVE', s.ui() === 'LIVE');
    check('10b. and the room was never re-driven', s.calls.length === 0);
  }

  // 11. Disconnected after Reconnecting ends FAILED, not LIVE.
  {
    const s = scenario();
    s.emit(CONNECTION_EVENTS.reconnecting);
    s.emit(CONNECTION_EVENTS.disconnected);
    check('11. Reconnecting then Disconnected ends FAILED', s.ui() === 'FAILED');
  }

  // A recovered blip must not leave the UI stuck: the whole point is that
  // RECONNECTING is temporary, and a host who never returns to LIVE would
  // rather we had said nothing.
  {
    const s = scenario();
    s.emit(CONNECTION_EVENTS.reconnecting);
    s.emit(CONNECTION_EVENTS.reconnected);
    s.emit(CONNECTION_EVENTS.reconnecting);
    s.emit(CONNECTION_EVENTS.reconnected);
    check('12. two full blips end LIVE', s.ui() === 'LIVE');
    check('12b. and each transition was recorded once',
      s.seen.join(',') === 'RECONNECTING,LIVE,RECONNECTING,LIVE');
  }

  // Only the handlers supplied get registered — an absent callback must not
  // register a listener that then calls undefined.
  {
    const f = fakeRoom();
    wireConnectionEvents(f.room, { onReconnecting: () => {} });
    check('13. only supplied handlers register',
      f.listenerCount(CONNECTION_EVENTS.reconnecting) === 1
      && f.listenerCount(CONNECTION_EVENTS.reconnected) === 0
      && f.listenerCount(CONNECTION_EVENTS.disconnected) === 0);
  }

  // The names must match the SDK. This mirrors what room.ts asserts at import
  // time against the real enum; here we prove the assertion actually detects a
  // rename rather than passing unconditionally.
  {
    const warned: string[] = [];
    const orig = console.warn;
    console.warn = (m: any) => { warned.push(String(m)); };
    assertConnectionEventNames({
      Reconnecting: 'reconnecting', Reconnected: 'reconnected', Disconnected: 'disconnected',
    });
    const cleanPass = warned.length === 0;
    assertConnectionEventNames({
      Reconnecting: 'somethingElse', Reconnected: 'reconnected', Disconnected: 'disconnected',
    });
    const caughtDrift = warned.length === 1 && warned[0].includes('Reconnecting');
    console.warn = orig;
    check('14. matching names pass silently', cleanPass);
    check('15. a renamed event is reported', caughtDrift);
  }

  console.log(failures === 0
    ? '\nALL GO LIVE CONNECTION-EVENT CHECKS PASSED ✓\n'
    : `\n${failures} CHECK(S) FAILED ✗\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
