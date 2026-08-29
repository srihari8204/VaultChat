// lib/spaces/api.ts — the network half of Spaces & Operations (S2, S4, S5).
//
// Thin on purpose: every one of these is a single call whose shape the server
// already decides. The reasoning lives in lib/spaces/runs.ts, which is pure and
// self-checked; this file exists so the screens do not hand-build URLs.
//
// SCOPING IS NOT DONE HERE. Every list below returns what the SERVER decided
// the caller may see — a parent's roster call comes back with their own child
// and nobody else's. There is deliberately no client-side filter to "help": a
// filter here would imply the unfiltered data had already been sent, which is
// the thing the server-side rule exists to prevent.

import { api } from '../api';
import type { Run, RunStop, RunRider, RunEvent, RiderState } from './runs';

export interface RosterEntry {
  id: string;
  userId: string | null;
  displayName: string;
  kind: string;
  externalRef: string | null;
  archived: boolean;
}

export interface RosterResponse {
  roster: RosterEntry[];
  /** The hierarchy was deeper than the resolver's bound; this view is partial. */
  truncated: boolean;
  /** False when the caller holds the space-wide view. */
  scoped: boolean;
}

export type LinkRelation = 'guardian_of' | 'supervises' | 'teaches';

export interface SpaceLink {
  subjectId: string;
  objectId: string;
  relation: LinkRelation;
}

export interface Incident {
  id: string;
  runId: string | null;
  reporterId: string | null;
  category: string;
  note: string | null;
  mediaRef: string | null;
  status: 'open' | 'ack' | 'resolved';
  createdAt: string;
  resolvedAt: string | null;
}

export interface VisitorPass {
  id: string;
  hostId: string | null;
  visitorName: string;
  code: string;
  validFrom: string;
  validTo: string;
  redeemedAt: string | null;
  exitedAt: string | null;
}

// ── roster + links ──

export const getRoster = (spaceId: string) =>
  api<RosterResponse>(`/chats/${spaceId}/roster`);

export const addRosterEntry = (
  spaceId: string,
  body: { displayName: string; kind?: string; externalRef?: string; userId?: string },
) => api<{ id: string }>(`/chats/${spaceId}/roster`, { method: 'POST', json: body });

export const updateRosterEntry = (
  spaceId: string, rosterId: string, body: { displayName?: string; archived?: boolean },
) => api(`/chats/${spaceId}/roster/${rosterId}`, { method: 'PATCH', json: body });

export const getLinks = (spaceId: string) => api<SpaceLink[]>(`/chats/${spaceId}/links`);

export const addLink = (spaceId: string, body: SpaceLink) =>
  api(`/chats/${spaceId}/links`, { method: 'POST', json: body });

export const removeLink = (spaceId: string, body: SpaceLink) =>
  api(`/chats/${spaceId}/links`, { method: 'DELETE', json: body });

export const setRoleKey = (spaceId: string, userId: string, roleKey: string | null) =>
  api(`/chats/${spaceId}/members/${userId}/role-key`, {
    method: 'PATCH', json: { roleKey: roleKey ?? '' },
  });

// ── runs ──

export const getRuns = (spaceId: string, activeOnly = false) =>
  api<Run[]>(`/chats/${spaceId}/runs${activeOnly ? '?active=1' : ''}`);

export const getRun = (spaceId: string, runId: string) =>
  api<{ run: Run; stops: RunStop[]; riders: RunRider[]; delayThresholdMinutes: number }>(
    `/chats/${spaceId}/runs/${runId}`,
  );

export const createRun = (
  spaceId: string,
  body: { name: string; kind?: string; driverId?: string; vehicleLabel?: string; scheduledAt?: string; requireCode?: boolean },
) => api<{ id: string }>(`/chats/${spaceId}/runs`, { method: 'POST', json: body });

export const setRunStatus = (spaceId: string, runId: string, status: 'started' | 'completed' | 'cancelled') =>
  api(`/chats/${spaceId}/runs/${runId}`, { method: 'PATCH', json: { status } });

