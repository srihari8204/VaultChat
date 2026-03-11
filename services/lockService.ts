import * as SecureStore from "expo-secure-store";
import { AppStateStatus } from "react-native";

const KEY = "vc_session_active";

export async function recordAuthTime(): Promise<void> {
  await SecureStore.setItemAsync(KEY, "true");
}

export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}

export async function shouldLock(): Promise<boolean> {
  try {
    const active = await SecureStore.getItemAsync(KEY);
    return active !== "true";
  } catch {
    return true;
  }
}

export async function checkLockOnResume(state: AppStateStatus): Promise<boolean> {
  if (state === "background" || state === "inactive") {
    await clearSession();
    return false;
  }
  if (state === "active") {
    return shouldLock();
  }
  return false;
}
