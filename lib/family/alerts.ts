// lib/family/alerts.ts — the Family Space alert inbox (mockup screen 23).
//
// Why this exists: until now every family event was a plain `sendMessage(...,
// 'system')` into the circle thread, so "Rohan left School" was indistinguishable
// from chat and had no read state, no severity and no filter. This is a typed,
// device-local inbox: geofence crossings, check-ins, SOS, low battery and
// sharing-stopped events land here with a severity and an unread flag.
//
// Device-local by construction. Alerts are DERIVED from things this device
// already knows (its own geofence evaluation, already-decrypted pings, messages
// already decrypted for the thread). Nothing here is uploaded, and the store
// stays readable only on this device — same DEK as the message cache.
//
// A tiny external store (useSyncExternalStore, matching lib/nav/navSettings.ts)
// so the tab badge and the alerts screen read one source of truth.

import { useSyncExternalStore } from 'react';

// Storage is lazy-required (not top-imported) so the selectors below stay free of
// the react-native graph and the self-check runs under tsx — see lib/nav/routing.ts.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const storage = () => require('@react-native-async-storage/async-storage').default;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const crypt = () => require('../cacheCrypto') as typeof import('../cacheCrypto');

export type AlertKind =
  | 'enter' | 'leave'        // geofence crossings
  | 'sos' | 'checkin'        // people
  | 'battery' | 'sharing';   // device state

export type AlertSeverity = 'critical' | 'important' | 'info';

export interface FamilyAlert {
  id: string;
  circleId: string;
  kind: AlertKind;
  sev: AlertSeverity;
  actorId: string;
  actorName: string;
  text: string;              // already-rendered one-liner
  at: number;                // epoch ms
  read: boolean;
}

/** The three tabs the alerts screen shows. */
export type AlertFilter = 'all' | 'important' | 'system';

const KEY = 'vc_family_alerts_v1';
const MAX_ALERTS = 300;
/** Kinds that count as "system" rather than a person doing something. */
const SYSTEM_KINDS: AlertKind[] = ['battery', 'sharing'];

export const SEVERITY_OF: Record<AlertKind, AlertSeverity> = {
  sos: 'critical',
  battery: 'important',
  leave: 'important',
  enter: 'info',
  checkin: 'info',
  sharing: 'info',
};

// ── in-memory mirror + subscribers ──
let alerts: FamilyAlert[] = [];
let loaded = false;
const subs = new Set<() => void>();
// version is bumped BEFORE notifying so any getSnapshot() that runs synchronously
// inside a subscriber already sees the invalidated cache (see snapshotFor).
const emit = () => { version++; subs.forEach((c) => { try { c(); } catch {} }); };

async function persist(): Promise<void> {
  try {
    const sealed = crypt().encField(JSON.stringify({ v: 1, a: alerts }));
    if (sealed != null) await storage().setItem(KEY, sealed);
  } catch { /* best-effort */ }
}

export async function loadAlerts(): Promise<FamilyAlert[]> {
  if (loaded) return alerts;
  loaded = true;
  try {
    const raw = await storage().getItem(KEY);
    const json = raw ? crypt().decField(raw) : null;
    const parsed = json ? JSON.parse(json) : null;
    if (Array.isArray(parsed?.a)) alerts = parsed.a as FamilyAlert[];
  } catch { /* start empty */ }
  emit();
  return alerts;
}

/** Dedupe key — the same crossing re-evaluated must not stack up. */
const dedupeKey = (a: Pick<FamilyAlert, 'circleId' | 'kind' | 'actorId' | 'text'>) =>
  `${a.circleId}|${a.kind}|${a.actorId}|${a.text}`;

/** Suppress a repeat of the identical alert inside this window. */
export const DEDUPE_MS = 60_000;

export interface RecordAlertInput {
  circleId: string;
  kind: AlertKind;
  actorId: string;
  actorName: string;
  text: string;
  at?: number;
}

/** Append an alert. Returns the stored alert, or null when deduped. */
export async function recordAlert(input: RecordAlertInput): Promise<FamilyAlert | null> {
  await loadAlerts();
  const at = input.at ?? Date.now();
  const key = dedupeKey(input);
  const dup = alerts.find((a) => dedupeKey(a) === key && Math.abs(at - a.at) < DEDUPE_MS);
  if (dup) return null;

  const alert: FamilyAlert = {
    id: `a_${at}_${Math.round(Math.random() * 1e6)}`,
    circleId: input.circleId,
    kind: input.kind,
    sev: SEVERITY_OF[input.kind],
    actorId: input.actorId,
    actorName: input.actorName,
    text: input.text,
    at,
    read: false,
  };
  alerts = [alert, ...alerts].slice(0, MAX_ALERTS);
  emit();
  await persist();
  return alert;
}

