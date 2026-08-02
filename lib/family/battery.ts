// lib/family/battery.ts — the battery half of a Family Space presence ping.
//
// `FamilyPing.bat`/`chg` and the roster's battery chip (app/family.tsx) were both
// written against this data, but nothing ever produced it — every "70%" in the UI
// was dead code. This is the producer.
//
// expo-battery is already a declared dependency; it is required lazily so this
// module stays importable from the background task (and from tsx) even where the
// native module is unavailable — a missing battery reading degrades to
// `undefined`, which the ping and the roster chip both already handle.

let cached: { level?: number; charging?: boolean; at: number } = { at: 0 };

/** Re-read at most this often — battery moves slowly and each call is a bridge hop. */
export const BATTERY_TTL_MS = 60_000;

export interface BatteryReading { level?: number; charging?: boolean }

/** Best-effort battery state. Never throws; returns {} when unavailable. */
export async function readBattery(now = Date.now()): Promise<BatteryReading> {
  if (now - cached.at < BATTERY_TTL_MS) return { level: cached.level, charging: cached.charging };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Battery = require('expo-battery');
    const [lvl, state] = await Promise.all([
      Battery.getBatteryLevelAsync(),
      Battery.getBatteryStateAsync(),
    ]);
    // getBatteryLevelAsync returns 0..1, or -1 when the platform can't tell.
    const level = typeof lvl === 'number' && lvl >= 0 ? Math.round(lvl * 100) : undefined;
    const charging = state === Battery.BatteryState?.CHARGING || state === Battery.BatteryState?.FULL;
    cached = { level, charging, at: now };
  } catch {
    cached = { at: now };   // cache the failure too, so we don't retry every fix
  }
  return { level: cached.level, charging: cached.charging };
}

/** Drop the cache (used when presence restarts, and by tests). */
export function resetBatteryCache(): void { cached = { at: 0 }; }

/** True when a reading warrants a "low battery" family alert. */
export const LOW_BATTERY_PCT = 15;
export function isLowBattery(r: BatteryReading): boolean {
  return r.level != null && r.level <= LOW_BATTERY_PCT && !r.charging;
}

// ── self-check ──
if (require.main === module) {
  if (!isLowBattery({ level: 10 })) throw new Error('10% must be low');
  if (isLowBattery({ level: 10, charging: true })) throw new Error('charging is never low');
  if (isLowBattery({ level: 80 })) throw new Error('80% is not low');
  if (isLowBattery({})) throw new Error('unknown level is not low');
  // expo-battery is absent under tsx → must degrade, not throw
  readBattery().then((r) => {
    if (r.level !== undefined) throw new Error('expected no reading without the native module');
    console.log('family/battery self-check OK');
  });
}
