// lib/speedTest.ts — the arithmetic behind app/network-test.tsx.
//
// Only requests that actually succeeded count. The screen used to add 80% of
// the requested size for a download that threw, and the full size for an
// upload whatever the server answered, so a phone with no connection still
// reported a speed. A metric with no successful sample is null, and the screen
// shows it as failed.

export interface TransferSample {
  /** The request completed with a 2xx response. */
  ok: boolean;
  /** Bytes actually moved (the received body, or the uploaded body on success). */
  bytes: number;
  /** Wall time for the request. */
  ms: number;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Megabits per second over the successful samples, or null when none succeeded. */
export function throughputMbps(samples: readonly TransferSample[]): number | null {
  let bytes = 0;
  let ms = 0;
  for (const s of samples) {
    if (!s.ok || !(s.bytes > 0) || !(s.ms > 0)) continue;
    bytes += s.bytes;
    ms += s.ms;
  }
  if (ms === 0) return null;
  return round2((bytes * 8) / (ms / 1000) / 1_000_000);
}

/** Mean round trip and mean absolute deviation (jitter) over the successful pings, or null. */
export function pingStats(roundTripsMs: readonly (number | null)[]): { ping: number; jitter: number } | null {
  const ok = roundTripsMs.filter((x): x is number => typeof x === 'number' && x >= 0);
  if (ok.length === 0) return null;
  const avg = ok.reduce((a, b) => a + b, 0) / ok.length;
  const jitter = ok.reduce((a, b) => a + Math.abs(b - avg), 0) / ok.length;
  return { ping: Math.round(avg), jitter: Math.round(jitter) };
}
