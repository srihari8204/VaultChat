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
// already decrypted for the thread). This store is never uploaded, and stays
// readable only on this device — same DEK as the message cache. Alerts that
// other members must see travel separately, as sealed famEvent messages in the
// space's E2EE thread (see the envelope section below); receivers fold them in
// via ingestFamEvent.
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
  | 'enter' | 'leave'          // geofence crossings
  | 'sos' | 'checkin'          // people
  | 'battery' | 'sharing'      // device state
  | 'gps' | 'offline'          // the device stopped being able to report
  | 'deviation'                // left the expected route (group navigation)
  | 'announcement'             // a permitted member addressed the group
  // Spaces & Operations (S5.4). Detected ON THE EMITTING DEVICE, because the
  // server cannot read a position and is not going to be given one — see the
  // design note in openspec/changes/spaces-operations/design.md.
  | 'overspeed'                // sustained speed above the space's threshold
  | 'longstop';                // a vehicle stationary mid-run for too long

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
  /**
   * The trip this alert belongs to, for 'deviation' and trip arrivals.
   *
   * Present so trip history can attribute an arrival to a trip WITHOUT parsing
   * `text` — that string is rendered for humans and changes whenever the copy
   * is reworded, which is exactly the sort of coupling that breaks silently.
   * Absent on every other kind, and on alerts recorded before this existed.
   */
  tripId?: string;
}

/** The three tabs the alerts screen shows. */
export type AlertFilter = 'all' | 'important' | 'system';

const KEY = 'vc_family_alerts_v1';
const MAX_ALERTS = 300;
/** Kinds that count as "system" rather than a person doing something. */
const SYSTEM_KINDS: AlertKind[] = ['battery', 'sharing', 'gps', 'offline'];

export const SEVERITY_OF: Record<AlertKind, AlertSeverity> = {
  sos: 'critical',
  // "I can no longer tell you where they are" outranks an ordinary arrival:
  // silence is the state a worried person most needs surfaced.
  gps: 'important',
  offline: 'important',
  deviation: 'important',
  // A bus doing 90 in a 50 is not an "info" event, and a vehicle that has been
  // stationary mid-route for ten minutes is either broken down or something
  // worse. Both outrank an arrival.
  overspeed: 'important',
  longstop: 'important',
  battery: 'important',
  leave: 'important',
  announcement: 'important',
  enter: 'info',
  checkin: 'info',
  sharing: 'info',
};

// ── in-memory mirror + subscribers ──
let alerts: FamilyAlert[] = [];
/** The one read of the store, shared by every caller (see loadAlerts). */
let loading: Promise<FamilyAlert[]> | null = null;
const subs = new Set<() => void>();
// version is bumped BEFORE notifying so any getSnapshot() that runs synchronously
// inside a subscriber already sees the invalidated cache (see snapshotFor).
const emit = () => { version++; subs.forEach((c) => { try { c(); } catch {} }); };

/** Write the mirror to the sealed store. REJECTS on a storage failure, so a
 *  caller that promised the user something (a clear) can say it failed;
 *  best-effort callers catch it themselves. */
async function persist(): Promise<void> {
  const sealed = crypt().encField(JSON.stringify({ v: 1, a: alerts }));
  if (sealed != null) await storage().setItem(KEY, sealed);
}

/**
 * Read the store once. Every caller — including one that arrives while the
 * first read is still in flight — awaits that SAME read, so nobody gets the
 * empty pre-load list and draws a false "No alerts".
 */
export function loadAlerts(): Promise<FamilyAlert[]> {
  if (!loading) {
    loading = (async () => {
      try {
        const raw = await storage().getItem(KEY);
        const json = raw ? crypt().decField(raw) : null;
        const parsed = json ? JSON.parse(json) : null;
        if (Array.isArray(parsed?.a)) alerts = parsed.a as FamilyAlert[];
      } catch { /* start empty */ }
      emit();
      return alerts;
    })();
  }
  return loading.then(() => alerts);
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
  /** Set for trip alerts so history can attribute them without parsing text. */
  tripId?: string;
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
    ...(input.tripId ? { tripId: input.tripId } : {}),
  };
  alerts = [alert, ...alerts].slice(0, MAX_ALERTS);
  emit();
  // Best-effort: the alert is already on screen, and the escalation and
  // notification paths that record it must not abort over a storage hiccup.
  await persist().catch(() => {});
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
  // Best-effort: callers fire this on a timer and do not handle a rejection.
  if (touched) { emit(); await persist().catch(() => {}); }
}

/** Rejects when the store could not be written — and then puts the alerts
 *  back, so the screen never shows "cleared" for history a restart restores. */
export async function clearCircleAlerts(circleId: string): Promise<void> {
  await loadAlerts();
  const prev = alerts;
  alerts = alerts.filter((a) => a.circleId !== circleId);
  if (alerts.length === prev.length) return;
  emit();
  try {
    await persist();
  } catch (e) {
    alerts = prev;
    emit();
    throw e;
  }
}

