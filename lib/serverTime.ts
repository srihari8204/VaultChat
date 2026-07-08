// lib/serverTime.ts — trusted time from the relay (scheduled-message clock guard, #73).
//
// A local scheduled message fires on the DEVICE clock, so a user could move
// their clock forward to trigger it early. We cross-check against the server's
// `Date` response header (authenticated in transit by TLS): a scheduled item is
// only "due" once SERVER time has reached its send time. Offline → we fall back
// to device time (best-effort — can't verify, but nothing left the device).

import { SERVER_URL } from '../constants/server';

let _offsetMs = 0;      // serverNow - deviceNow
let _synced = false;

export async function syncServerTime(): Promise<boolean> {
  try {
    const res = await fetch(`${SERVER_URL}/health`, { method: 'GET' });
    const date = res.headers.get('date');
    if (!date) return false;
    const serverMs = new Date(date).getTime();
    if (!Number.isFinite(serverMs)) return false;
    _offsetMs = serverMs - Date.now();
    _synced = true;
    return true;
  } catch { return false; }
}

/** Best estimate of server time (device time until first successful sync). */
export function serverNow(): number {
  return Date.now() + (_synced ? _offsetMs : 0);
}

export function serverTimeSynced(): boolean { return _synced; }

/** True once the send instant has passed by TRUSTED time. Refreshes the sync
 *  first; if the server is unreachable, degrades to device time. */
export async function isDueByTrustedTime(sendAtMs: number): Promise<boolean> {
  await syncServerTime();
  return serverNow() >= sendAtMs;
}

export default { syncServerTime, serverNow, serverTimeSynced, isDueByTrustedTime };