export const setRunDriver = (spaceId: string, runId: string, driverId: string | null) =>
  api(`/chats/${spaceId}/runs/${runId}`, { method: 'PATCH', json: { driverId: driverId ?? '' } });

export const setRunStops = (
  spaceId: string, runId: string,
  stops: { label: string; lat?: number; lng?: number; plannedAt?: string }[],
) => api(`/chats/${spaceId}/runs/${runId}/stops`, { method: 'PUT', json: { stops } });

/**
 * "The vehicle is here" — the ARRIVED step, before any pickup.
 *
 * Carries no position: the stop already knows where it is, and the server is
 * never told where the vehicle is. Idempotent, so a double tap or a retry after
 * a dropped connection keeps the FIRST arrival time.
 */
export const arriveAtStop = (spaceId: string, runId: string, stopId: string) =>
  api<{ ok: boolean; arrivedAt: string }>(
    `/chats/${spaceId}/runs/${runId}/stops/${stopId}/arrive`, { method: 'POST' });

export const setRunRiders = (
  spaceId: string, runId: string, riders: { riderId: string; stopId?: string | null }[],
) => api(`/chats/${spaceId}/runs/${runId}/riders`, { method: 'PUT', json: { riders } });

/**
 * Move a rider. `transitionId` is what makes a retry safe — pass one from
 * newTransitionId() and the server collapses duplicates instead of writing a
 * second boarding for the same child.
 */
export const setRiderState = (
  spaceId: string, runId: string, riderId: string,
  body: { state: RiderState; transitionId?: string; code?: string; note?: string },
) => api<{ ok: boolean; applied: boolean }>(
  `/chats/${spaceId}/runs/${runId}/riders/${riderId}/state`, { method: 'POST', json: body },
);

export const getRunEvents = (spaceId: string, runId: string) =>
  api<RunEvent[]>(`/chats/${spaceId}/runs/${runId}/events`);

/**
 * Proof of life for an active run. Carries NO position — the position is in the
 * sealed socket ping the same device already sends, which the server cannot
 * read. This only lets the server notice when a bus stops reporting at all.
 */
export const pingRun = (spaceId: string, runId: string) =>
  api(`/chats/${spaceId}/runs/${runId}/ping`, { method: 'POST' });

export const setDutyState = (spaceId: string, dutyState: 'on_duty' | 'on_break' | 'off_duty' | null) =>
  api(`/chats/${spaceId}/duty`, { method: 'PATCH', json: { dutyState: dutyState ?? '' } });

// ── incidents, passes, shift ──

export const getIncidents = (spaceId: string) => api<Incident[]>(`/chats/${spaceId}/incidents`);

export const fileIncident = (
  spaceId: string,
  body: { category: string; note?: string; runId?: string; mediaRef?: string },
) => api<{ id: string }>(`/chats/${spaceId}/incidents`, { method: 'POST', json: body });

export const setIncidentStatus = (spaceId: string, incidentId: string, status: 'open' | 'ack' | 'resolved') =>
  api(`/chats/${spaceId}/incidents/${incidentId}`, { method: 'PATCH', json: { status } });

export const getVisitorPasses = (spaceId: string) =>
  api<VisitorPass[]>(`/chats/${spaceId}/visitor-passes`);

export const issueVisitorPass = (spaceId: string, body: { visitorName: string; validTo?: string; hostId?: string }) =>
  api<{ id: string; code: string; validTo: string }>(`/chats/${spaceId}/visitor-passes`, { method: 'POST', json: body });

export const redeemVisitorPass = (spaceId: string, code: string, exit = false) =>
  api<{ ok: boolean; visitorName?: string }>(`/chats/${spaceId}/visitor-passes/redeem`, {
    method: 'POST', json: { code, exit },
  });

