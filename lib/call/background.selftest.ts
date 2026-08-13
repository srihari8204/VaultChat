// lib/call/background.selftest.ts — run: npx tsx lib/call/background.selftest.ts
//
// What happens to the camera when a call leaves the foreground.
//
// Nothing did, before this: a backgrounded video call kept encoding and
// uploading frames nobody could see. The subtlety is not the suspend, it is the
// RESTORE — getting that wrong silently turns someone's camera back on, which
// is a privacy failure, not a bug.
//
// Mirrors the AppState handler in bootstrap(). Pure, runs in Node.

type State = 'active' | 'background' | 'inactive';

class CallVideo {
  cameraSending = true;      // is the encoder actually running
  cameraOff = false;         // the USER's choice
  sharing = false;
  private suspended = false;

  onAppState(st: State): void {
    if (st === 'background') {
      if (this.suspended || this.cameraOff || this.sharing) return;
      this.cameraSending = false;
      this.suspended = true;
    } else if (st === 'active' && this.suspended) {
      this.suspended = false;
      if (!this.cameraOff) this.cameraSending = true;
    }
  }
  /** The user tapping the camera button. */
  userToggle(): void {
    this.cameraOff = !this.cameraOff;
    this.cameraSending = !this.cameraOff;
  }
}

let failures = 0;
const check = (name: string, ok: boolean) => { if (!ok) failures++; console.log(`  ${ok ? '✓' : '✗'} ${name}`); };

console.log('\nBackground video suspend/restore\n');

// ── the whole point ───────────────────────────────────────────────────
const a = new CallVideo();
a.onAppState('background');
check('backgrounding stops the camera', !a.cameraSending);
a.onAppState('active');
check('returning restores it', a.cameraSending);

// ── iOS transient state must not flicker the peer's view ──────────────
const b = new CallVideo();
b.onAppState('inactive');
check('`inactive` does NOT stop the camera', b.cameraSending);

// ── the privacy case: never re-enable what the user turned off ────────
const c = new CallVideo();
c.userToggle();                       // user turns video OFF
check('user turned the camera off', !c.cameraSending && c.cameraOff);
c.onAppState('background');
c.onAppState('active');
check('returning does NOT switch their camera back on', !c.cameraSending);

// ── user turns video off WHILE backgrounded ───────────────────────────
const d = new CallVideo();
d.onAppState('background');
d.cameraOff = true;                   // choice made from a notification control
d.onAppState('active');
check('a choice made while backgrounded is respected', !d.cameraSending);

// ── screen share is exempt ────────────────────────────────────────────
const e = new CallVideo();
e.sharing = true;
e.onAppState('background');
check('screen share keeps sending in the background', e.cameraSending);

// ── repeated events must not corrupt state ────────────────────────────
const f = new CallVideo();
f.onAppState('background');
f.onAppState('background');
f.onAppState('active');
check('double background then active still restores', f.cameraSending);

const g = new CallVideo();
g.onAppState('active');               // active with nothing suspended
check('a spurious active does not change anything', g.cameraSending);

// ── an audio call has no camera to begin with ─────────────────────────
const h = new CallVideo();
h.cameraOff = true; h.cameraSending = false;
h.onAppState('background');
h.onAppState('active');
check('an audio-only call is unaffected', !h.cameraSending);

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all background-video checks passed\n');
process.exit(failures ? 1 : 0);
