// lib/batteryOptimization.ts — OEM background-survival helpers.
//
// Indian-market OEMs (Xiaomi/MIUI, Oppo/Realme/ColorOS, Vivo/FuntouchOS,
// Honor/Huawei, Samsung) aggressively kill backgrounded apps, which stops call
// pushes from ringing. Two things help:
//   1. Ask the OS to exempt crazzychat from battery optimization.
//   2. Deep-link the user to the OEM's Auto-start / Background-allowed page,
//      which is the setting that actually matters on these phones (and which no
//      API can toggle for you — the user must flip it).

import { Platform } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';
import DeviceInfo from 'react-native-device-info';

const APP_PACKAGE = 'com.vaultchat.app';

export type Manufacturer =
  | 'xiaomi' | 'oppo' | 'realme' | 'vivo' | 'huawei' | 'honor' | 'samsung' | 'oneplus' | 'other';

export async function getManufacturer(): Promise<Manufacturer> {
  try {
    const m = (await DeviceInfo.getManufacturer()).toLowerCase();
    if (m.includes('xiaomi') || m.includes('redmi') || m.includes('poco')) return 'xiaomi';
    if (m.includes('oppo')) return 'oppo';
    if (m.includes('realme')) return 'realme';
    if (m.includes('vivo') || m.includes('iqoo')) return 'vivo';
    if (m.includes('huawei')) return 'huawei';
    if (m.includes('honor')) return 'honor';
    if (m.includes('samsung')) return 'samsung';
    if (m.includes('oneplus')) return 'oneplus';
    return 'other';
  } catch { return 'other'; }
}

/**
 * IS the app currently exempt from battery optimization?
 *
 * The counterpart to requestIgnoreBatteryOptimizations below, and the reason
 * the native VaultPower module exists: until this, the app could ASK for the
 * exemption but never read the answer, so it asked and then assumed. That is
 * the same "reported success while doing nothing" shape that hid a dead
 * background location service for an entire session.
 *
 * Returns TRUE when unknown — on iOS, on a build without the native module, or
 * if the platform call fails. A false alarm telling someone their location
 * sharing is broken when it is fine is worse than staying quiet: this value
 * only ever decides whether to WARN.
 */
export async function isIgnoringBatteryOptimizations(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NativeModules } = require('react-native');
    const mod = NativeModules?.VaultPower;
    if (!mod?.isIgnoringBatteryOptimizations) return true;
    return await mod.isIgnoringBatteryOptimizations();
  } catch { return true; }
}

/** Is the device in system-wide power-save mode? Throttles background location
 *  on top of any per-app exemption, so it is a separate question. */
export async function isPowerSaveMode(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NativeModules } = require('react-native');
    const mod = NativeModules?.VaultPower;
    if (!mod?.isPowerSaveMode) return false;
    return await mod.isPowerSaveMode();
  } catch { return false; }
}

/** Ask the OS to exempt the app from battery optimization (system dialog). */
export async function requestIgnoreBatteryOptimizations(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await IntentLauncher.startActivityAsync(
      'android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
      { data: `package:${APP_PACKAGE}` },
    );
  } catch {
    // Fall back to the battery-optimization list if the direct request is blocked.
    try { await IntentLauncher.startActivityAsync('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS'); } catch {}
  }
}

