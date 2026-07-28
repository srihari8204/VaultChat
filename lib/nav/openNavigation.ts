// lib/nav/openNavigation.ts — one entry point to the in-app haptic navigation.
// Call this anywhere a coordinate is shown (chat location bubble, live-location
// banner, location viewer, SOS, contact/group info, a maps mini-app) instead of
// bouncing out to Google Maps — the in-app route works on no-GMS devices too and
// drives the haptic guidance. Uses the expo-router singleton so plain modules can
// trigger it without a hook.

import { router } from 'expo-router';
import { coordsFromUrl } from './urlCoords';

export { coordsFromUrl };

export function navigateTo(lat: number, lng: number, name?: string): void {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  router.push({
    pathname: '/navigate' as any,
    params: { lat: String(lat), lng: String(lng), ...(name ? { name } : {}) },
  });
}

/** Open the destination picker (no preset target) — e.g. from the attach menu. */
export function openNavigator(): void {
  router.push('/navigate' as any);
}

/** If `url` is a location link, open in-app nav and return true; else false (caller falls back to the browser). */
export function navigateFromUrl(url: string, name?: string): boolean {
  const c = coordsFromUrl(url);
  if (!c) return false;
  navigateTo(c.lat, c.lng, name);
  return true;
}

export default {};
