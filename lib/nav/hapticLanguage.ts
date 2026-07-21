// lib/nav/hapticLanguage.ts — the vibration "language": every navigation event
// maps to a distinct pattern, grouped into the Direction-Lock profiles the user
// picks before a trip. Pure DATA + a resolver — no RN import, so the whole
// language is testable and can be previewed in the profile picker. Playback lives
// in hapticPlayer.ts.
//
// Pattern format = react-native Vibration timeline: [waitBeforeFirst, on, off,
// on, off, …] in ms. `intensity` is an accent hint (expo-haptics impact for the
// leading pulse on devices without amplitude control). Profiles that omit an
// event stay SILENT for it — that's how "Minimal" is minimal.

export type HapticEvent =
  // maneuvers
  | 'left' | 'right' | 'slightLeft' | 'slightRight' | 'uturn' | 'roundabout' | 'destination'
  // system
  | 'reroute' | 'missedTurn' | 'confirm'
  // approach stages (notificationTimeline)
  | 'soft' | 'medium' | 'strong'
  // rider / safety extras
  | 'lane' | 'speedCamera' | 'sharpCurve' | 'tollBooth' | 'fuelStop' | 'railway' | 'accident';

export type Intensity = 'light' | 'medium' | 'heavy';

export interface HapticPattern {
  pattern: number[];            // ms: [wait, on, off, on, …]
  intensity: Intensity;         // accent for the leading pulse
  repeat?: number;              // extra whole-pattern repeats (0 = once)
  loopUntilCleared?: boolean;   // buzz until the condition clears (e.g. missed turn)
}

export type NavProfile = 'standard' | 'strong' | 'minimal' | 'rider' | 'custom';

const P = (pattern: number[], intensity: Intensity, extra: Partial<HapticPattern> = {}): HapticPattern =>
  ({ pattern, intensity, ...extra });

// Shared approach stages + confirm reused by several profiles.
const APPROACH = { soft: P([0, 120], 'light'), medium: P([0, 250], 'medium'), strong: P([0, 450], 'heavy') };
const CONFIRM = { confirm: P([0, 90], 'light') };

export const PROFILES: Record<Exclude<NavProfile, 'custom'>, Partial<Record<HapticEvent, HapticPattern>>> = {
  // Standard (recommended): left = 1 long, right = 2 short, U = long+3 short, dest = long·pause·long
  standard: {
    left:  P([0, 600], 'medium'),
    right: P([0, 150, 120, 150], 'medium'),
    slightLeft:  P([0, 300], 'light'),
    slightRight: P([0, 120, 100, 120], 'light'),
    uturn: P([0, 600, 200, 150, 120, 150, 120, 150], 'heavy'),
    roundabout: P([0, 200, 150, 200, 150, 200], 'medium'),
    destination: P([0, 500, 300, 500], 'medium'),
    reroute: P([0, 200, 150, 200], 'medium'),
    missedTurn: P([0, 400, 200, 400], 'heavy'),
    ...APPROACH, ...CONFIRM,
  },
  // Strong Direction Lock — very clear feedback for riders/drivers.
  strong: {
    left:  P([0, 250, 120, 250, 120, 250], 'heavy'),   // 3 strong pulses
    right: P([0, 500, 200, 500], 'heavy'),             // 2 long pulses
    slightLeft:  P([0, 250, 120, 250], 'heavy'),
    slightRight: P([0, 500], 'heavy'),
    uturn: P([0, 2000], 'heavy'),                       // continuous 2 s
    roundabout: P([0, 300, 150, 300, 150, 300], 'heavy'),
    destination: P([0, 700, 300, 700], 'heavy'),
    reroute: P([0, 300, 150, 300], 'heavy'),
    missedTurn: P([0, 500, 200, 500], 'heavy', { loopUntilCleared: true }), // repeat until rerouted
    soft: P([0, 200], 'medium'), medium: P([0, 350], 'heavy'), strong: P([0, 600], 'heavy'),
    ...CONFIRM,
  },
  // Minimal — only the essentials, nothing informational.
  minimal: {
    left:  P([0, 500], 'medium'),
    right: P([0, 150, 120, 150], 'medium'),
    uturn: P([0, 500, 200, 150, 120, 150], 'heavy'),
    destination: P([0, 500, 300, 500], 'medium'),
    strong: P([0, 400], 'heavy'),                       // single pre-turn alert only
  },
  // Advanced Rider — standard turns + the extras a motorcyclist wants.
  rider: {
    left:  P([0, 600], 'heavy'),
    right: P([0, 200, 150, 200], 'heavy'),
    slightLeft:  P([0, 300], 'medium'),
    slightRight: P([0, 150, 120, 150], 'medium'),
    uturn: P([0, 600, 200, 150, 120, 150, 120, 150], 'heavy'),
    roundabout: P([0, 250, 150, 250, 150, 250], 'heavy'),
    destination: P([0, 600, 300, 600], 'heavy'),
    reroute: P([0, 250, 150, 250], 'heavy'),
    missedTurn: P([0, 450, 200, 450], 'heavy', { loopUntilCleared: true }),
    lane:       P([0, 100, 80, 100], 'light'),
    speedCamera:P([0, 120, 80, 120, 80, 120, 80, 120], 'medium'),
    sharpCurve: P([0, 350, 150, 350], 'heavy'),
    tollBooth:  P([0, 200, 120, 100], 'medium'),
    fuelStop:   P([0, 100, 100, 100, 100, 100], 'light'),
    railway:    P([0, 300, 100, 300, 100, 300], 'heavy'),
    accident:   P([0, 500, 150, 500, 150, 500], 'heavy'),
    ...APPROACH, ...CONFIRM,
  },
};