/** Filter + sort for one circle (newest first). Pure over the loaded mirror. */
export function selectAlerts(circleId: string | null, filter: AlertFilter): FamilyAlert[] {
  return alerts
    .filter((a) => (!circleId || a.circleId === circleId) && matchesFilter(a, filter))
    .sort((a, b) => b.at - a.at);
}

export function matchesFilter(a: FamilyAlert, filter: AlertFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'important') return a.sev === 'critical' || a.sev === 'important';
  return SYSTEM_KINDS.includes(a.kind);
}

export function unreadCount(circleId?: string | null): number {
  return alerts.filter((a) => !a.read && (!circleId || a.circleId === circleId)).length;
}

export async function markAllRead(circleId?: string | null): Promise<void> {
  await loadAlerts();
  let touched = false;
  alerts = alerts.map((a) => {
    if (a.read || (circleId && a.circleId !== circleId)) return a;
    touched = true;
    return { ...a, read: true };
  });
  if (touched) { emit(); await persist(); }
}

export async function clearCircleAlerts(circleId: string): Promise<void> {
  await loadAlerts();
  const before = alerts.length;
  alerts = alerts.filter((a) => a.circleId !== circleId);
  if (alerts.length !== before) { emit(); await persist(); }
}

// Module-level so its identity is stable: an inline arrow would make
// useSyncExternalStore tear down and re-add the subscription on every render.
function subscribe(cb: () => void): () => void {
  subs.add(cb);
  if (!loaded) loadAlerts();
  return () => { subs.delete(cb); };
}

/** Live list for a circle + filter. */
export function useFamilyAlerts(circleId: string | null, filter: AlertFilter): FamilyAlert[] {
  // getSnapshot must return a stable reference between emits — see snapshotFor.
  return useSyncExternalStore(subscribe, () => snapshotFor(circleId, filter), () => snapshotFor(circleId, filter));
}

// selectAlerts() builds a new array each call, which would make useSyncExternalStore
// loop forever. Memoise on (version, circleId, filter) so the reference only
// changes when the data actually does.
let version = 0;
const cache = new Map<string, { v: number; list: FamilyAlert[] }>();
function snapshotFor(circleId: string | null, filter: AlertFilter): FamilyAlert[] {
  const key = `${circleId ?? '*'}|${filter}`;
  const hit = cache.get(key);
  if (hit && hit.v === version) return hit.list;
  const list = selectAlerts(circleId, filter);
  cache.set(key, { v: version, list });
  return list;
}

/** Live unread count for the dashboard badge. */
export function useUnreadCount(circleId: string | null): number {
  return useSyncExternalStore(subscribe, () => unreadCount(circleId), () => unreadCount(circleId));
}

// ── test seam ──
/** Replace the in-memory mirror (self-check only — does not persist). */
export function __setAlertsForTest(next: FamilyAlert[]): void {
  alerts = next; loaded = true; version++;
}

// ── self-check ──
if (require.main === module) {
  const mk = (kind: AlertKind, circleId = 'c1', at = 1): FamilyAlert => ({
    id: `x${at}`, circleId, kind, sev: SEVERITY_OF[kind], actorId: 'u1',
    actorName: 'Rohan', text: `${kind} evt`, at, read: false,
  });

  __setAlertsForTest([mk('sos', 'c1', 3), mk('enter', 'c1', 2), mk('battery', 'c1', 1), mk('leave', 'c2', 4)]);

  if (selectAlerts('c1', 'all').length !== 3) throw new Error('circle filter wrong');
  if (selectAlerts(null, 'all').length !== 4) throw new Error('null circle should span circles');
  // newest first
  if (selectAlerts('c1', 'all')[0].kind !== 'sos') throw new Error('not sorted newest-first');
  // important = critical + important; enter(info) excluded, battery(important) included
  const imp = selectAlerts('c1', 'important').map((a) => a.kind).sort();
  if (imp.join(',') !== 'battery,sos') throw new Error('important filter wrong: ' + imp);
  // system = battery/sharing only
  const sys = selectAlerts('c1', 'system').map((a) => a.kind);
  if (sys.join(',') !== 'battery') throw new Error('system filter wrong: ' + sys);

  if (unreadCount('c1') !== 3) throw new Error('unread count wrong');
  if (unreadCount() !== 4) throw new Error('global unread wrong');

  // snapshot identity: same version → same reference (or useSyncExternalStore loops)
  const s1 = snapshotFor('c1', 'all');
  if (s1 !== snapshotFor('c1', 'all')) throw new Error('snapshot must be referentially stable');
  version++;
  if (s1 === snapshotFor('c1', 'all')) throw new Error('snapshot must change after a version bump');

  if (SEVERITY_OF.sos !== 'critical') throw new Error('SOS must be critical');
  console.log('family/alerts self-check OK');
}
