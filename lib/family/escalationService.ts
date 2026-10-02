// lib/family/escalationService.ts — the IO half of the guardian escalation
// ladder (F6.1–F6.3). All the timing rules live in escalation.ts, which is
// pure and self-checked; this file only persists, ticks, and speaks.
//
// OWNERSHIP — the rule that keeps the ladder from double-firing:
// a ladder is run ONLY by the device of the guardian who started it. Both
// parties see the audit messages, so if both ran the ladder every reminder
// would be posted twice and two Emergency Connects would fire. The subject's
// device therefore holds no ladder at all — it just receives the request and
// answers it.
//
// "I'm OK" is consequently a MESSAGE, not a local call: the member posts the
// confirmation into the circle, and the guardian's device cancels its own
// ladder when it ingests that line (see onMemberConfirmedOk, called from
// presence.ingestFamilyEvents). That is the same E2EE path every other family
// event already uses — no new server surface, and it works whichever device
// the member answers from.
//
// ponytail: the timer half only runs while the guardian's app runs. A ladder
// resumes correctly after a cold start (advance() collapses everything that
// came due while away), but a guardian whose app is killed for the whole
// window sees the escalation late, on next launch. Kill-safe delivery is F7.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { sendMessage } from '../chatService';
import { emit } from '../socket';
import { recordAlert } from './alerts';
import { notifyFamilyAlert, notifyEmergencyConnect } from './notify';
import {
  createLadder, advance, cancel, isActive, nextDueAt,
  auditRequest, auditRetry, auditCancelled, auditEmergency,
  type Ladder,
} from './escalation';

const kLadders = (cid: string) => `vc_family_ladders_${cid}`;

/** How often the ticker re-checks. The ladder's own steps are minutes apart, so
 *  this only bounds how late an action can be, not how often anything fires. */
export const TICK_MS = 30_000;

let timer: ReturnType<typeof setInterval> | null = null;
let tickCircles: string[] = [];
let tickMeId = '';

// ── persistence ──

export async function listLadders(circleId: string): Promise<Ladder[]> {
  try {
    const raw = await AsyncStorage.getItem(kLadders(circleId));
    const arr = raw ? JSON.parse(raw) : null;
    return Array.isArray(arr) ? arr as Ladder[] : [];
  } catch { return []; }
}

async function writeLadders(circleId: string, ladders: Ladder[]): Promise<void> {
  // Finished ladders are kept only until the audit trail carries them; the
  // circle thread is the durable record, this store is just the resume cursor.
  const keep = ladders.filter((l) => isActive(l)).slice(-20);
  try { await AsyncStorage.setItem(kLadders(circleId), JSON.stringify(keep)); } catch {}
}

/** The active ladder this device is running for a given member, if any. */
export async function activeLadderFor(circleId: string, subjectId: string): Promise<Ladder | null> {
  const all = await listLadders(circleId);
  return all.find((l) => isActive(l) && String(l.subjectId) === String(subjectId)) ?? null;
}

/** Every active ladder this device owns, for the UI. */
export async function activeLadders(circleId: string): Promise<Ladder[]> {
  return (await listLadders(circleId)).filter(isActive);
}

// ── audit ──
//
// Every action is an E2EE system message in the circle thread (F6.2) AND a
// local alert, so it survives in the inbox even if the thread is cleared.
async function audit(circleId: string, text: string, actorId: string, actorName: string,
                     kind: 'checkin' | 'sos', meId: string): Promise<void> {
  sendMessage(circleId, text, 'system').catch(() => {});
  const alert = await recordAlert({ circleId, kind, actorId, actorName, text });
  // Notify only when it concerns someone else — notifyFamilyAlert enforces this
  // too, but being explicit keeps the intent readable.
  if (alert) await notifyFamilyAlert(alert, meId);
}

// ── F6.3: guardian asks a member to check in ──

export interface RequestCheckinInput {
  circleId: string;
  subjectId: string;
  subjectName: string;
  meId: string;
  meName: string;
}

/**
 * Start a ladder. Idempotent per subject: asking twice while one is already
 * running returns the existing ladder rather than stacking a second set of
 * reminders on the same person.
 */
