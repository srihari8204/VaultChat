// lib/nav/voiceGuide.ts — spoken turn-by-turn (v2: Location Lock Pro / the
// Navigate engine's first voice mode). A pure announcement core decides WHAT
// to say from successive NavBanner states (far cue → "now" cue → arrival →
// rerouting), and a thin impure half speaks it via expo-speech. The nav loop
// only calls feedVoiceGuide(banner) — the tested core stays untouched.
// `npx tsx lib/nav/voiceGuide.ts`

import { type DisplayMode } from './hapticPlayer';

/** Modes in which guidance is spoken (mirror of hapticsAllowed). */
export function voiceAllowed(mode: DisplayMode): boolean {
  return mode === 'everything' || mode === 'voiceVibration' || mode === 'voiceOnly' || mode === 'voiceBanner';
}

export interface VoiceBanner {
  active: boolean;
  instruction: string;
  distanceToManeuver: number;  // m
  remainingM: number;
  rerouting: boolean;
  event: string | null;        // 'destination' when the last maneuver is arrival
}

export interface VoiceState {
  instruction: string;         // instruction the flags below refer to
  saidFar: boolean;            // "In 120 meters, …" spoken
  saidNow: boolean;            // "…now" spoken
  saidReroute: boolean;
  saidArrived: boolean;
}

export const VOICE_IDLE: VoiceState = {
  instruction: '', saidFar: false, saidNow: false, saidReroute: false, saidArrived: false,
};

const NOW_M = 35;              // inside this, speak the immediate cue
const ARRIVE_M = 25;

/** Round a distance into a natural spoken figure (tens → fifties → hundreds). */
export function spokenMeters(m: number): number {
  if (m >= 1000) return Math.round(m / 100) * 100;
  if (m >= 150) return Math.round(m / 50) * 50;
  return Math.round(m / 10) * 10;
}

/** Pure: one banner update → (new state, phrase to speak | null). */
export function nextAnnouncement(prev: VoiceState, b: VoiceBanner): { state: VoiceState; say: string | null } {
  if (!b.active) return { state: VOICE_IDLE, say: null };

  // Rerouting edge (say once per reroute).
  if (b.rerouting) {
    if (prev.saidReroute) return { state: prev, say: null };
    return { state: { ...prev, saidReroute: true }, say: 'Rerouting' };
  }
  const base = prev.saidReroute ? { ...prev, saidReroute: false } : prev;

  // Arrival.
  if (b.event === 'destination' && b.distanceToManeuver <= ARRIVE_M) {
    if (base.saidArrived) return { state: base, say: null };
    return { state: { ...base, saidArrived: true }, say: 'You have arrived' };
  }

  // New maneuver → far cue (or straight to the now-cue when already close).
  if (b.instruction && b.instruction !== base.instruction) {
    const s: VoiceState = { ...VOICE_IDLE, instruction: b.instruction };
    if (b.distanceToManeuver > NOW_M) {
      return { state: { ...s, saidFar: true }, say: `In ${spokenMeters(b.distanceToManeuver)} meters, ${b.instruction}` };
    }
    return { state: { ...s, saidFar: true, saidNow: true }, say: b.instruction };
  }

  // Same maneuver crossing the immediate threshold → now cue.
  if (b.instruction && !base.saidNow && b.distanceToManeuver <= NOW_M) {
    return { state: { ...base, saidNow: true }, say: b.instruction };
  }

  return { state: base, say: null };
}

// ── impure half: session + speech ──
let session: { mode: DisplayMode; state: VoiceState } | null = null;

export function startVoiceGuide(mode: DisplayMode): void {
  session = voiceAllowed(mode) ? { mode, state: VOICE_IDLE } : null;
}

export function stopVoiceGuide(): void {
  session = null;
  try { require('expo-speech').stop(); } catch {}
}

/** Called by the nav loop on every banner publish. Cheap no-op when voice is off. */
export function feedVoiceGuide(b: VoiceBanner): void {
  if (!session) return;
  const { state, say } = nextAnnouncement(session.state, b);
  session.state = state;
  if (say) {
    try {
      const Speech = require('expo-speech');
      Speech.stop();
      Speech.speak(say, { rate: 1.0 });
    } catch { /* TTS unavailable — banner + haptics still guide */ }
  }
}

// ── self-check: `npx tsx lib/nav/voiceGuide.ts` ──
function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('voiceGuide: ' + m); };
  const B = (p: Partial<VoiceBanner>): VoiceBanner => ({
    active: true, instruction: '', distanceToManeuver: 0, remainingM: 500, rerouting: false, event: null, ...p,
  });

  // Far cue once, then the now cue once, no repeats in between.
  let r = nextAnnouncement(VOICE_IDLE, B({ instruction: 'Turn right onto Main St', distanceToManeuver: 120 }));
  A(r.say === 'In 120 meters, Turn right onto Main St', 'far cue');
  r = nextAnnouncement(r.state, B({ instruction: 'Turn right onto Main St', distanceToManeuver: 80 }));
  A(r.say === null, 'no repeat between cues');
  r = nextAnnouncement(r.state, B({ instruction: 'Turn right onto Main St', distanceToManeuver: 30 }));
  A(r.say === 'Turn right onto Main St', 'now cue at threshold');
  r = nextAnnouncement(r.state, B({ instruction: 'Turn right onto Main St', distanceToManeuver: 10 }));
  A(r.say === null, 'now cue only once');

  // New maneuver resets; a close new maneuver goes straight to the now cue.
  r = nextAnnouncement(r.state, B({ instruction: 'Turn left', distanceToManeuver: 25 }));
  A(r.say === 'Turn left', 'close new maneuver → immediate cue');

  // Rerouting announced once per episode, and recovers after.
  r = nextAnnouncement(r.state, B({ instruction: 'Turn left', rerouting: true }));
  A(r.say === 'Rerouting', 'reroute cue');
  r = nextAnnouncement(r.state, B({ instruction: 'Turn left', rerouting: true }));
  A(r.say === null, 'reroute said once');
  r = nextAnnouncement(r.state, B({ instruction: 'Continue', distanceToManeuver: 200 }));
  A(r.say === 'In 200 meters, Continue', 'post-reroute new maneuver speaks');

  // Arrival once; inactive resets everything.
  r = nextAnnouncement(r.state, B({ instruction: 'Arrive', event: 'destination', distanceToManeuver: 12 }));
  A(r.say === 'You have arrived', 'arrival');
  r = nextAnnouncement(r.state, B({ instruction: 'Arrive', event: 'destination', distanceToManeuver: 5 }));
  A(r.say === null, 'arrival said once');
  A(nextAnnouncement(r.state, B({ active: false })).state === VOICE_IDLE, 'inactive resets');

  // Rounding + mode gate.
  A(spokenMeters(117) === 120 && spokenMeters(462) === 450 && spokenMeters(1360) === 1400, 'spoken rounding');
  A(voiceAllowed('everything') && voiceAllowed('voiceOnly') && !voiceAllowed('vibrationOnly') && !voiceAllowed('bannerOnly'), 'mode gate');

  console.log('voiceGuide self-check: OK');
}
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
