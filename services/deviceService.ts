import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const DEVICE_ID_KEY = "vc_device_id";
const KNOWN_DEVICES_KEY = "vc_known_devices";

// Generate a stable device fingerprint
export async function getDeviceId(): Promise<string> {
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
