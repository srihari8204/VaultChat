// lib/lock/lockStore.ts — local persistence for Location Lock. Two concerns:
//
//  1. The ACTIVE lock (center, radius, settings, zone snapshot, session id) —
//     kept in AsyncStorage as one JSON blob, rewritten on every zone
//     transition, so a headless background wake or a process restart resumes
//     exactly where the last fix left off (same pattern as family/background).
//
//  2. HISTORY — lock_sessions + lock_events tables in the shared op-sqlite DB
//     (lib/localDb). Sessions carry the aggregates the stats screen rolls up;
//     events carry the timeline a session detail renders.
//
// Everything is local-only. Nothing in this module touches the network.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocalDb, type LocalDb } from '../localDb';
import { type LatLng } from '../nav/geo';
import { type ZoneSnapshot } from './zoneMachine';
import { type LockAlertSettings } from './lockSettings';

// ── active lock (survives kill; read by the headless task) ──────────────────

export interface ActiveLock {
  sessionId: number;
  center: LatLng;
  radius: number;                 // metres
  armedAt: number;                // epoch ms
  snap: ZoneSnapshot;             // last zone snapshot (state, window, …)
  alerts: LockAlertSettings;      // frozen copy so the bg task needs no other read
  lastPos: LatLng | null;         // last accepted position (distance-traveled acc.)
  graceUntil: number | null;      // exit grace deadline (headless alarm timing)
  alarmStartedAt: number | null;  // non-null while the alarm is sounding
  alarmSilenced: boolean;         // user tapped Stop Alarm while still outside
}

const K_ACTIVE = 'vc_lock_active_v1';

export async function saveActiveLock(a: ActiveLock): Promise<void> {
  try { await AsyncStorage.setItem(K_ACTIVE, JSON.stringify(a)); } catch {}
}

export async function readActiveLock(): Promise<ActiveLock | null> {
  try {
    const raw = await AsyncStorage.getItem(K_ACTIVE);
    if (!raw) return null;
    const a = JSON.parse(raw) as ActiveLock;
    return a && a.center && a.radius >= 10 && a.sessionId > 0 ? a : null;
  } catch { return null; }
}

export async function clearActiveLock(): Promise<void> {
  try { await AsyncStorage.removeItem(K_ACTIVE); } catch {}
}

// ── history schema ───────────────────────────────────────────────────────────

let _ready: Promise<LocalDb> | null = null;