export async function requestCheckin(i: RequestCheckinInput): Promise<Ladder> {
  const existing = await activeLadderFor(i.circleId, i.subjectId);
  if (existing) return existing;

  const ladder = createLadder({
    id: `esc_${Date.now()}_${Math.round(Math.random() * 1e6)}`,
    circleId: i.circleId,
    subjectId: i.subjectId,
    subjectName: i.subjectName,
    requestedBy: i.meId,
    requestedByName: i.meName,
    at: Date.now(),
  });

  const all = await listLadders(i.circleId);
  await writeLadders(i.circleId, [...all, ladder]);
  await audit(i.circleId, auditRequest(ladder), i.meId, i.meName, 'checkin', i.meId);
  return ladder;
}

// ── F6.2: "I'm OK" ──

/**
 * The MEMBER's side: post the confirmation. The guardian's device cancels its
 * ladder when it ingests this line, so this works from any device the member
 * happens to be holding.
 */
export async function confirmImOk(circleId: string, meId: string, meName: string): Promise<void> {
  const text = auditCancelled(meName);
  sendMessage(circleId, text, 'system').catch(() => {});
  await recordAlert({ circleId, kind: 'checkin', actorId: meId, actorName: meName, text });
  // Cancel locally too, for the case where a guardian checks in on themselves.
  await onMemberConfirmedOk(circleId, meId);
}

/**
 * The GUARDIAN's side: a member confirmed, so stop their ladder. Called from
 * the ingestion path when a 👍 line arrives, and locally by confirmImOk.
 * Safe to call for a member with no ladder — that is the common case.
 */
export async function onMemberConfirmedOk(circleId: string, subjectId: string): Promise<boolean> {
  const all = await listLadders(circleId);
  let hit = false;
  const next = all.map((l) => {
    if (!isActive(l) || String(l.subjectId) !== String(subjectId)) return l;
    hit = true;
    return cancel(l, Date.now());
  });
  if (hit) await writeLadders(circleId, next);
  return hit;
}

// ── F6.1: the ticker ──

/** Advance every ladder this device owns in one circle. Returns actions fired. */
export async function tickCircle(circleId: string, meId: string): Promise<number> {
  const all = await listLadders(circleId);
  if (!all.length) return 0;

  const now = Date.now();
  const next: Ladder[] = [];
  let fired = 0;

  for (const l of all) {
    // Only the requesting guardian runs the ladder — see OWNERSHIP above.
    if (!isActive(l) || String(l.requestedBy) !== String(meId)) { next.push(l); continue; }

    const r = advance(l, now);
    next.push(r.ladder);
    if (!r.fired) continue;
    fired++;

    if (r.fired === 'retry') {
      await audit(circleId, auditRetry(r.ladder, r.skipped),
                  r.ladder.subjectId, r.ladder.subjectName, 'checkin', meId);
    } else {
      const text = auditEmergency(r.ladder);
      await audit(circleId, text, r.ladder.subjectId, r.ladder.subjectName, 'sos', meId);
      // The requesting guardian is watching THEIR ladder run out, so they get
      // the full-screen alarm here. Other guardians get it two ways: the socket
      // relay below if their app is up, and a wake-up push from the server if
      // it is not (F7.1). Ingestion of the audit message is the third, slowest
      // path and the one that carries the actual text.
      await notifyEmergencyConnect(text, circleId);
      // Content-free by design: the server cannot read the audit line, and the
      // client rule is never to put plaintext in a notification.
      emit('family_emergency', { chatId: circleId }).catch(() => {});
    }
  }

  if (fired) await writeLadders(circleId, next);
  return fired;
}

/**
 * Start ticking the given circles. Safe to call repeatedly — it replaces any
 * previous ticker rather than stacking one. Ticks once immediately so a cold
 * start settles overdue ladders (collapsed, per advance) without waiting.
 */
export function startEscalationTicker(circleIds: string[], meId: string): void {
  stopEscalationTicker();
  tickCircles = [...circleIds];
  tickMeId = meId;
  if (!tickCircles.length || !meId) return;

  const run = () => { for (const cid of tickCircles) tickCircle(cid, tickMeId).catch(() => {}); };
  run();
  timer = setInterval(run, TICK_MS);
}

export function stopEscalationTicker(): void {
  if (timer) { clearInterval(timer); timer = null; }
  tickCircles = [];
  tickMeId = '';
}

/** Next due action across a circle's ladders — used by the UI for a countdown. */
export async function nextDue(circleId: string): Promise<number | null> {
  const due = (await activeLadders(circleId)).map(nextDueAt).filter((t): t is number => t != null);
  return due.length ? Math.min(...due) : null;
}

export default {};
