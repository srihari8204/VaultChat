// lib/lock/alarmController.ts — the alarm brain. Decides WHEN channels start,
// repeat, and stop; never touches a speaker/motor itself. Real playback lives
// in alarmChannels.ts and is injected as drivers, timers are injected too —
// so every spec behavior (grace window, repeat-until-return, one-cycle mode,
// manual stop, auto stop on return, test mode) is verified by the self-check
// below with fake drivers and a fake clock. `npx tsx lib/lock/alarmController.ts`.

import { type LockAlertSettings, type LockTone, type LockVibe } from './lockSettings';
import { type ZoneEvent } from './zoneMachine';

export type AlarmPhase =
  | 'idle'       // inside, nothing pending
  | 'grace'      // exit detected, counting down before the alarm
  | 'alarming'   // alarm active (sound may be over in one-cycle mode, alert stays)
  | 'silenced';  // user hit Stop Alarm while still outside

export interface AlarmDrivers {
  /** Begin the looped siren/beep at the given volume. Idempotent. */
  startTone(tone: LockTone, volume: number): void;
  stopTone(): void;
  /** Begin the looped vibration pattern. Idempotent. */
  startVibe(pattern: LockVibe): void;
  stopVibe(): void;
  /** Speak a short warning (no-op when voice is off at the driver level). */
  speak(text: string): void;
  /** Phase changed — UI + notification layer react here. */
  onPhase(phase: AlarmPhase): void;
}

export interface AlarmTimers {
  set(fn: () => void, ms: number): unknown;
  clear(h: unknown): void;
}

const REAL_TIMERS: AlarmTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as any),
};

export const VOICE = {
  warning: 'Approaching boundary',
  outside: 'Alert. You have left the locked area',
  back: 'You are back inside the safe zone',
};

/** One alarm "cycle" in one-shot (no-repeat) mode before sound stops. */
const ONE_CYCLE_MS = 8_000;
const TEST_MS = 4_000;

export interface AlarmController {
  phase(): AlarmPhase;
  configure(alerts: LockAlertSettings): void;
  /** Feed zone transitions (from zoneMachine) into the alarm logic. */
  onZoneEvent(ev: ZoneEvent): void;
  /** Manual "Stop Alarm": silence channels, stay armed, remember we're outside. */
  stopAlarm(): void;
  /** Play the configured channels briefly with no armed lock. */
  test(): void;
  /** Tear down timers + channels (unlock / unmount). */
  dispose(): void;
}