// Module-level so its identity is stable: an inline arrow would make
// useSyncExternalStore tear down and re-add the subscription on every render.
function subscribe(cb: () => void): () => void {
  subs.add(cb);
  void loadAlerts();
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
// ── the famEvent envelope (chat-map-separation) ────────────────────────
// Family events travel between devices as `system` chat messages, because that
// E2EE path is the ONLY transport receivers have — but they are protocol, not
// conversation. The envelope is what lets every chat surface hide them and
// every receiver fold them HERE instead. Build and parse live side by side so
// they cannot drift.

/** Envelope kinds — the events the owner moved out of chat. SOS is deliberately
 *  absent: a human emergency IS conversation and stays a visible message.
 *  deviation/longstop are a run vehicle's on-device detections (S5.4), sent
 *  from the driver screen so ops see them, not just the driver's own phone. */
export type FamEventKind = 'enter' | 'leave' | 'overspeed' | 'deviation' | 'longstop';
const FAM_EVENT_KINDS: readonly FamEventKind[] = ['enter', 'leave', 'overspeed', 'deviation', 'longstop'];

export interface FamEvent {
  v: 1;
  kind: FamEventKind;
  actorId: string;
  actorName: string;
  text: string;
  at: number;
}

/** The message content an announce implementation sends. */
export function buildFamEvent(e: Omit<FamEvent, 'v'>): string {
  return JSON.stringify({ famEvent: { v: 1, ...e } });
}

/** Parse defensively: this runs on RECEIVED message content, which is data.
 *  Anything that is not exactly a v1 envelope with sane fields is null. */
/**
 * Cheap pre-check: is this message a famEvent, without fully parsing it?
 * `type` is a plaintext DB column (only `content` is E2EE), so this is safe to
 * call on a message whose content may still be ciphertext — it is what lets
 * every chat surface (thread, list, root listener) test BEFORE decrypting.
 * The root listener still decrypts system messages to get the real verdict
 * via parseFamEvent/ingestFamEvent; this only says "don't show ciphertext".
 */
export function isFamEvent(type: unknown, content: unknown): boolean {
  return type === 'system' && typeof content === 'string' && content.includes('"famEvent"');
}

export function parseFamEvent(content: unknown): FamEvent | null {
  if (typeof content !== 'string' || !content.includes('"famEvent"')) return null;
  try {
    const o = JSON.parse(content)?.famEvent;
    if (!o || o.v !== 1) return null;
    if (!FAM_EVENT_KINDS.includes(o.kind)) return null;
    if (typeof o.actorId !== 'string' || !o.actorId) return null;
    if (typeof o.text !== 'string' || !o.text) return null;
    return {
      v: 1, kind: o.kind, actorId: o.actorId,
      actorName: typeof o.actorName === 'string' && o.actorName ? o.actorName : 'A member',
      text: o.text.slice(0, 300),
      at: typeof o.at === 'number' && o.at > 0 ? o.at : Date.now(),
    };
  } catch { return null; }
}

/**
 * Fold an incoming famEvent message into this device's inbox. Called from the
 * app-wide new_message listener — NOT from a screen, because an inbox that
 * only fills while some screen is open is not an inbox.
 *
 * Skips my own events: the emitting device already recorded them in
 * processFix, and recordAlert's dedupe window backstops any race.
 */
export async function ingestFamEvent(chatId: string, content: unknown, myId: string): Promise<boolean> {
  const ev = parseFamEvent(content);
  if (!ev || ev.actorId === myId) return false;
  const rec = await recordAlert({
    circleId: chatId, kind: ev.kind, actorId: ev.actorId,
    actorName: ev.actorName, text: ev.text, at: ev.at,
  });
  return rec != null;
}

/** Replace the in-memory mirror (self-check only — does not persist). */
export function __setAlertsForTest(next: FamilyAlert[]): void {
  alerts = next; loading = Promise.resolve(next); version++;
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

  // ── famEvent envelope round trip ──
  const sent = buildFamEvent({ kind: 'enter', actorId: 'u1', actorName: 'Rohan', text: 'Rohan arrived at Home', at: 5 });
  const back = parseFamEvent(sent);
  if (!back || back.kind !== 'enter' || back.text !== 'Rohan arrived at Home' || back.at !== 5) {
    throw new Error('famEvent round trip lost data: ' + JSON.stringify(back));
  }
  // The chat filter keys on this literal substring — the round trip must keep it.
  if (!sent.includes('"famEvent"')) throw new Error('envelope must carry the "famEvent" marker verbatim');
  // Received content is DATA. None of these may parse.
  const hostile: unknown[] = [
    'Rohan arrived at Home',                          // plain text (old build)
    '{"famEvent":{"v":2,"kind":"enter","actorId":"u","text":"x"}}',   // future version
    '{"famEvent":{"v":1,"kind":"sos","actorId":"u","text":"x"}}',     // SOS stays in chat
    '{"famEvent":{"v":1,"kind":"enter","actorId":"","text":"x"}}',    // empty actor
    '{"famEvent":' + '{'.repeat(4) + '}',             // malformed JSON
    42, null, undefined,                              // not even strings
  ];
  for (const h of hostile) {
    if (parseFamEvent(h) !== null) throw new Error('hostile content parsed: ' + String(h).slice(0, 60));
  }
  // A run vehicle's detections ride the same envelope so ops receive them.
  for (const kind of ['deviation', 'longstop'] as const) {
    const ev = parseFamEvent(buildFamEvent({ kind, actorId: 'd1', actorName: 'Bus 01', text: 'Bus 01 left its route', at: 7 }));
    if (!ev || ev.kind !== kind || SEVERITY_OF[ev.kind] !== 'important') throw new Error(`${kind} famEvent must round-trip`);
  }
  if (parseFamEvent('{"famEvent":{"v":1,"kind":"battery","actorId":"u","text":"x"}}') !== null) {
    throw new Error('kinds outside the envelope list must not parse');
  }
  // Missing name falls back rather than failing — the alert still renders.
  const anon = parseFamEvent('{"famEvent":{"v":1,"kind":"leave","actorId":"u9","text":"left Work","at":9}}');
  if (!anon || anon.actorName !== 'A member') throw new Error('missing actorName must fall back');

  // loadAlerts after a load: resolves to the CURRENT mirror, not a stale copy.
  void loadAlerts().then((l) => { if (l !== alerts) throw new Error('loadAlerts must resolve to the current mirror'); });

  console.log('family/alerts self-check OK');
}