/** The shared DB with the lock tables ensured (idempotent, additive-only). */
export function lockDb(): Promise<LocalDb> {
  if (!_ready) {
    _ready = (async () => {
      const db = await getLocalDb();
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS lock_sessions (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at      INTEGER NOT NULL,
          ended_at        INTEGER,
          center_lat      REAL NOT NULL,
          center_lng      REAL NOT NULL,
          radius          REAL NOT NULL,
          time_inside_ms  INTEGER NOT NULL DEFAULT 0,
          time_outside_ms INTEGER NOT NULL DEFAULT 0,
          exits           INTEGER NOT NULL DEFAULT 0,
          returns         INTEGER NOT NULL DEFAULT 0,
          max_distance    REAL NOT NULL DEFAULT 0,
          alarm_ms        INTEGER NOT NULL DEFAULT 0,
          distance_traveled REAL NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS lock_events (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id  INTEGER NOT NULL,
          type        TEXT NOT NULL,
          t           INTEGER NOT NULL,
          distance    REAL
        );
        CREATE INDEX IF NOT EXISTS idx_lock_events_session ON lock_events(session_id, t)
      `);
      return db;
    })();
  }
  return _ready;
}

export type LockEventType = 'armed' | 'warning' | 'exit' | 'return' | 'alarm_start' | 'alarm_stop' | 'unlocked';

export interface LockSessionRow {
  id: number;
  started_at: number;
  ended_at: number | null;
  center_lat: number;
  center_lng: number;
  radius: number;
  time_inside_ms: number;
  time_outside_ms: number;
  exits: number;
  returns: number;
  max_distance: number;
  alarm_ms: number;
  distance_traveled: number;
}

export interface LockEventRow { id: number; session_id: number; type: LockEventType; t: number; distance: number | null }

// ── session lifecycle ────────────────────────────────────────────────────────

export async function createSession(center: LatLng, radius: number, t: number): Promise<number> {
  const db = await lockDb();
  const r = await db.runAsync(
    `INSERT INTO lock_sessions (started_at, center_lat, center_lng, radius) VALUES (?,?,?,?)`,
    [t, center.lat, center.lng, radius],
  );
  await db.runAsync(`INSERT INTO lock_events (session_id, type, t, distance) VALUES (?,?,?,0)`, [r.lastInsertRowId, 'armed', t]);
  return r.lastInsertRowId;
}

export async function addEvent(sessionId: number, type: LockEventType, t: number, distance?: number | null): Promise<void> {
  const db = await lockDb();
  await db.runAsync(
    `INSERT INTO lock_events (session_id, type, t, distance) VALUES (?,?,?,?)`,
    [sessionId, type, t, distance ?? null],
  );
}

/** Merge incremental aggregates into a session (all deltas are additive). */
export async function bumpAggregates(sessionId: number, d: Partial<{
  insideMs: number; outsideMs: number; exits: number; returns: number;
  alarmMs: number; traveled: number; maxDistance: number;
}>): Promise<void> {
  const db = await lockDb();
  await db.runAsync(
    `UPDATE lock_sessions SET
       time_inside_ms   = time_inside_ms  + ?,
       time_outside_ms  = time_outside_ms + ?,
       exits            = exits           + ?,
       returns          = returns         + ?,
       alarm_ms         = alarm_ms        + ?,
       distance_traveled = distance_traveled + ?,
       max_distance     = MAX(max_distance, ?)
     WHERE id = ?`,
    [d.insideMs ?? 0, d.outsideMs ?? 0, d.exits ?? 0, d.returns ?? 0,
     d.alarmMs ?? 0, d.traveled ?? 0, d.maxDistance ?? 0, sessionId],
  );
}

export async function endSession(sessionId: number, t: number): Promise<void> {
  const db = await lockDb();
  await db.runAsync(`UPDATE lock_sessions SET ended_at = ? WHERE id = ?`, [t, sessionId]);
  await addEvent(sessionId, 'unlocked', t);
}

// ── history queries ──────────────────────────────────────────────────────────

export type HistoryFilter = 'all' | 'exits' | 'returns' | 'alarms';

const FILTER_EVENT: Record<Exclude<HistoryFilter, 'all'>, LockEventType> = {
  exits: 'exit', returns: 'return', alarms: 'alarm_start',
};

export async function getSessions(filter: HistoryFilter = 'all', limit = 100): Promise<LockSessionRow[]> {
  const db = await lockDb();
  if (filter === 'all') {
    return db.getAllAsync(`SELECT * FROM lock_sessions ORDER BY started_at DESC LIMIT ?`, [limit]) as Promise<LockSessionRow[]>;
  }
  return db.getAllAsync(
    `SELECT DISTINCT s.* FROM lock_sessions s
       JOIN lock_events e ON e.session_id = s.id AND e.type = ?
      ORDER BY s.started_at DESC LIMIT ?`,
    [FILTER_EVENT[filter], limit],
  ) as Promise<LockSessionRow[]>;
}

export async function getEvents(sessionId: number): Promise<LockEventRow[]> {
  const db = await lockDb();
  return db.getAllAsync(`SELECT * FROM lock_events WHERE session_id = ? ORDER BY t ASC`, [sessionId]) as Promise<LockEventRow[]>;
}

export interface LockStats {
  locks: number;
  exits: number;
  timeOutsideMs: number;
  timeProtectedMs: number;
  distanceTraveled: number;   // metres, while locked
  avgSpeedKmh: number;        // traveled / time protected
  alarmMs: number;
}

/** Rollup over sessions STARTED in [fromMs, toMs). Pure SQL — reproducible offline. */
export async function statsForRange(fromMs: number, toMs: number): Promise<LockStats> {
  const db = await lockDb();
  const r: any = await db.getFirstAsync(
    `SELECT COUNT(*) AS locks,
            COALESCE(SUM(exits),0) AS exits,
            COALESCE(SUM(time_outside_ms),0) AS outside_ms,
            COALESCE(SUM(time_inside_ms + time_outside_ms),0) AS protected_ms,
            COALESCE(SUM(distance_traveled),0) AS traveled,
            COALESCE(SUM(alarm_ms),0) AS alarm_ms
       FROM lock_sessions WHERE started_at >= ? AND started_at < ?`,
    [fromMs, toMs],
  );
  const protectedMs = Number(r?.protected_ms ?? 0);
  const traveled = Number(r?.traveled ?? 0);
  return {
    locks: Number(r?.locks ?? 0),
    exits: Number(r?.exits ?? 0),
    timeOutsideMs: Number(r?.outside_ms ?? 0),
    timeProtectedMs: protectedMs,
    distanceTraveled: traveled,
    avgSpeedKmh: protectedMs > 0 ? (traveled / 1000) / (protectedMs / 3_600_000) : 0,
    alarmMs: Number(r?.alarm_ms ?? 0),
  };
}

// ── export + deletion ────────────────────────────────────────────────────────

/** Full history as a JSON string (sessions with embedded events). */
export async function exportHistoryJSON(): Promise<string> {
  const db = await lockDb();
  const sessions = await db.getAllAsync(`SELECT * FROM lock_sessions ORDER BY started_at DESC`) as LockSessionRow[];
  const out = [];
  for (const s of sessions) out.push({ ...s, events: await getEvents(s.id) });
  return JSON.stringify({ format: 'vaultchat-location-lock/1', exportedAt: Date.now(), sessions: out }, null, 2);
}

/** Sessions as CSV (one row per session; events are the JSON export's job). */
export async function exportHistoryCSV(): Promise<string> {
  const db = await lockDb();
  const rows = await db.getAllAsync(`SELECT * FROM lock_sessions ORDER BY started_at DESC`) as LockSessionRow[];
  const head = 'id,started_at,ended_at,center_lat,center_lng,radius_m,time_inside_ms,time_outside_ms,exits,returns,max_distance_m,alarm_ms,distance_traveled_m';
  const lines = rows.map((s) => [
    s.id, new Date(s.started_at).toISOString(), s.ended_at ? new Date(s.ended_at).toISOString() : '',
    s.center_lat, s.center_lng, s.radius, s.time_inside_ms, s.time_outside_ms,
    s.exits, s.returns, Math.round(s.max_distance * 10) / 10, s.alarm_ms, Math.round(s.distance_traveled),
  ].join(','));
  return [head, ...lines].join('\n');
}

export async function deleteSession(sessionId: number): Promise<void> {
  const db = await lockDb();
  await db.runAsync(`DELETE FROM lock_events WHERE session_id = ?`, [sessionId]);
  await db.runAsync(`DELETE FROM lock_sessions WHERE id = ?`, [sessionId]);
}

/** Immediate + irreversible, per spec. */
export async function clearAllHistory(): Promise<void> {
  const db = await lockDb();
  await db.execAsync(`DELETE FROM lock_events; DELETE FROM lock_sessions`);
}

export default {};