// ── the server-computed dashboard (migration 089) ──
//
// One call, one payload, no client-side aggregation. The shape is defined by
// space_ops_summary() in SQL — deliberately loose here, because adding a figure
// should be a change to ONE function and not a change to a Go struct, a
// TypeScript interface and three screens.
export interface OpsSummary {
  day: string;
  groupType: string | null;
  transport: { totalRuns: number; active: number; scheduled: number; completed: number; notReporting: number };
  riders: { expected: number; picked: number; dropped: number; pending: number; absent: number; unaccounted: number };
  roster: { total: number; children: number; linked: number };
  workforce: {
    members: number; checkedIn: number; stillIn: number;
    onLeave: number; leavePending: number;
    /** null when the space has no shift configured — NOT zero. See the SQL. */
    lateToday: number | null;
  };
  open: { incidents: number; sos: number; tasks: number; visitors: number };
  /** Business dashboard cards (migration 102). Optional so the screen still
   *  renders against a server that has not run it yet. */
  tasks?: { open: number; overdue: number; doneToday: number };
  leaveMonth?: { requests: number; pending: number; approved: number; declined: number };
  runs: { id: string; name: string; status: string; stale: boolean; total: number; pending: number }[];
  error?: string;
}

export const getOpsSummary = (spaceId: string, day?: string) =>
  api<OpsSummary>(`/chats/${spaceId}/ops/summary${day ? `?day=${day}` : ''}`);

export interface AttendanceRecord {
  userId: string; name: string | null;
  checkInAt: string | null; checkOutAt: string | null;
  source: string; note: string | null;
}

export const getAttendance = (spaceId: string, day?: string) =>
  api<{ day: string; records: AttendanceRecord[] }>(`/chats/${spaceId}/attendance${day ? `?day=${day}` : ''}`);

export const checkIn = (spaceId: string, note?: string) =>
  api<{ checkInAt: string }>(`/chats/${spaceId}/attendance/check-in`, { method: 'POST', json: { note } });

export const checkOut = (spaceId: string) =>
  api<{ checkOutAt: string }>(`/chats/${spaceId}/attendance/check-out`, { method: 'POST' });

export interface LeaveRequest {
  id: number; userId: string; name: string | null;
  kind: string; fromDay: string; toDay: string; days: number;
  reason: string | null; status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  decidedAt: string | null;
}

export const getLeave = (spaceId: string) => api<LeaveRequest[]>(`/chats/${spaceId}/leave`);

export const requestLeave = (
  spaceId: string, body: { kind: string; fromDay: string; toDay: string; reason?: string },
) => api<{ id: number }>(`/chats/${spaceId}/leave`, { method: 'POST', json: body });

export const decideLeave = (spaceId: string, id: number, status: 'approved' | 'rejected' | 'cancelled') =>
  api(`/chats/${spaceId}/leave/${id}`, { method: 'PATCH', json: { status } });

export interface WorkTask {
  id: number; title: string;
  assigneeId: string | null; assigneeName: string | null;
  priority: 'low' | 'medium' | 'high';
  dueAt: string | null; doneAt: string | null;
}

export const getWorkTasks = (spaceId: string) => api<WorkTask[]>(`/chats/${spaceId}/tasks`);

export const createWorkTask = (
  spaceId: string, body: { title: string; assigneeId?: string; priority?: string; dueAt?: string },
) => api<{ id: number }>(`/chats/${spaceId}/tasks`, { method: 'POST', json: body });

export const setWorkTaskDone = (spaceId: string, id: number, done: boolean) =>
  api(`/chats/${spaceId}/tasks/${id}`, { method: 'PATCH', json: { done } });

export interface PendingPickup {
  riderId: string; name: string;
  runId: string; runName: string;
  stop: string | null; plannedAt: string | null;
  runStatus: string; runStartedAt: string | null;
}

export const getPendingPickups = (spaceId: string) =>
  api<PendingPickup[]>(`/chats/${spaceId}/ops/pending`);