// Per-OEM Auto-start / startup-manager activities. Tried in order; the first that
// resolves opens. These class names are stable but vary by OS version — if none
// resolve we fall back to the app's system settings page.
const AUTOSTART: Record<Manufacturer, Array<{ packageName: string; className: string }>> = {
  xiaomi: [
    { packageName: 'com.miui.securitycenter', className: 'com.miui.permcenter.autostart.AutoStartManagementActivity' },
  ],
  oppo: [
    { packageName: 'com.coloros.safecenter', className: 'com.coloros.safecenter.permission.startup.StartupAppListActivity' },
    { packageName: 'com.coloros.safecenter', className: 'com.coloros.safecenter.startupapp.StartupAppListActivity' },
    { packageName: 'com.oppo.safe', className: 'com.oppo.safe.permission.startup.StartupAppListActivity' },
  ],
  realme: [
    { packageName: 'com.coloros.safecenter', className: 'com.coloros.safecenter.permission.startup.StartupAppListActivity' },
    { packageName: 'com.coloros.safecenter', className: 'com.coloros.safecenter.startupapp.StartupAppListActivity' },
  ],
  vivo: [
    { packageName: 'com.vivo.permissionmanager', className: 'com.vivo.permissionmanager.activity.BgStartUpManagerActivity' },
    { packageName: 'com.iqoo.secure', className: 'com.iqoo.secure.ui.phoneoptimize.BgStartUpManager' },
  ],
  huawei: [
    { packageName: 'com.huawei.systemmanager', className: 'com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity' },
    { packageName: 'com.huawei.systemmanager', className: 'com.huawei.systemmanager.optimize.process.ProtectActivity' },
  ],
  honor: [
    { packageName: 'com.hihonor.systemmanager', className: 'com.hihonor.systemmanager.startupmgr.ui.StartupNormalAppListActivity' },
    { packageName: 'com.huawei.systemmanager', className: 'com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity' },
  ],
  samsung: [
    { packageName: 'com.samsung.android.lool', className: 'com.samsung.android.sm.battery.ui.BatteryActivity' },
    { packageName: 'com.samsung.android.sm', className: 'com.samsung.android.sm.ui.battery.BatteryActivity' },
  ],
  oneplus: [
    { packageName: 'com.oneplus.security', className: 'com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity' },
  ],
  other: [],
};

/** Open the OEM auto-start / startup-manager page (or app settings as fallback). */
export async function openAutoStartSettings(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const oem = await getManufacturer();
  for (const target of AUTOSTART[oem] || []) {
    try {
      await IntentLauncher.startActivityAsync('android.intent.action.MAIN', {
        packageName: target.packageName,
        className: target.className,
      });
      return true;
    } catch { /* try the next candidate */ }
  }
  // Fallback: the app's own settings page (Battery / Permissions live here).
  try {
    await IntentLauncher.startActivityAsync('android.settings.APPLICATION_DETAILS_SETTINGS', {
      data: `package:${APP_PACKAGE}`,
    });
    return true;
  } catch { return false; }
}

/** Whether this OEM needs the manual auto-start step (used to show the warning). */
export async function needsAutoStartGuidance(): Promise<boolean> {
  const oem = await getManufacturer();
  return oem !== 'other' && oem !== 'samsung'; // Samsung's "never sleeping apps" is softer
}

export type OemStep = { title: string; steps: string[] };

/** Step-by-step text shown on the Call Reliability screen, per OEM. */
export async function oemInstructions(): Promise<OemStep> {
  const oem = await getManufacturer();
  switch (oem) {
    case 'xiaomi': return { title: 'Xiaomi / Redmi / POCO (MIUI)', steps: [
      'Open the Autostart page (button below) and enable crazzychat.',
      'Settings → Apps → crazzychat → Battery saver → No restrictions.',
      'Recents screen → lock crazzychat (pull down on the card → padlock).',
    ]};
    case 'oppo': case 'realme': return { title: 'Oppo / Realme (ColorOS)', steps: [
      'Open Startup Manager (button below) and allow crazzychat.',
      'Settings → Battery → App Battery Management → crazzychat → Allow background activity.',
      'Recents → lock crazzychat.',
    ]};
    case 'vivo': return { title: 'Vivo / iQOO (FuntouchOS)', steps: [
      'Open Background startup (button below) and allow crazzychat.',
      'Settings → Battery → High background power consumption → enable crazzychat.',
      'i Manager → App manager → Autostart → enable crazzychat.',
    ]};
    case 'huawei': case 'honor': return { title: 'Honor / Huawei', steps: [
      'Open App launch (button below), turn OFF "Manage automatically" for crazzychat,',
      'then turn ON Auto-launch, Secondary launch, and Run in background.',
    ]};
    case 'samsung': return { title: 'Samsung (One UI)', steps: [
      'Settings → Battery → Background usage limits → Never sleeping apps → add crazzychat.',
      'Settings → Apps → crazzychat → Battery → Unrestricted.',
    ]};
    default: return { title: 'Battery optimization', steps: [
      'Allow crazzychat to ignore battery optimization (button below) so calls ring when the app is closed.',
    ]};
  }
}

export default {
  getManufacturer, requestIgnoreBatteryOptimizations, openAutoStartSettings,
  needsAutoStartGuidance, oemInstructions,
};
