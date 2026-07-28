// lib/networkStateStore.ts — persisted network-state, keyed by link fingerprint.
//
// networkState.ts is pure; this is the thin glue that (a) remembers the EWMA
// throughput + bucket ACROSS transfers so the next one starts at the right chunk
// size instead of ramping from scratch (the "predictive pre-sizing" idea), and
// (b) records per-block samples during a transfer. Keyed by a coarse network
// fingerprint (wifi vs cellular) so a WiFi history doesn't mis-size a 4G transfer.
//
// The hysteresis + ratchet rules all live in networkState.sample(); this only
// loads → sample() → saves. No decisions here.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { type NetState, initNetState, sample as _sample, geometry as _geometry, noteBackground as _bg } from './networkState';

const KEY = 'vc_netstate_v1';   // fingerprint → NetState

type Store = Record<string, NetState>;
async function load(): Promise<Store> {
  try { return JSON.parse((await AsyncStorage.getItem(KEY)) || '{}'); } catch { return {}; }
}
let saveT: any = null;
let cache: Store | null = null;
function persistSoon(s: Store) {
  cache = s;
  if (saveT) return;
  saveT = setTimeout(() => { saveT = null; AsyncStorage.setItem(KEY, JSON.stringify(cache)).catch(() => {}); }, 500);
}

/** Coarse fingerprint — a WiFi history must not size a cellular transfer. */
export function fingerprint(linkType?: string | null): string {
  return linkType === 'wifi' || linkType === 'ethernet' ? 'fixed' : 'cellular';
}

async function get(fp: string): Promise<NetState> {
  const all = cache ?? (cache = await load());
  return all[fp] ?? initNetState();
}
function put(fp: string, s: NetState) {
  const all = cache ?? {};
  all[fp] = s;
  persistSoon(all);
}

/** Geometry the NEXT transfer on this link should start with (from history). */
export async function startingGeometry(linkType?: string | null): Promise<{ chunkBytes: number; blockBytes: number }> {
  return _geometry(await get(fingerprint(linkType)));
}

/** Load this link's live NetState (v2 sender samples it per-block to pick each
 *  segment's size). Save it back at the end so the history carries forward. */
export async function loadState(linkType?: string | null): Promise<NetState> { return get(fingerprint(linkType)); }
export async function saveState(linkType: string | null | undefined, s: NetState): Promise<void> { put(fingerprint(linkType), s); }
export { type NetState } from './networkState';

/** Fold one completed-block measurement into this link's history. `collapse`
 *  forces an immediate step-down (a stalled / failed block). */
export async function recordSample(
  linkType: string | null | undefined,
  bytes: number, elapsedMs: number, nowMs: number, collapse = false,
): Promise<void> {
  const fp = fingerprint(linkType);
  put(fp, _sample(await get(fp), { bytes, elapsedMs, nowMs }, collapse));
}

/** Tell this link's history to ignore samples briefly (app just backgrounded). */
export async function noteBackground(linkType: string | null | undefined, nowMs: number): Promise<void> {
  const fp = fingerprint(linkType);
  put(fp, _bg(await get(fp), nowMs));
}

export default {};
