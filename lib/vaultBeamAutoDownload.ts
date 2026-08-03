// lib/vaultBeamAutoDownload.ts — VaultBeam auto-download policy engine.
//
// Pure decision: given a transfer's size + sender and the user's settings +
// live network/battery, decide whether to auto-accept. The 2.5 GB system ceiling
// (VB_AUTO_MAX_BYTES) is enforced FIRST and independently of user settings; the
// 12 GB cap rejects outright. Everything here is best-effort and fail-safe: any
// uncertainty resolves to Manual (never auto).

import NetInfo from '@react-native-community/netinfo';
import { VB_AUTO_MAX_BYTES } from '../constants/flags';
import { MAX_BYTES } from './vaultbeamRelay';
import type { VBSettings } from './vaultBeamSettings';
import { isContactVerified } from '../services/trustedContactService';

export interface AutoDecision { auto: boolean; reason: string }

const no = (reason: string): AutoDecision => ({ auto: false, reason });
const yes: AutoDecision = { auto: true, reason: 'ok' };

export interface BatteryState { level: number | null; charging: boolean; lowPower: boolean }

/** Best-effort battery read (expo-battery is already a dependency). */
export async function readBattery(): Promise<BatteryState> {
  try {
    const B = require('expo-battery');
    const s = await B.getPowerStateAsync();
    return {
      level: typeof s?.batteryLevel === 'number' ? s.batteryLevel : null,
      charging: s?.batteryState === B.BatteryState?.CHARGING || s?.batteryState === B.BatteryState?.FULL,
      lowPower: !!s?.lowPowerMode,
    };
  } catch { return { level: null, charging: false, lowPower: false }; }
}

/**
 * Decide whether an incoming transfer should auto-download. Size gate is applied
 * before anything else so the 2.5 GB ceiling can never be bypassed by settings.
 */
export async function shouldAutoDownload(
  input: { size: number; senderId: string | null | undefined },
  settings: VBSettings,
): Promise<AutoDecision> {
  const { size } = input;

  // ── size gate (first + independent of settings) ──
  if (!(size > 0)) return no('unknown size');
  if (size > MAX_BYTES) return no('exceeds 12 GB limit');
  if (size >= VB_AUTO_MAX_BYTES) return no('large file (≥ 2.5 GB) — manual approval required');

  // ── mode ──
  if (settings.mode !== 'auto') return no('manual mode');

  // ── user size cap (already clamped ≤ 2.5 GB in settings) ──
  if (size > settings.maxBytes) return no('over your auto-download size limit');

  // ── sender trust ──
  if (settings.trustedOnly) {
    if (!input.senderId) return no('unknown sender');
    const verified = await isContactVerified(input.senderId).catch(() => false);
    if (!verified) return no('sender not a trusted contact');
  }

  // ── network ──
  let net: any = null;
  try { net = await NetInfo.fetch(); } catch { net = null; }
  const type = net?.type ?? null;                 // 'wifi' | 'cellular' | ...
  const isWifi = type === 'wifi';
  const isCellular = type === 'cellular';
  const expensive = net?.details?.isConnectionExpensive === true || isCellular;

  if (!net || net.isConnected === false) return no('no network');
  if (settings.network === 'wifi' && !isWifi) return no('waiting for Wi-Fi');
  if (settings.network === 'cellular' && !isCellular) return no('waiting for mobile data');
  if (settings.unmeteredOnly && expensive) return no('metered network');
  // Roaming pause is best-effort: NetInfo doesn't reliably expose roaming, so we
  // treat a metered/expensive cellular link as the proxy handled above.

  // ── battery (expo-battery present; best-effort) ──
  if (settings.onlyCharging || settings.notLowBattery) {
    const b = await readBattery();
    if (settings.onlyCharging && !b.charging) return no('waiting to charge');
    if (settings.notLowBattery && !b.charging && b.level != null && b.level >= 0 && b.level < 0.2) return no('battery low');
    if (settings.notLowBattery && b.lowPower && !b.charging) return no('low-power mode');
  }

  return yes;
}

export default { shouldAutoDownload, readBattery };