export function createAlarmController(
  drivers: AlarmDrivers,
  alerts: LockAlertSettings,
  timers: AlarmTimers = REAL_TIMERS,
): AlarmController {
  let cfg = alerts;
  let phase: AlarmPhase = 'idle';
  let graceH: unknown = null;
  let repeatH: unknown = null;
  let cycleH: unknown = null;
  let testH: unknown = null;

  const setPhase = (p: AlarmPhase) => { if (p !== phase) { phase = p; drivers.onPhase(p); } };

  const clearTimersAll = () => {
    for (const h of [graceH, repeatH, cycleH]) if (h) timers.clear(h);
    graceH = repeatH = cycleH = null;
  };

  const stopChannels = () => { drivers.stopTone(); drivers.stopVibe(); };

  const startChannels = () => {
    // Tone: the siren channel wins; continuous-beep alone plays the beep tone.
    if (cfg.siren) drivers.startTone(cfg.tone, cfg.volume);
    else if (cfg.continuousBeep) drivers.startTone('beep', cfg.volume);
    if (cfg.vibration) drivers.startVibe(cfg.vibePattern);
    if (cfg.voice) drivers.speak(VOICE.outside);
  };

  const fire = () => {
    graceH = null;
    setPhase('alarming');
    startChannels();
    if (cfg.repeat) {
      // The tone/vibe already loop; the repeat tick re-asserts them (in case the
      // OS stopped audio) and re-speaks the voice line until the user returns.
      const tick = () => {
        if (phase !== 'alarming') return;
        startChannels();
        repeatH = timers.set(tick, Math.max(3, cfg.repeatIntervalS) * 1000);
      };
      repeatH = timers.set(tick, Math.max(3, cfg.repeatIntervalS) * 1000);
    } else {
      // One full cycle of sound, then quiet — but the alert + notification stay
      // up (phase remains 'alarming') until return or manual stop.
      cycleH = timers.set(() => { cycleH = null; stopChannels(); }, ONE_CYCLE_MS);
    }
  };

  return {
    phase: () => phase,
    configure(a) { cfg = a; },

    onZoneEvent(ev) {
      if (ev === 'enterWarning') {
        // Gentle pre-alert, never the main alarm. zoneMachine already
        // guarantees one per approach.
        if (cfg.vibration) { drivers.startVibe('pulse'); timers.set(() => { if (phase === 'idle') drivers.stopVibe(); }, 600); }
        if (cfg.voice) drivers.speak(VOICE.warning);
        return;
      }
      if (ev === 'exit') {
        if (phase === 'alarming' || phase === 'silenced' || phase === 'grace') return;
        const graceMs = Math.max(0, Math.min(60, cfg.graceS)) * 1000;
        if (graceMs === 0) { fire(); return; }
        setPhase('grace');
        graceH = timers.set(fire, graceMs);
        return;
      }
      if (ev === 'return') {
        // Any state → idle. During grace this cancels silently (spec).
        const wasAlarming = phase === 'alarming';
        clearTimersAll();
        stopChannels();
        setPhase('idle');
        if (wasAlarming && cfg.voice) drivers.speak(VOICE.back);
      }
    },

    stopAlarm() {
      if (phase !== 'alarming' && phase !== 'grace') return;
      clearTimersAll();
      stopChannels();
      setPhase('silenced');   // still outside; lock stays armed, alert stays visible
    },

    test() {
      if (testH) timers.clear(testH);
      startChannels();
      testH = timers.set(() => { testH = null; if (phase === 'idle' || phase === 'silenced') stopChannels(); }, TEST_MS);
    },

    dispose() {
      clearTimersAll();
      if (testH) { timers.clear(testH); testH = null; }
      stopChannels();
      phase = 'idle';
    },
  };
}

