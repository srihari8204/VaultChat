// lib/spaces/runSession.ts — a run's live position on the wire
// (Spaces & Operations, S2.8).
//
// The driver's device seals its position and emits it; entitled devices open it.
// The server relays bytes it cannot read, exactly as it does for presence and
// group trips.
//
// ── three decisions worth knowing before editing ──
//
// 1. NO NEW KEY, NO NEW MESSAGE. A run ping is sealed with the driver's EXISTING
//    presence live-location key — the one presence already delivered to the
//    space when they started sharing. Minting a per-run key would mean
//    announcing it in the thread, which for a school with twenty buses twice a
//    day is forty system messages nobody reads. Reusing the presence key also
//    makes the audience automatically right: whoever can already open this
//    driver's presence pings can open their run pings.
//
// 2. THE RUN CHANNEL DOES CARRY A POSITION, unlike the trip channel.
//    lib/groups/tripSession.ts deliberately publishes only derived values
//    (distance remaining, ETA) so that a trip cannot bypass a member's per-group
//    privacy setting. A run is the opposite case on purpose: the thing being
//    shared is a VEHICLE's position, the driver started the run as an explicit
//    act of going on duty, and "where is the bus" is the entire service. It
//    stops the moment the run stops.
//
// 3. DELIVERY IS THE BOUNDARY, NOT THE KEY. The sealing key is the space's, so
//    every member holds it. What a non-entitled member never gets is the
//    CIPHERTEXT: the server admits a socket to a run's room only after checking
//    vc_run_visible (see registerRunRelay in internal/realtime/handlers.go).
//    Stated plainly because the inverse — assuming cryptographic scoping — would
//    be a dangerous thing to believe.
//
// The pure reasoning (windows, progress, folds) lives in lib/spaces/runs.ts and
// is tested there. This file is plumbing.

import { emit, getSocket, joinChatRoom } from '../socket';
import { sealJSON, openJSON, getLiveKey } from '../liveLocationCrypto';
import { currentLiveKey } from '../family/presence';
import type { LatLng } from '../nav/geo';

const EV_UPDATE = 'run_update';
const EV_END = 'run_end';
const EV_SUB = 'run_subscribe';
const EV_UNSUB = 'run_unsubscribe';

/** One position report from a vehicle on a run. */
export interface RunPing {
  runId: string;
  lat: number;
  lng: number;
  /** metres per second, when the fix carried one */
  speed?: number;
  /** metres of accuracy the fix claimed, so a viewer can discount a bad one */
  acc?: number;
  at: number;
}

/**
 * Publish this vehicle's position.
 *
 * Silently does nothing when the driver is not sharing location — there is no
 * key to seal with, and a run that quietly fell back to plaintext would be far
 * worse than one that shows no position.
 */
export async function publishRunPosition(
  spaceId: string,
  runId: string,
  pos: LatLng,
  opts: { speed?: number; accuracy?: number } = {},
): Promise<boolean> {
  const key = currentLiveKey();
  if (!key) return false;

  const ping: RunPing = {
    runId,
    lat: pos.lat,
    lng: pos.lng,
    speed: opts.speed,
    acc: opts.accuracy,
    at: Date.now(),
  };
  const blob = sealJSON(key, ping);
  if (!blob) return false;
  await emit(EV_UPDATE, { chatId: spaceId, runId, blob }).catch(() => {});
  return true;
}

/** Tell watchers the vehicle has stopped reporting on purpose. */
export async function endRunBroadcast(spaceId: string, runId: string): Promise<void> {
  await emit(EV_END, { chatId: spaceId, runId }).catch(() => {});
}

export interface RunPositionEvent {
  userId: string;
  ping: RunPing | null; // null = the broadcast ended
}

/**
 * Watch a run's position.
 *
 * Subscription is a REQUEST, not a guarantee: the server admits the socket to
 * the run's room only if this user may see the run, and silently ignores the
 * request otherwise. So a caller must treat "no pings ever arrived" as a
 * possible answer and say so in the UI, rather than showing an empty map.
 */
export async function subscribeRun(
  spaceId: string,
  runId: string,
  meId: string,
  onEvent: (e: RunPositionEvent) => void,
): Promise<() => void> {
  await joinChatRoom(spaceId);
  let disposed = false;

  const s = await getSocket();
  await emit(EV_SUB, { chatId: spaceId, runId }).catch(() => {});

  const onUpd = (e: any) => {
    if (disposed || !e?.userId || !e.blob) return;
    if (String(e.runId) !== String(runId)) return;
    if (String(e.userId) === String(meId)) return; // never echo my own vehicle
    const key = getLiveKey(spaceId, String(e.userId));
    if (!key) return; // no key for this sender yet: their next presence message brings one
    const ping = openJSON<RunPing>(key, e.blob);
    if (!ping) return; // stale key or corrupt blob — drop, never guess
    onEvent({ userId: String(e.userId), ping });
  };
  const onEnd = (e: any) => {
    if (disposed || !e?.userId) return;
    if (String(e.runId) !== String(runId)) return;
    onEvent({ userId: String(e.userId), ping: null });
  };

  s.on(EV_UPDATE, onUpd);
  s.on(EV_END, onEnd);

  return () => {
    disposed = true;
    s.off(EV_UPDATE, onUpd);
    s.off(EV_END, onEnd);
    emit(EV_UNSUB, { runId }).catch(() => {});
  };
}

// ✅ expo-router convention.
export default {};
