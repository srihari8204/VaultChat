// lib/nav/geocode.ts — address → candidates via our own /nav/geocode proxy
// (Photon/OSM upstream, box-side; see internal/routes/nav.go). Works on no-GMS
// devices where Location.geocodeAsync is dead. Debounce lives with the caller.

import { api } from '../api';

export interface GeoHit { name: string; label: string; lat: number; lng: number }

export async function geocodeSearch(q: string, near?: { lat: number; lng: number } | null): Promise<GeoHit[]> {
  const p = new URLSearchParams({ q: q.trim() });
  if (near) { p.set('lat', String(near.lat)); p.set('lon', String(near.lng)); }
  const hits = await api<GeoHit[]>(`/nav/geocode?${p.toString()}`);
  return Array.isArray(hits) ? hits : [];
}
