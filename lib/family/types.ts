// lib/family/types.ts — the Family Circle data model.
//
// Trust boundary: the ONLY thing that ever leaves the device is a FamilyPing,
// and only sealed (see liveLocationCrypto.sealJSON). MemberPresence is the
// decrypted, in-memory view — it is never sent anywhere or persisted server-side.
// Circles ride on top of existing groups; a Circle's id IS its group/chat id.

import { type LatLng } from '../nav/geo';
import { type Geofence } from './geofence';

/** The sealed per-member payload relayed over the socket. Kept tiny. */
export interface FamilyPing {
  lat: number;
  lng: number;
  bat?: number;    // battery 0..100
  chg?: boolean;   // charging
  spd?: number;    // m/s (for a "driving" hint)
  acc?: number;    // GPS accuracy, m (member quality chip; optional → old pings fine)
  ts: number;      // epoch ms of the GPS fix
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
}

export const DEFAULT_FAMILY_SETTINGS: FamilySettings = { sharing: false, intervalMs: 8000 };

/** Threshold choices the settings row cycles through, km/h. */
export const SPEED_ALERT_CHOICES = [60, 80, 100, 120] as const;
export const DEFAULT_SPEED_ALERT_KMH = 80;

/** A member's fix is "stale" (dimmed on the map) once older than this. */
export const STALE_MS = 90_000;
