// lib/spaces/deviceCommands.ts — what THIS phone does with a remote command
// queued for it in Spaces > Devices. Pure: the runtime that polls, acks and
// sends heartbeats is lib/spaces/deviceAgent.ts.
//
// Only what the app can do safely without Device Admin is performed:
//   ring    — the call ringtone plus vibration, with a Stop button
//   message — shown in an alert to whoever holds the phone
// Everything else is acknowledged as FAILED, so the owner's screen says it did
// not happen instead of "Waiting" forever:
//   lock, wipe — need Device Admin, which this app does not hold. The only
//                local "wipe" in the app destroys encryption keys, and doing
//                that on a remote request is not something to wire casually.
//   photo      — silently photographing whoever holds the phone is not built.
//   locate     — the position already travels sealed on the live-location
//                channel when the owner shares it; there is no separate
//                "send it now" path, and the server must never receive one.

import type { DeviceCommand } from './api';

/** One space device registered as being THIS handset. Stored on the device only. */
export interface DeviceBinding {
  spaceId: string;
  deviceId: string;
  /** The user who registered it; another account signed in here skips it. */
  ownerId: string;
  label: string;
}

export type CommandPlan =
  | { kind: 'ring' }
  | { kind: 'message'; text: string }
  | { kind: 'refuse'; result: 'failed' | 'cancelled' };

/** A ring is for finding a phone in the room; hours later it only alarms. */
export const RING_MAX_AGE_MS = 60 * 60_000;

export function planCommand(cmd: Pick<DeviceCommand, 'action' | 'payload' | 'issuedAt'>, nowMs: number): CommandPlan {
  switch (cmd.action) {
    case 'ring': {
      const at = Date.parse(cmd.issuedAt);
      if (Number.isFinite(at) && nowMs - at > RING_MAX_AGE_MS) return { kind: 'refuse', result: 'cancelled' };
      return { kind: 'ring' };
    }
    case 'message': {
      const text = (cmd.payload ?? '').trim().slice(0, 300);
      return text ? { kind: 'message', text } : { kind: 'refuse', result: 'failed' };
    }
    default:
      return { kind: 'refuse', result: 'failed' };
  }
}

/** Commands still waiting for this device, oldest first, minus ones already handled this session. */
export function openCommands(cmds: DeviceCommand[], handled: ReadonlySet<number>): DeviceCommand[] {
  return cmds
    .filter((c) => (c.result === 'issued' || c.result === 'delivered') && !handled.has(c.id))
    .sort((a, b) => Date.parse(a.issuedAt) - Date.parse(b.issuedAt));
}

/** Stored bindings are data read back from disk: keep only well-formed rows. */
export function parseBindings(raw: string | null): DeviceBinding[] {
  try {
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list.filter((b: any) => b && typeof b.spaceId === 'string' && b.spaceId
      && typeof b.deviceId === 'string' && b.deviceId && typeof b.ownerId === 'string' && b.ownerId)
      .map((b: any) => ({ spaceId: b.spaceId, deviceId: b.deviceId, ownerId: b.ownerId, label: String(b.label ?? 'This phone') }));
  } catch { return []; }
}

const same = (a: Pick<DeviceBinding, 'spaceId' | 'deviceId'>, b: Pick<DeviceBinding, 'spaceId' | 'deviceId'>) =>
  a.spaceId === b.spaceId && a.deviceId === b.deviceId;

export function withBinding(list: DeviceBinding[], b: DeviceBinding): DeviceBinding[] {
  return [...list.filter((x) => !same(x, b)), b];
}

export function withoutBinding(list: DeviceBinding[], b: Pick<DeviceBinding, 'spaceId' | 'deviceId'>): DeviceBinding[] {
  return list.filter((x) => !same(x, b));
}
