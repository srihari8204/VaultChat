// lib/breachCheck.ts — real, shared breach-check helpers (Have I Been Pwned).
//
// Used by app/dark-web-guard.tsx and app/breachguard.tsx. No fabricated data:
//   • Password check is KEYLESS — HIBP "Pwned Passwords" range API with
//     k-anonymity: only a 5-char SHA-1 prefix leaves the device, never the
//     password itself.
//   • Email breach check uses the HIBP breach API, which requires the user's own
//     (paid) API key, stored on-device. Without a key the caller asks for one
//     rather than inventing results.

import * as Crypto from 'expo-crypto';
import { api } from './api';

export interface Breach {
  name: string;
  domain: string;
  breachDate: string;
  pwnCount: number;
  dataClasses: string[];
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

/** Real keyless password breach count (HIBP range API, k-anonymity). */
export async function checkPasswordPwned(password: string): Promise<number> {
  const hash = (await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA1, password)).toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, { headers: { 'Add-Padding': 'true' } });
  if (!res.ok) throw new Error('Breach service unavailable');
  const text = await res.text();
  for (const line of text.split('\n')) {
    const [suf, count] = line.trim().split(':');
    if (suf === suffix) return parseInt(count, 10) || 0;
  }
  return 0;
}

/** Real email breach list (HIBP breach API — needs the user's paid key). */
export async function checkEmailBreaches(email: string, key: string): Promise<Breach[]> {
  const res = await fetch(
    `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=false`,
    { headers: { 'hibp-api-key': key, 'User-Agent': 'crazzychat-SecurityApp' } },
  );
  if (res.status === 404) return [];
  if (res.status === 401) throw new Error('Invalid HIBP API key');
  if (res.status === 429) throw new Error('Rate limited — wait a minute');
  if (!res.ok) throw new Error(`HIBP error: ${res.status}`);
  const data = await res.json();
  return (data as any[]).map((b): Breach => ({
    name: b.Name,
    domain: b.Domain,
    breachDate: b.BreachDate,
    pwnCount: b.PwnCount,
    dataClasses: b.DataClasses || [],
    description: (b.Description || '').replace(/<[^>]*>/g, ''),
    severity: b.PwnCount > 100_000_000 ? 'critical' : b.PwnCount > 10_000_000 ? 'high' : b.PwnCount > 1_000_000 ? 'medium' : 'low',
  }));
}

/** Compact pwn-count formatter (1.2B / 4.5M / 12K). */
export const fmtCount = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : `${n}`;

// ─── Breach-monitor watch list (backed by /user/breach-monitors) ─────────────

export interface BreachMonitor {
  id: number;
  targetType: string;
  target: string;
  breachCount: number;
  lastCheckedAt: string | null;
  createdAt: string;
}

export async function listMonitors(): Promise<BreachMonitor[]> {
  const r = await api<{ monitors: BreachMonitor[] }>('/user/breach-monitors');
  return r?.monitors ?? [];
}

export async function addMonitor(target: string): Promise<BreachMonitor> {
  const r = await api<{ monitor: BreachMonitor }>('/user/breach-monitors', { method: 'POST', json: { target } });
  return r.monitor;
}

export async function removeMonitor(id: number): Promise<void> {
  await api(`/user/breach-monitors/${id}`, { method: 'DELETE' });
}

/** Record a scan result (breach count) for a monitor; sets last_checked_at server-side. */
export async function recordMonitorScan(id: number, breachCount: number): Promise<void> {
  await api(`/user/breach-monitors/${id}`, { method: 'PATCH', json: { breachCount } });
}
