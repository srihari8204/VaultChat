// lib/family/types.ts — the Family Circle data model.
//
// Trust boundary: the ONLY thing that ever leaves the device is a FamilyPing,
// and only sealed (see liveLocationCrypto.sealJSON). MemberPresence is the
// decrypted, in-memory view — it is never sent anywhere or persisted server-side.
// Circles ride on top of existing groups; a Circle's id IS its group/chat id.

// `import type` (not `import { type … }`): both are erased by the bundler, but
// only this form leaves NO runtime import behind, which keeps types.ts loadable
// by pure/self-check runners that don't provide CommonJS globals.
import type { LatLng } from '../nav/geo';
import type { Geofence } from './geofence';

/**
 * ONE reference distance, derived on the device that owns the place.
 *
 * `n` is the place's NAME ("Home", "Business", "School") and `d` is metres.
 * The place's COORDINATE is deliberately absent and must never be added: the
 * whole point of publishing a derived number is that a member can be shown as
 * "1.2 km from Home" without anyone else learning where their home is.
 */
export interface RefDistance {
  n: string;       // place name, as the owner named it
  d: number;       // metres, straight-line, rounded
}

/** The sealed per-member payload relayed over the socket. Kept tiny. */
export interface FamilyPing {
  lat: number;
  lng: number;
  bat?: number;    // battery 0..100
  chg?: boolean;   // charging
  spd?: number;    // m/s (for a "driving" hint)
  acc?: number;    // GPS accuracy, m (member quality chip; optional → old pings fine)
  ts: number;      // epoch ms of the GPS fix
  /**
   * Distances from MY OWN saved places, computed here, chosen reference first.
   * Optional — pings from older builds simply carry none and the viewer shows
   * distance-from-me alone.
   */
  refs?: RefDistance[];
}

export type CircleRole = 'member' | 'guardian';

export interface CircleMember {
  id: string;               // user id
  name: string;
  avatar?: string | null;
  role: CircleRole;
}

export interface Circle {
  id: string;               // === the underlying group/chat id
  name: string;
  members: CircleMember[];
  inviteCode?: string | null;
  places: Geofence[];       // per-circle "Places" (geofences), on-device only
}

/** Decrypted, live, in-memory only. Never persisted server-side. */
export interface MemberPresence {
  userId: string;
  pos: LatLng;
  battery?: number;
  charging?: boolean;
  speed?: number;
  accuracy?: number;        // m, when the ping carried it
  ts: number;               // last fix epoch ms
  /**
   * The member EXPLICITLY stopped sharing (a stop event arrived). The last
   * fix is retained — Life360-style "last known" — but must never render as
   * LIVE and must be labelled as sharing-off, not as silence. Any fresh fix
   * clears it (a new presence object carries no flag).
   */
  sharingOff?: boolean;
  /**
   * What this member published about their own reference places, their chosen
   * default first. Absent for members on older builds, and for positions that
   * arrived via the server ingest path (which carries no refs by design — see
   * lib/location/publisher.ts).
   */
  refs?: RefDistance[];
}

export interface FamilySettings {
  sharing: boolean;         // am I broadcasting my location to my circles
  intervalMs: number;       // publish cadence while moving
  /**
   * High-speed alert for MY OWN device (spec: speed alerts). Detected on the
   * emitting device — the server cannot read a position, let alone a speed.
   * Optional so settings stored before this existed keep parsing; absent means
   * disabled. Recipients are the circle (same announce path as geofences).
   */
  speedAlert?: { enabled: boolean; thresholdKmh: number };
  /**
   * Which of MY places leads my published reference distance, per circle
   * (circleId → place name). Nothing is inferred: a member picks this, and the
   * spec is explicit that it must never be guessed from relationship, age or
   * occupation. Absent means no choice yet — the first saved place leads, and
   * the picker still offers every place they have.
   *
   * Per-circle because Places are per-circle: "Business" may be the reference
   * that matters to the shop's circle while "Home" leads for the family's.
   */
  defaultRef?: Record<string, string>;
}

export const DEFAULT_FAMILY_SETTINGS: FamilySettings = { sharing: false, intervalMs: 8000 };

/** Threshold choices the settings row cycles through, km/h. */
export const SPEED_ALERT_CHOICES = [60, 80, 100, 120] as const;
export const DEFAULT_SPEED_ALERT_KMH = 80;

/** A member's fix is "stale" (dimmed on the map) once older than this. */
export const STALE_MS = 90_000;
