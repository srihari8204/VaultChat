// lib/speedTarget.ts — which server app/network-test.tsx measures against.
//
// The app's own speed endpoints (GET /net/speed/down, POST /net/speed/up; see
// the backend's internal/routes/netspeed.go) when this server has them, and
// Cloudflare's public speed test — the behaviour before they existed — when it
// answers 404/405 (not deployed yet), cannot be reached, or turns the token
// down. Cloudflare sees the tester's IP address, so the screen discloses which
// one it used. A 429 is the app's own budget refusing the test: the screen says
// when to try again instead of quietly sending the test to a third party.
//
// Pure (no React Native imports) so speedTarget.selftest.ts runs under Node.

export interface SpeedTarget {
  kind: 'app' | 'cloudflare';
  /** Host shown in the disclosure line. */
  host: string;
  downUrl: (bytes: number) => string;
  upUrl: string;
  /** Round-trip probe: an empty body on ours, one byte on Cloudflare's. */
  pingUrl: string;
  /** Sent with every request (the app endpoints need the bearer token). */
  headers: Record<string, string>;
}

export const CLOUDFLARE_HOST = 'speed.cloudflare.com';

export function cloudflareTarget(): SpeedTarget {
  const down = (bytes: number) => `https://${CLOUDFLARE_HOST}/__down?bytes=${bytes}`;
  return { kind: 'cloudflare', host: CLOUDFLARE_HOST, downUrl: down, upUrl: `https://${CLOUDFLARE_HOST}/__up`, pingUrl: down(1), headers: {} };
}

export function appTarget(serverUrl: string, token: string): SpeedTarget {
  const base = serverUrl.replace(/\/+$/, '');
  const down = (bytes: number) => `${base}/net/speed/down?bytes=${bytes}`;
  return {
    kind: 'app',
    // Not `new URL(...).host`: React Native's URL does not implement it.
    host: base.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, ''),
    downUrl: down,
    upUrl: `${base}/net/speed/up`,
    pingUrl: down(0),
    headers: { Authorization: `Bearer ${token}` },
  };
}

/**
 * What the HEAD probe of the app endpoint means. `status` is null when the
 * request never got an answer.
 */
export function probeVerdict(status: number | null): 'app' | 'fallback' | 'rate_limited' {
  if (status !== null && status >= 200 && status < 300) return 'app';
  if (status === 429) return 'rate_limited';
  // 404/405: not deployed yet. 401: the token was refused. 5xx or no answer:
  // it cannot run here. Each keeps today's behaviour.
  return 'fallback';
}

/** The sentence for a 429, from its Retry-After header (seconds). */
export function rateLimitMessage(retryAfter: string | null): string {
  const s = Number(retryAfter);
  if (!retryAfter || !Number.isFinite(s) || s <= 0) return 'Too many speed tests. Try again later.';
  const min = Math.max(1, Math.ceil(s / 60));
  return `Too many speed tests. Try again in ${min} min.`;
}

/** The server label a history row is filed under; rows saved before it was recorded share one. */
export const UNRECORDED_SERVER = 'Server not recorded';
export const historyServer = (row: { server?: string }): string => row.server || UNRECORDED_SERVER;

/**
 * The servers a history list was measured by, most recent first. Results from
 * different servers are not comparable, so the screen offers these as a filter
 * once there is more than one.
 */
export function historyServers(rows: { server?: string }[]): string[] {
  const out: string[] = [];
  for (const r of rows) { const s = historyServer(r); if (!out.includes(s)) out.push(s); }
  return out;
}

/** Rows measured by `server`, or every row when `server` is null or no longer present. */
export function filterHistory<T extends { server?: string }>(rows: T[], server: string | null): T[] {
  if (server === null || !rows.some(r => historyServer(r) === server)) return rows;
  return rows.filter(r => historyServer(r) === server);
}
