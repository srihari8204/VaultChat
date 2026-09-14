// lib/callPrefs.ts — call preferences that survive restarts.
//
// Today: low-data mode (Phase 6 of openspec/changes/calls-sfu-platform).
//
// Same shape as lib/mediaPrefs.ts — a cached value so the call screen can read
// it synchronously while placing a call, AsyncStorage behind it. A call cannot
// wait on disk I/O to decide its encoder ceiling.

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'vc_call_low_data';

let cached = false;
AsyncStorage.getItem(KEY).then(v => { if (v != null) cached = v === '1'; }).catch(() => {});

/** Synchronous read for the call setup path. */
export function getLowDataModeCached(): boolean { return cached; }

export async function getLowDataMode(): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(KEY);
    if (v != null) cached = v === '1';
  } catch {}
  return cached;
}

export async function setLowDataMode(on: boolean): Promise<void> {
  cached = on;
  try { await AsyncStorage.setItem(KEY, on ? '1' : '0'); } catch {}
}

// ── hide my IP address ────────────────────────────────────────────────
//
// WebRTC hands the other party your candidates, and a host candidate IS your
// LAN address while a server-reflexive one is your public one. That is normal
// and is what makes a direct path possible — but it is also how a caller
// learns roughly where you are, and until now the app offered no way to say
// no. ON forces `iceTransportPolicy: 'relay'` (lib/iceConfig getIceConfig), so
// every packet goes through our coturn and the peer sees only its address.
//
// DEFAULT OFF. It costs relay bandwidth and a little latency, and — the part
// that matters — it makes a call IMPOSSIBLE when no TURN server is reachable,
// where today the call would still connect directly. getIceConfig fails with a
// retryable error rather than quietly dropping back to a direct path.

const HIDE_IP_KEY = 'vc_call_hide_ip';

let hideIp = false;
AsyncStorage.getItem(HIDE_IP_KEY).then(v => { if (v != null) hideIp = v === '1'; }).catch(() => {});

/** Synchronous read for the ICE setup path. */
export function getHideIpCached(): boolean { return hideIp; }

export async function getHideIp(): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(HIDE_IP_KEY);
    if (v != null) hideIp = v === '1';
  } catch {}
  return hideIp;
}

export async function setHideIp(on: boolean): Promise<void> {
  hideIp = on;
  try { await AsyncStorage.setItem(HIDE_IP_KEY, on ? '1' : '0'); } catch {}
}

export default {};
