// lib/call/ownership.selftest.ts — run: npx tsx lib/call/ownership.selftest.ts
//
// A call screen's unmount used to end whatever call was live, not its own.
//
// There is ONE module-wide session in engine.ts, so a second call replaces the
// first: bootstrap hangs the first up as 'replaced' and installs its own. The
// first screen then unmounts — it has just been navigated away from — and its
// cleanup called hangUp() with no idea which call it was ending. By then the
// engine held the NEW call, so answering a second call killed it moments after
// it connected. The symptom points at the second call; the cause is the first
// screen's teardown reaching across into it.
//
// leaveScreen(only) fixes it by refusing to act unless the live session is
// still the one the screen started. This models that rule.

type Ident = { chatId: string; peerUid: string };

class Engine {
  session: Ident | null = null;
  snapshotLive = false;      // mirrors the shared snapshot release()/reset() clears
  hangUps: string[] = [];

  /** bootstrap(): a new call replaces whatever was there. */
  start(id: Ident): void {
    if (this.session) this.hangUps.push(`replaced:${this.session.peerUid}`);
    this.session = id;
    this.snapshotLive = true;
  }

  /** The End button / a socket 'end' — unscoped on purpose. */
  hangUp(): void {
    if (!this.session) return;
    this.hangUps.push(`ended:${this.session.peerUid}`);
    this.session = null;
    this.snapshotLive = false;
  }

  /** The unmount path — must be a no-op unless this screen still owns the call. */
  leaveScreen(only: Ident): void {
    const s = this.session;
    if (s && !(s.chatId === only.chatId && s.peerUid === only.peerUid)) return;
    this.hangUp();
    this.snapshotLive = false;   // release() → reset()
  }
}

let failures = 0;
const check = (name: string, ok: boolean) => { if (!ok) failures++; console.log(`  ${ok ? '✓' : '✗'} ${name}`); };

console.log('\nCall screen ownership\n');

const A: Ident = { chatId: 'chat-a', peerUid: 'alice' };
const B: Ident = { chatId: 'chat-b', peerUid: 'bob' };

// ── THE BUG ───────────────────────────────────────────────────────────
// On a call with Alice, answer Bob, then Alice's screen unmounts.
const e = new Engine();
e.start(A);
e.start(B);                       // answering Bob replaces the session
e.leaveScreen(A);                 // Alice's screen tears down a moment later
check('answering a second call does not end it when the first screen unmounts',
  e.session?.peerUid === 'bob');
check('...and the new call keeps its snapshot, so its UI stays live',
  e.snapshotLive === true);
check('...the first call was ended once, as replaced',
  e.hangUps.filter(h => h === 'replaced:alice').length === 1);
check('...and never ended twice',
  e.hangUps.filter(h => h.endsWith(':alice')).length === 1);

// A live call whose UI has reverted to "ended" is WORSE than the original bug:
// the audio keeps running with no control left to stop it. Scoping hangUp but
// not release() would produce exactly that, which is why leaveScreen scopes both.
check('a stale unmount cannot clear the live call\'s snapshot either',
  e.snapshotLive === true && e.session !== null);

// ── the ordinary case still works ─────────────────────────────────────
const f = new Engine();
f.start(A);
f.leaveScreen(A);                 // the only call, its own screen closing
check('a screen closing its OWN call still ends it', f.session === null);
check('...and clears the snapshot', f.snapshotLive === false);

// ── unscoped paths are unchanged ──────────────────────────────────────
// The End button means "end the current call, whatever it is".
const g = new Engine();
g.start(A);
g.hangUp();
check('the End button still ends the live call', g.session === null);

// ── no call at all ────────────────────────────────────────────────────
const h = new Engine();
h.leaveScreen(A);
check('unmounting with no live call is harmless', h.session === null && h.hangUps.length === 0);

// ── a screen unmounting twice ─────────────────────────────────────────
// React can run a cleanup more than once across a remount; the second must not
// reach into a call started in between.
const i = new Engine();
i.start(A);
i.leaveScreen(A);
i.start(B);
i.leaveScreen(A);                 // the stale second cleanup
check('a repeated stale cleanup cannot end a later call', i.session?.peerUid === 'bob');

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all call-ownership checks passed\n');
process.exit(failures ? 1 : 0);
