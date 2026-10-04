// lib/nav/geocode.ts — address → candidates via our own /nav/geocode proxy
// (Photon/OSM upstream, box-side; see internal/routes/nav.go). Works on no-GMS
// devices where Location.geocodeAsync is dead. Debounce lives with the caller.

import { api } from '../api';
import { coarseLatLng } from './geo';

export interface GeoHit { name: string; label: string; lat: number; lng: number }

export async function geocodeSearch(q: string, near?: { lat: number; lng: number } | null): Promise<GeoHit[]> {
  const p = new URLSearchParams({ q: q.trim() });
  // The bias point is rounded to about 1 km: it only ranks suggestions, so the
  // server proxy never needs the exact position.
  if (near) { const c = coarseLatLng(near); p.set('lat', String(c.lat)); p.set('lon', String(c.lng)); }
  const hits = await api<GeoHit[]>(`/nav/geocode?${p.toString()}`);
  return Array.isArray(hits) ? hits : [];
}
