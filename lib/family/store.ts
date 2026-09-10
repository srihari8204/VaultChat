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
// Message ids whose family event this device has already turned into an alert.
// Without it, every re-fetch of the circle's recent messages would re-raise the
// same crossing — recordAlert's 60 s dedupe window is far too short to cover a
// screen the user reopens an hour later.
const kIngested = (cid: string) => `vc_family_ingested_${cid}`;
const MAX_INGESTED = 200;

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
  await AsyncStorage.removeItem(kIngested(id));
}

/** Ids of circle messages already ingested as family alerts (newest last). */
export async function getIngested(circleId: string): Promise<string[]> {
  return readJSON<string[]>(kIngested(circleId), []);
}

/** Remember `ids` as ingested, keeping only the newest MAX_INGESTED. */
export async function addIngested(circleId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const have = await getIngested(circleId);
  const merged = [...have.filter((id) => !ids.includes(id)), ...ids];
  const next = merged.length > MAX_INGESTED ? merged.slice(merged.length - MAX_INGESTED) : merged;
  try { await AsyncStorage.setItem(kIngested(circleId), JSON.stringify(next)); } catch {}
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
