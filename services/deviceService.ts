import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const DEVICE_ID_KEY = "vc_device_id";
const KNOWN_DEVICES_KEY = "vc_known_devices";

// Generate a stable device fingerprint.
//
// ONE in-flight read, shared by every caller. The id is written once and is
// never deleted or rotated anywhere in the app (DEVICE_ID_KEY appears only in
// this file), so holding it for the life of the process cannot go stale; a
// process restart re-reads it.
//
// The measured effect is the duplicate Keystore round trip: boot has two
// independent callers - lib/api.ts's first request (which memoised its OWN
// call, so it could not help anyone else) and initFeatureFlags() - and the
// second read is pure waste.
//
// A shared promise also closes a lost-update window in principle: two callers
// that both complete the read before either write lands would each mint a
// SHA-256 and the later write would win, leaving the other caller holding an
// id the keystore does not have. That window was NOT reproduced against the
// old code (services/deviceId.selftest.ts case 2 passes either way, because a
// read that resolves after a write observes it), so it is stated here as a
// property this shape guarantees, not as a bug that was observed.
let _idPromise: Promise<string> | null = null;

export function getDeviceId(): Promise<string> {
  if (!_idPromise) {
    _idPromise = readOrCreateDeviceId().catch((err) => {
      // Never cache a FAILURE. A transient Keystore error (device locked
      // during boot, for one) must not poison the id for the whole process.
      _idPromise = null;
      throw err;
    });
  }
  return _idPromise;
}

async function readOrCreateDeviceId(): Promise<string> {
  const stored = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (stored) return stored;

  // Create fingerprint from platform info
  const raw = `${Platform.OS}_${Platform.Version}_${Date.now()}_${Math.random()}`;
  const id = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    raw
  );
  await SecureStore.setItemAsync(DEVICE_ID_KEY, id);
  return id;
}

// Check if current device is known/trusted
export async function isKnownDevice(
  uid: string,
  serverUrl: string
): Promise<boolean> {
  try {
    const deviceId = await getDeviceId();
    const response = await fetch(`${serverUrl}/api/face/check-device`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid, deviceId }),
    });
    const data = await response.json();
    return data.known === true;
  } catch {
    // If server unreachable, check local cache
    const cached = await SecureStore.getItemAsync(KNOWN_DEVICES_KEY);
    return cached === "trusted";
  }
}

// Mark current device as trusted after face verification
export async function trustCurrentDevice(
  uid: string,
  serverUrl: string
): Promise<void> {
  try {
    const deviceId = await getDeviceId();
    await fetch(`${serverUrl}/api/face/trust-device`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid, deviceId }),
    });
    await SecureStore.setItemAsync(KNOWN_DEVICES_KEY, "trusted");
  } catch {}
}

// Clear device trust (on logout or account wipe)
export async function clearDeviceTrust(): Promise<void> {
  await SecureStore.deleteItemAsync(KNOWN_DEVICES_KEY);
}

// Get device info for display
export function getDeviceInfo(): string {
  return `${Platform.OS} ${Platform.Version}`;
}
