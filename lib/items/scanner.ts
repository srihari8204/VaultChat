// lib/items/scanner.ts — the one impure module: BLE discovery.
//
// Wraps react-native-ble-plx behind a tiny surface so the screens never touch
// the native manager, and so the pure halves (proximity, leftBehind) stay
// runnable under tsx. Vendor-neutral: it lists whatever advertises nearby —
// any BLE tag, beacon or fob — because a finder locked to one brand's
// protocol is a finder you have to buy a brand for.
//
// The manager is created LAZILY. Constructing a BleManager at import time
// initialises the native stack on every launch, including for the vast
// majority of sessions that never open the item screen — and on a device with
// Bluetooth off it throws where nothing is ready to catch it.

import { Platform, PermissionsAndroid } from 'react-native';

export interface Seen {
  id: string;
  name: string | null;
  rssi: number;
  at: number;
}

let manager: any = null;
let scanning = false;

function bleManager(): any {
  if (manager) return manager;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BleManager } = require('react-native-ble-plx');
  if (typeof BleManager !== 'function') throw new Error('BLE module not linked in this build');
  manager = new BleManager();
  return manager;
}

/**
 * True when this build actually has the native BLE module linked.
 *
 * CONSTRUCTS the manager rather than checking that the class exists: the JS
 * class ships in the package whether or not the native side linked, so a
 * truthiness check passes on a build that then throws on `new BleManager()`.
 * That throw escaped an async caller as an unhandled rejection and the button
 * did nothing at all — no error, no dialog (device-diagnosed 2026-08-22).
 */
export function isBleAvailable(): boolean {
  try { return !!bleManager(); } catch { return false; }
}

/** The last construction/scan failure, for a screen that wants to say why. */
let lastError: string | null = null;
export function bleLastError(): string | null { return lastError; }

/**
 * Ask for what scanning needs. On Android 12+ that is BLUETOOTH_SCAN, which
 * is a runtime permission distinct from the legacy location grant — declaring
 * it `neverForLocation` in the manifest is what keeps this off the location
 * path. Older Androids derive scan rights from fine location, which this app
 * already holds for the family map.
 */
export async function ensureBlePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  try {
    const api = Number(Platform.Version);
    if (api >= 31) {
      const res = await PermissionsAndroid.requestMultiple([
        'android.permission.BLUETOOTH_SCAN' as any,
        'android.permission.BLUETOOTH_CONNECT' as any,
      ]);
      return Object.values(res).every((v) => v === PermissionsAndroid.RESULTS.GRANTED);
    }
    const g = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
    return g === PermissionsAndroid.RESULTS.GRANTED;
  } catch { return false; }
}

/** Is the radio actually on? A scan with Bluetooth off silently returns nothing. */
export async function isBluetoothOn(): Promise<boolean> {
  try { return (await bleManager().state()) === 'PoweredOn'; }
  catch (e: any) { lastError = String(e?.message || e); return false; }
}

/**
 * Start scanning. `onSeen` fires for every advertisement — including repeats
 * from the same device, which is exactly what the proximity smoother wants.
 * Returns a stop function; calling it twice is safe.
 */
export async function startScan(onSeen: (s: Seen) => void): Promise<() => void> {
  // NEVER let a native failure escape as an unhandled rejection: the caller is
  // async, so a throw here silently did nothing on screen.
  let m: any;
  try { m = bleManager(); }
  catch (e: any) { lastError = String(e?.message || e); return () => {}; }
  if (scanning) { try { m.stopDeviceScan(); } catch {} }
  scanning = true;
  m.startDeviceScan(null, { allowDuplicates: true }, (err: any, dev: any) => {
    if (err || !dev?.id) return;
    if (typeof dev.rssi !== 'number') return;
    onSeen({ id: String(dev.id), name: dev.name ?? dev.localName ?? null, rssi: dev.rssi, at: Date.now() });
  });
  return () => {
    if (!scanning) return;
    scanning = false;
    try { m.stopDeviceScan(); } catch {}
  };
}

/** Release the native manager (called when the feature screen unmounts for
 *  good). Leaving it alive keeps the radio warm for no reason. */
export function destroyScanner(): void {
  try { manager?.destroy?.(); } catch {}
  manager = null;
  scanning = false;
}

export default {};
