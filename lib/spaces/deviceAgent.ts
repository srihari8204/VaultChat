// lib/spaces/deviceAgent.ts — the DEVICE side of Spaces > Devices.
//
// The backend has always had GET /commands, PATCH /commands/{id} (ack) and
// POST /heartbeat, and says a command is "collected from GET /commands on its
// next connection" — but nothing in the app collected it, so every command sat
// at "Waiting" forever and lastSeenAt never moved. This is that collector.
//
// While the app is in the foreground, every POLL_MS, for each space device this
// handset was registered as (bindings live on this device only):
//   1. heartbeat — proof of life plus battery, NO position (spaces_devices.go)
//   2. read open commands and act on them, acknowledging delivered → executed,
//      or failed/cancelled for what this app cannot do (see deviceCommands.ts)
// A heartbeat refused with 403/404 means the device row is gone or no longer
// this user's, so the binding is dropped.
//
// Foreground only: there is no background fetch here, so a phone in a drawer
// picks its commands up the next time the app is opened — which is what the
// devices screen already tells the owner.

import { useEffect } from 'react';
import { Alert, AppState } from 'react-native';
import { getCachedUser } from '../api';
import { getDeviceCommands, ackDeviceCommand, deviceHeartbeat, type DeviceCommand } from './api';
import {
  planCommand, openCommands, parseBindings, withBinding, withoutBinding, type DeviceBinding,
} from './deviceCommands';
import { readBattery } from '../family/battery';
import { startRingtone, stopRingtone } from '../sounds';

/** Well inside the server's 15-minute staleness window (space_device_stale). */
const POLL_MS = 2 * 60_000;
const RING_MS = 30_000;
const KEY = 'vc_space_device_bindings_v1';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const storage = () => require('@react-native-async-storage/async-storage').default;

async function loadBindings(): Promise<DeviceBinding[]> {
  try { return parseBindings(await storage().getItem(KEY)); } catch { return []; }
}
async function saveBindings(list: DeviceBinding[]): Promise<void> {
  try { await storage().setItem(KEY, JSON.stringify(list)); } catch { /* best-effort */ }
}

/** Register a space device as THIS handset, and collect its commands at once. */
export async function bindThisPhone(b: DeviceBinding): Promise<void> {
  await saveBindings(withBinding(await loadBindings(), b));
  void tick();
}

export async function unbindThisPhone(b: Pick<DeviceBinding, 'spaceId' | 'deviceId'>): Promise<void> {
  await saveBindings(withoutBinding(await loadBindings(), b));
}

export async function isBoundHere(spaceId: string, deviceId: string): Promise<boolean> {
  return (await loadBindings()).some((x) => x.spaceId === spaceId && x.deviceId === deviceId);
}

// Commands handled in this app session, so a failed ack is not acted on twice.
const handled = new Set<number>();
let running = false;

async function perform(b: DeviceBinding, cmd: DeviceCommand): Promise<void> {
  handled.add(cmd.id);
  const plan = planCommand(cmd, Date.now());
  const ack = (r: 'delivered' | 'executed' | 'failed' | 'cancelled') =>
    ackDeviceCommand(b.spaceId, b.deviceId, cmd.id, r);
  if (plan.kind === 'refuse') { await ack(plan.result).catch(() => {}); return; }
  // Claim it first: a 409 means another session already took it.
  try { await ack('delivered'); } catch (e: any) { if (e?.status === 409) return; }
  if (plan.kind === 'ring') {
    await startRingtone().catch(() => {});
    const timer = setTimeout(() => { void stopRingtone(); }, RING_MS);
    Alert.alert(
      `${b.label} is ringing`,
      'Its owner asked it to ring from Spaces > Devices.',
      [{ text: 'Stop', onPress: () => { clearTimeout(timer); void stopRingtone(); } }],
    );
  } else {
    // Plain text from the device's owner, shown as data in a system alert.
    Alert.alert('Message from this phone’s owner', plan.text);
  }
  await ack('executed').catch(() => {});
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const me = await getCachedUser().catch(() => null);
    const myId = me?.id != null ? String(me.id) : '';
    if (!myId) return;
    let bindings = await loadBindings();
    if (!bindings.length) return; // not registered as a space device: nothing to do
    const battery = (await readBattery()).level;
    for (const b of bindings) {
      if (b.ownerId !== myId) continue; // another account's phone binding
      try {
        await deviceHeartbeat(b.spaceId, b.deviceId, battery);
      } catch (e: any) {
        if (e?.status === 403 || e?.status === 404) {
          bindings = withoutBinding(bindings, b);
          await saveBindings(bindings);
        }
        continue;
      }
      const cmds = await getDeviceCommands(b.spaceId, b.deviceId).catch(() => [] as DeviceCommand[]);
      for (const c of openCommands(cmds, handled)) await perform(b, c);
    }
  } finally {
    running = false;
  }
}

/**
 * Mount once at the app root. Polls only while the app is active, and checks
 * immediately on every return to the foreground.
 */
export function useSpaceDeviceAgent(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      void tick();
      timer = setInterval(() => { void tick(); }, POLL_MS);
    };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    if (AppState.currentState === 'active') start();
    const sub = AppState.addEventListener('change', (s) => (s === 'active' ? start() : stop()));
    return () => { stop(); sub.remove(); };
  }, []);
}
