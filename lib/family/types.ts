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
  ts: number;               // last fix epoch ms
}

export interface FamilySettings {
  sharing: boolean;         // am I broadcasting my location to my circles
  intervalMs: number;       // publish cadence while moving
}

export const DEFAULT_FAMILY_SETTINGS: FamilySettings = { sharing: false, intervalMs: 8000 };

/** A member's fix is "stale" (dimmed on the map) once older than this. */
export const STALE_MS = 90_000;