export interface Person {
  userId: string; name: string | null;
  role: string; roleKey: string | null;
  dutyState: string | null;
  /** Derived server-side so every screen says the same word.
   *  'unknown' is NOT 'absent' — nobody told us is not the same as away. */
  status: 'in' | 'left' | 'on_leave' | 'unknown';
  checkInAt: string | null; checkOutAt: string | null;
}

export const getPeople = (spaceId: string) => api<Person[]>(`/chats/${spaceId}/ops/people`);

export interface LeaveBalance {
  userId: string;
  /** null when the space has never set one — show "not set", never 0. */
  allowance: Record<string, number> | null;
  used: Record<string, number>;
}

export const getLeaveBalance = (spaceId: string, userId?: string) =>
  api<LeaveBalance>(`/chats/${spaceId}/leave/balance${userId ? `?userId=${userId}` : ''}`);

export const setLeaveAllowance = (spaceId: string, body: Record<string, number>) =>
  api(`/chats/${spaceId}/leave/allowance`, { method: 'PATCH', json: body });

// ── devices + theft protection (migration 091) ──
//
// There is no position in any of this, and no endpoint accepts one. A device's
// location travels sealed on the live-location channel like everyone else's.
export interface SpaceDevice {
  id: string;
  ownerId: string | null; ownerName: string | null;
  label: string; kind: string; identifier: string | null;
  lastSeenAt: string | null; battery: number | null;
  /** False = no VaultChat client backs it, so remote commands can never run.
   *  The UI must not offer a Lock button that reports success into a void. */
  appBacked: boolean;
  /** Server's own verdict from silence — the one judgement it can make. */
  stale: boolean;
  events24h: number;
}

export interface DeviceEvent {
  id: number; kind: string; text: string | null; at: string;
  detail: Record<string, any> | null;
}

export interface DeviceCommand {
  id: number; action: string; payload: string | null;
  /** 'executed' is written by the DEVICE. Anything still 'issued' genuinely
   *  has not been confirmed — never render that as done. */
  result: 'issued' | 'delivered' | 'executed' | 'failed' | 'cancelled';
  issuedAt: string; deliveredAt: string | null; executedAt: string | null;
}

export const getDevices = (spaceId: string) => api<SpaceDevice[]>(`/chats/${spaceId}/devices`);

export const addDevice = (
  spaceId: string, body: { label: string; kind?: string; identifier?: string; appBacked?: boolean },
) => api<{ id: string }>(`/chats/${spaceId}/devices`, { method: 'POST', json: body });

export const updateDevice = (
  spaceId: string, deviceId: string, body: { label?: string; archived?: boolean },
) => api(`/chats/${spaceId}/devices/${deviceId}`, { method: 'PATCH', json: body });

export const getDeviceEvents = (spaceId: string, deviceId: string) =>
  api<DeviceEvent[]>(`/chats/${spaceId}/devices/${deviceId}/events`);

export const getDeviceCommands = (spaceId: string, deviceId: string) =>
  api<DeviceCommand[]>(`/chats/${spaceId}/devices/${deviceId}/commands`);

export const issueDeviceCommand = (
  spaceId: string, deviceId: string, action: string, payload?: string,
) => api<{ id: number; result: string }>(
  `/chats/${spaceId}/devices/${deviceId}/commands`, { method: 'POST', json: { action, payload } },
);

export const setShift = (
  spaceId: string, body: {
    shiftStart?: string; shiftEnd?: string; shiftGraceMinutes?: number;
    /** Minutes past a stop's planned time before the SERVER pushes "running
     *  late" to that stop's guardians (1–240; omitted keeps the current value).
     *  The client's isDelayed() only informs a guardian who is looking —
     *  matching default 10 on both sides. */
    runDelayThresholdMinutes?: number;
  },
) => api(`/chats/${spaceId}/shift`, { method: 'PATCH', json: body });

// ✅ expo-router: this lives under lib/, but keep the convention consistent.
export default {};
