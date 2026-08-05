// lib/family/lockBridge.ts — the ONLY glue between Family Space and the shared
// Location Lock engine (v3 architecture: one engine, two experiences).
//
// Direction of knowledge: this module knows both sides; the engine (lib/lock/*)
// knows nothing about families. When a lock is armed FROM a Family Place, this
// bridge remembers the family context and translates the engine's generic
// events into family-styled alerts in the existing feed ("left Home", "returned
// to Home") via lib/family/alerts — the same feed, screens, and E2EE posture
// Family Space already has. No geofence/alarm/GPS logic lives here.
//
// Radius note: Family Places allow up to 5 km; the lock engine monitors 10 m –
// 1 km (design.md). Arming clamps to the engine range and the UI says so.

import { armLock, onLockEvent, type ArmResult, type LockEvent } from '../lock/lockService';
import { clampRadius } from '../lock/zoneMachine';
import { recordAlert, type AlertKind } from './alerts';
import { type Geofence } from './geofence';

interface FamilyLockCtx {
  circleId: string;
  placeId: string;
  placeName: string;
  myId: string;
  myName: string;
}

let ctx: FamilyLockCtx | null = null;
let unsub: (() => void) | null = null;

function textFor(e: LockEvent, placeName: string): { kind: AlertKind; text: string } | null {
  switch (e.kind) {
    case 'armed':    return { kind: 'sharing', text: `armed a location lock on ${placeName} (${Math.round(e.radius)} m)` };
    case 'exit':     return { kind: 'leave', text: `left ${placeName} — location lock` };
    case 'alarm_start': return { kind: 'leave', text: `ALARM — outside ${placeName} (${Math.round(Math.max(0, e.distance - e.radius))} m past the boundary)` };
    case 'return':   return { kind: 'enter', text: `returned to ${placeName} — safe again` };
    case 'unlocked': return { kind: 'sharing', text: `unlocked ${placeName}` };
    default:         return null;   // 'warning' / 'alarm_stop' — too chatty for the family feed
  }
}

function handle(e: LockEvent): void {
  const c = ctx;
  if (!c || e.placeName !== c.placeName) return;
  const t = textFor(e, c.placeName);
  if (t) {
    recordAlert({ circleId: c.circleId, kind: t.kind, actorId: c.myId, actorName: c.myName, text: t.text }).catch(() => {});
  }
  if (e.kind === 'unlocked') ctx = null;   // family context ends with the session
}

/**
 * Arm the SHARED lock engine on a Family Place, with family alerts wired up.
 * Everything else (zones, alarms, background, history) is the engine's.
 */
export async function armFamilyPlaceLock(o: {
  circleId: string; place: Geofence; myId: string; myName: string;
}): Promise<ArmResult> {
  if (!unsub) unsub = onLockEvent(handle);
  ctx = {
    circleId: o.circleId, placeId: o.place.id, placeName: o.place.name,
    myId: o.myId, myName: o.myName,
  };
  const r = await armLock(o.place.center, clampRadius(o.place.radiusM), { placeName: o.place.name });
  if (!r.ok) ctx = null;
  return r;
}

/** True when the currently armed lock came from this family place. */
export function isFamilyLockFor(placeId: string): boolean {
  return ctx?.placeId === placeId;
}

export default {};
