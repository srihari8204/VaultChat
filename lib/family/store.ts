// lib/family/store.ts — local persistence for Family Circle. All device-local
// (AsyncStorage): which groups are Circles, each Circle's Places (geofences), and
// my sharing settings. None of this goes to the server — a Circle rides on an
// existing group, and Places/settings are private on-device state.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { type Geofence } from './geofence';
import { type FamilySettings, DEFAULT_FAMILY_SETTINGS } from './types';

const K_CIRCLES = 'vc_family_circles_v1';
const K_SETTINGS = 'vc_family_settings_v1';
const kPlaces = (cid: string) => `vc_family_places_${cid}`;

export interface CircleRef { id: string; name: string }

async function readJSON<T>(key: string, fallback: T): Promise<T> {
  try { const raw = await AsyncStorage.getItem(key); return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; }
}

export async function listCircles(): Promise<CircleRef[]> { return readJSON<CircleRef[]>(K_CIRCLES, []); }

export async function addCircle(c: CircleRef): Promise<void> {
  const all = await listCircles();
  const next = [c, ...all.filter((x) => x.id !== c.id)];
  await AsyncStorage.setItem(K_CIRCLES, JSON.stringify(next));
}

export async function removeCircle(id: string): Promise<void> {
  const all = await listCircles();
  await AsyncStorage.setItem(K_CIRCLES, JSON.stringify(all.filter((x) => x.id !== id)));
  await AsyncStorage.removeItem(kPlaces(id));
}

export async function getPlaces(circleId: string): Promise<Geofence[]> { return readJSON<Geofence[]>(kPlaces(circleId), []); }
export async function setPlaces(circleId: string, places: Geofence[]): Promise<void> {
  await AsyncStorage.setItem(kPlaces(circleId), JSON.stringify(places));
}

export async function getSettings(): Promise<FamilySettings> {
  return { ...DEFAULT_FAMILY_SETTINGS, ...(await readJSON<Partial<FamilySettings>>(K_SETTINGS, {})) };
}
export async function setSettings(patch: Partial<FamilySettings>): Promise<FamilySettings> {
  const next = { ...(await getSettings()), ...patch };
  await AsyncStorage.setItem(K_SETTINGS, JSON.stringify(next));
  return next;
}

/** Which of my places leads my published reference distance in this circle. */
export async function getDefaultRef(circleId: string): Promise<string | null> {
  return (await getSettings()).defaultRef?.[circleId] ?? null;
}

/** Choose (or clear, with null) my reference place for one circle. */
export async function setDefaultRef(circleId: string, placeName: string | null): Promise<void> {
  const cur = (await getSettings()).defaultRef ?? {};
  const next = { ...cur };
  if (placeName) next[circleId] = placeName; else delete next[circleId];
  await setSettings({ defaultRef: next });
}
