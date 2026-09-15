// lib/syncMetrics.ts — counters that prove local-first on a real device.
//
// The claim "scroll-back no longer hits the server" is not observable from a
// screen: both the cached page and the network page render identically. The
// only difference is whether a request happened, so the difference has to be
// counted.
//
// Deliberately tiny: in-memory, no persistence, no upload, no timers. It exists
// to be read from a logcat line during an acceptance run and to back a number
// in a report instead of a guess. A counter that costs anything would not be
// worth having.
//
// ponytail: in-memory only, so a process restart resets it. Persist to the kv
// table only if these ever need to survive a crash.

export type SyncMetric =
  // delta / cold sync
  | 'delta.requests' | 'delta.rows' | 'delta.duplicates' | 'delta.decrypts'
  | 'delta.page_cap_yields'
  // Rows kept as raw envelopes because hydration threw. Non-zero means some
  // message could not be opened AND the page was saved anyway - which is the
  // whole point: before this existed the throw discarded the page and
  // catch-up stalled permanently.
  | 'delta.hydrate_failed'
  | 'cold_sync.requests' | 'cold_sync.rows'
  // the local-first claim
  | 'local.message_hits' | 'local.message_misses'
  // resurrection guards
  | 'chat_resurrections_blocked' | 'contact_resurrections_blocked'
  // outbox
  | 'outbox.queued' | 'outbox.sent' | 'outbox.failed'
  // media
  | 'media.cache_hits' | 'media.downloads';

const counts = new Map<SyncMetric, number>();

/** Count one occurrence. Never throws — a metric must not break a code path. */
export function metric(name: SyncMetric, n = 1): void {
  try { counts.set(name, (counts.get(name) ?? 0) + n); } catch {}
}

/** Everything counted so far, as a plain object. */
export function syncMetrics(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of counts) out[k] = v;
  return out;
}

/** Zero the counters — used to measure ONE interaction in isolation. */
export function resetSyncMetrics(): void { counts.clear(); }

/**
 * Emit the counters as a single greppable line.
 *
 * One line, one tag, sorted: an acceptance run wants to diff two of these, and
 * that is impossible if the key order wanders between prints.
 */
export function logSyncMetrics(label = ''): string {
  const m = syncMetrics();
  const body = Object.keys(m).sort().map(k => `${k}=${m[k]}`).join(' ');
  const line = `[sync-metrics]${label ? ' ' + label : ''} ${body || '(none)'}`;
  console.log(line);
  return line;
}