// ── self-check: `npx tsx lib/lock/alarmController.ts` ──
function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('alarmController: ' + m); };

  // Fake timers: run due callbacks by advancing a virtual clock.
  const pend: { fn: () => void; at: number }[] = [];
  let now = 0;
  const timers: AlarmTimers = {
    set: (fn, ms) => { const e = { fn, at: now + ms }; pend.push(e); return e; },
    clear: (h) => { const i = pend.indexOf(h as any); if (i >= 0) pend.splice(i, 1); },
  };
  const advance = (ms: number) => {
    // Step the clock to each due timer in order, so callbacks that reschedule
    // themselves (the repeat tick) keep firing inside the window.
    const end = now + ms;
    for (;;) {
      const due = pend.filter((e) => e.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      pend.splice(pend.indexOf(due), 1);
      now = due.at;
      due.fn();
    }
    now = end;
  };

  // Fake drivers: record everything.
  const log: string[] = [];
  const drivers: AlarmDrivers = {
    startTone: (t, v) => log.push(`tone:${t}@${v}`),
    stopTone: () => log.push('tone:stop'),
    startVibe: (p) => log.push(`vibe:${p}`),
    stopVibe: () => log.push('vibe:stop'),
    speak: (s) => log.push(`say:${s}`),
    onPhase: (p) => log.push(`phase:${p}`),
  };
  const base = {
    siren: true, continuousBeep: true, vibration: true, voice: true, flash: true,
    volume: 1, tone: 'siren' as LockTone, vibePattern: 'strong' as LockVibe,
    graceS: 5, repeat: true, repeatIntervalS: 10,
  };

  // Grace: exit → nothing for 5 s → alarm fires with all channels.
  let c = createAlarmController(drivers, { ...base }, timers);
  c.onZoneEvent('exit');
  A(c.phase() === 'grace', 'grace starts on exit');
  A(!log.some((l) => l.startsWith('tone:siren')), 'silent during grace');
  advance(5000);
  A(c.phase() === 'alarming', 'alarm after grace');
  A(log.includes('tone:siren@1') && log.includes('vibe:strong') && log.some((l) => l.startsWith('say:Alert')), 'all channels fire');

  // Repeat: while outside, the cycle keeps re-asserting.
  const tones = () => log.filter((l) => l === 'tone:siren@1').length;
  const before = tones();
  advance(30_000);
  A(tones() >= before + 2, 'repeat re-fires while outside');

  // Auto-stop on return + spoken confirmation.
  c.onZoneEvent('return');
  A(c.phase() === 'idle', 'return → idle');
  A(log.includes('tone:stop') && log.includes('vibe:stop'), 'channels stopped');
  A(log.some((l) => l.includes('back inside')), 'return confirmation spoken');
  const after = tones();
  advance(60_000);
  A(tones() === after, 'no re-fire after return');

  // Grace re-entry cancels silently: no alarm, no "back inside" line.
  log.length = 0;
  c.onZoneEvent('exit');
  advance(2000);
  c.onZoneEvent('return');
  advance(60_000);
  A(!log.some((l) => l.startsWith('tone:siren')), 'grace re-entry never alarms');
  A(!log.some((l) => l.includes('back inside')), 'grace cancel is silent');
  A(c.phase() === 'idle', 'back to idle');

  // Manual stop: channels stop, phase 'silenced', repeat dead — but a later
  // return still resolves to idle.
  log.length = 0;
  c.onZoneEvent('exit');
  advance(5000);
  A(c.phase() === 'alarming', 'alarming again');
  c.stopAlarm();
  A(c.phase() === 'silenced', 'manual stop → silenced');
  const quiet = log.filter((l) => l.startsWith('tone:siren')).length;
  advance(60_000);
  A(log.filter((l) => l.startsWith('tone:siren')).length === quiet, 'silenced: no more sound');
  c.onZoneEvent('return');
  A(c.phase() === 'idle', 'silenced → return → idle');

  // One-cycle mode: sound stops after the cycle, phase stays alarming.
  log.length = 0;
  c = createAlarmController(drivers, { ...base, repeat: false, graceS: 0 }, timers);
  c.onZoneEvent('exit');
  A(c.phase() === 'alarming', 'graceS=0 fires immediately');
  advance(ONE_CYCLE_MS + 1);
  A(log.includes('tone:stop'), 'one-cycle sound ends');
  A(c.phase() === 'alarming', 'alert persists after the cycle');

  // Warning pre-alert: gentle vibe + voice, no siren, phase unchanged.
  log.length = 0;
  c = createAlarmController(drivers, { ...base }, timers);
  c.onZoneEvent('enterWarning');
  A(log.includes('vibe:pulse') && log.some((l) => l.includes('Approaching')), 'pre-alert vibe+voice');
  A(!log.some((l) => l.startsWith('tone:')), 'pre-alert has no tone');
  A(c.phase() === 'idle', 'pre-alert leaves phase idle');

  // Vibration-only config: no tone, no voice — vibe only.
  log.length = 0;
  c = createAlarmController(drivers, { ...base, siren: false, continuousBeep: false, voice: false, graceS: 0 }, timers);
  c.onZoneEvent('exit');
  A(log.includes('vibe:strong') && !log.some((l) => l.startsWith('tone:siren') || l.startsWith('tone:beep')), 'vibration-only');

  // Beep fallback: siren off, continuousBeep on → beep tone.
  log.length = 0;
  c = createAlarmController(drivers, { ...base, siren: false, graceS: 0 }, timers);
  c.onZoneEvent('exit');
  A(log.some((l) => l.startsWith('tone:beep')), 'beep fallback tone');

  // Test mode: channels fire and auto-stop; phase never leaves idle.
  log.length = 0;
  c = createAlarmController(drivers, { ...base }, timers);
  c.test();
  A(log.includes('tone:siren@1'), 'test plays');
  A(c.phase() === 'idle', 'test does not change phase');
  advance(TEST_MS + 1);
  A(log.includes('tone:stop'), 'test auto-stops');

  console.log('alarmController self-check: OK');
}
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