// Essentials every profile MUST define (the invariant a custom profile must meet).
export const ESSENTIAL_EVENTS: HapticEvent[] = ['left', 'right', 'uturn', 'destination'];

/**
 * Resolve an event → its pattern for the active profile. `custom` is the user's
 * saved map (used when profile === 'custom', and as a per-event override for any
 * profile). Undefined ⇒ this profile deliberately stays silent for that event.
 */
export function resolveHaptic(
  profile: NavProfile,
  event: HapticEvent,
  custom?: Partial<Record<HapticEvent, HapticPattern>>,
): HapticPattern | undefined {
  if (custom && custom[event]) return custom[event];
  if (profile === 'custom') return custom?.[event];
  return PROFILES[profile][event];
}

/** Validate a (custom) profile has the essentials + well-formed patterns. */
export function validateProfile(map: Partial<Record<HapticEvent, HapticPattern>>): string[] {
  const errs: string[] = [];
  for (const e of ESSENTIAL_EVENTS) if (!map[e]) errs.push(`missing essential: ${e}`);
  for (const [e, p] of Object.entries(map)) {
    if (!p || !Array.isArray(p.pattern) || p.pattern.length < 2) errs.push(`bad pattern: ${e}`);
    else if (p.pattern.some((n) => typeof n !== 'number' || n < 0 || n > 10_000)) errs.push(`pattern out of range: ${e}`);
  }
  return errs;
}

// ── self-check: `npx tsx lib/nav/hapticLanguage.ts` ──
function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('hapticLanguage: ' + m); };

  // every built-in profile satisfies the essentials + is well-formed
  for (const name of Object.keys(PROFILES) as (keyof typeof PROFILES)[]) {
    A(validateProfile(PROFILES[name]).length === 0, `${name} valid`);
  }
  // distinctiveness: left ≠ right pattern in each profile (or they'd be ambiguous)
  for (const name of Object.keys(PROFILES) as (keyof typeof PROFILES)[]) {
    const l = JSON.stringify(PROFILES[name].left), r = JSON.stringify(PROFILES[name].right);
    A(l !== r, `${name}: left != right`);
  }
  // spec fidelity
  A(JSON.stringify(PROFILES.strong.uturn!.pattern) === JSON.stringify([0, 2000]), 'strong U-turn = continuous 2s');
  A(PROFILES.strong.missedTurn!.loopUntilCleared === true, 'strong missed-turn loops');
  A(!!PROFILES.rider.speedCamera && !!PROFILES.rider.railway, 'rider has speedCamera + railway');
  A(!PROFILES.minimal.roundabout && !PROFILES.minimal.speedCamera, 'minimal omits informational events');

  // resolver: custom override beats profile; missing ⇒ undefined
  const custom = { left: P([0, 999], 'light') };
  A(resolveHaptic('standard', 'left', custom)!.pattern[1] === 999, 'custom overrides');
  A(resolveHaptic('minimal', 'roundabout') === undefined, 'minimal roundabout silent');

  // a custom profile missing an essential fails validation
  A(validateProfile({ left: P([0, 100], 'light') }).some((e) => e.includes('destination')), 'catches missing essential');

  console.log('hapticLanguage self-check: OK');
}
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
