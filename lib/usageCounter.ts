// lib/usageCounter.ts — count screen opens, and nothing else.
//
// AUDIT F9. Nothing could say which of 195 screens are used, so nothing could
// be retired and everything was maintained forever on the assumption that
// somebody might be opening it. This is the instrument that turns "cut this"
// from an opinion into a decision.
//
// WHAT IT SENDS
// -------------
//     { "counts": { "shelf": 3, "chats": 12 } }
//
// That is the entire payload. No user id, no device id, no session id, no
// order, no timestamps, no durations, no message content, no chat ids, no
// crash traces. The server stores (screen, day, total) with no identity either —
// see migration 130, which spells out what the table can and cannot answer.
//
// It is authenticated only so the endpoint is not an open counter anyone can
// inflate; the identity is used to rate-limit and is never written down.
//
// IT IS OFF WITH ONE SWITCH, and the switch is honoured before anything is
// buffered — not merely before it is sent. Buffering while switched off and
// discarding later would mean the app still holds a record of where the user
// went, which is precisely the thing being promised away.
//
// DEFAULT ON, DISCLOSED. Two counters and a day are not a behavioural profile,
// and an opt-in counter measures a self-selected minority — which is worse than
// no instrument, because it looks like data. The privacy policy says what this
// collects, and Settings turns it off. Flip DEFAULT_ENABLED below if that
// balance should go the other way; nothing else changes.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';

import { api, hasSession } from './api';

const PREF_KEY = 'vaultchat.usageCounter.enabled';
const DEFAULT_ENABLED = true;

/**
 * Flush at most this often. Counting is not urgent and never worth a wakeup.
 *
 * FIFTEEN, not five. The server allows 12 batches per user per hour
 * (ConsumeSecure in routes/usage.go), and a five-minute interval produces
 * exactly 12 — the limit, with zero headroom, before a single
 * background-triggered flush is counted. Over the limit the server answers 204
 * and drops the batch: no error, no log, no metric, and the client cannot tell
 * a dropped batch from an accepted one. A long session would simply stop being
 * counted and nothing anywhere would say so. Measured during a device
 * walkthrough: 7 of 12 consumed with 34 minutes of the window left.
 *
 * Fifteen minutes is 4/hour, which leaves room for the forced flushes below
 * and costs at most fifteen minutes of counts if the app is killed — a trade
 * that is obviously right for a feature whose entire output is "roughly how
 * often is this screen opened".
 */
const FLUSH_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Even a FORCED flush will not fire more often than this.
 *
 * Backgrounding forces a flush so a session's counts are not lost, but a user
 * switching apps repeatedly would otherwise force one per switch and burn the
 * hourly allowance in a couple of minutes — the same silent drop, arrived at
 * from the other direction.
 */
const MIN_FORCED_SPACING_MS = 2 * 60 * 1000;

let enabled = DEFAULT_ENABLED;
let prefLoaded = false;
let pending: Record<string, number> = {};
let lastFlush = 0;

/** Read the stored preference. Idempotent; call once at boot. */
export async function initUsageCounter(): Promise<boolean> {
  if (prefLoaded) return enabled;
  prefLoaded = true;
  try {
    const raw = await AsyncStorage.getItem(PREF_KEY);
    if (raw === 'off') enabled = false;
    else if (raw === 'on') enabled = true;
  } catch {
    // Unreadable preference ⇒ the default. Not a reason to fail anything.
  }
  return enabled;
}

export function usageCounterEnabled(): boolean {
  return enabled;
}

/**
 * Turn it on or off. Switching off DISCARDS whatever was buffered and stops
 * counting at once, even if the preference then fails to save; switching on
 * takes effect only once it is saved. A failed write rejects, so the caller
 * (app/settings.tsx) can revert and say so.
 */
export async function setUsageCounterEnabled(on: boolean): Promise<void> {
  if (!on) { enabled = false; pending = {}; }   // nothing already recorded may survive the switch
  await AsyncStorage.setItem(PREF_KEY, on ? 'on' : 'off');
  if (on) enabled = true;
}

/**
 * Record one screen open.
 *
 * Cheap and synchronous — this sits on a navigation path, and an instrument
 * that slows down the thing it measures is not worth having.
 */
export function countScreen(screen: string): void {
  if (!enabled) return;
  const name = screen.replace(/^\//, '').trim();
  if (!name) return;
  pending[name] = (pending[name] ?? 0) + 1;
  void maybeFlush();
}

async function maybeFlush(force = false): Promise<void> {
  if (!enabled) return;
  const now = Date.now();
  const since = now - lastFlush;
  if (force ? since < MIN_FORCED_SPACING_MS : since < FLUSH_INTERVAL_MS) return;
  if (Object.keys(pending).length === 0) return;
  lastFlush = now;

  const counts = pending;
  pending = {};
  try {
    if (!(await hasSession())) return;   // signed out: nothing to send, nothing kept
    await api('/app/usage', { method: 'POST', json: { counts } });
  } catch {
    // Dropped, deliberately, and NOT retried. A usage batch is worth nothing
    // against the cost of a retry queue, and a counter that hoards unsent
    // records on the device is a counter that has quietly become a log.
  }
}

/** Flush on background, so a session's counts are not lost when the app sleeps. */
export function attachUsageFlush(): () => void {
  const sub = AppState.addEventListener('change', (state) => {
    if (state !== 'active') void maybeFlush(true);
  });
  return () => sub.remove();
}

export default { countScreen, initUsageCounter, usageCounterEnabled, setUsageCounterEnabled };
