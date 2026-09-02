// lib/diagLog.ts — say it once, and don't put a user id in production logcat.
//
// WHY THIS EXISTS
//
// console.warn is DELIBERATELY not stripped from release builds (console.log is).
// That is a good call — it is how several real defects in this app were found on
// a device that could not be attached to a debugger. It also means every warn on
// a hot path is a real line in a shipped user's logcat.
//
// Measured on a cold boot of the release build: 21 of the 22 JavaScript log lines
// emitted during startup were the same two E2EE failures repeating for a handful
// of peers across ~3 seconds. The first of each carried the entire diagnostic;
// the other nineteen only buried it, and every one of them printed a full user
// UUID into a log any installed app with READ_LOGS could once read, and which
// users routinely paste into bug reports.
//
// So: keep the first occurrence, drop the repeats, and shorten the identifiers.
// This changes NOTHING about behaviour — it is a logging seam only.

const _seen = new Set<string>();

/**
 * Warn the first time this `key` is seen in the process, then stay quiet.
 *
 * Deliberately NOT time-boxed. A repeating failure that heals is reported by the
 * thing that heals it; a repeating failure that does not heal says the same
 * sentence forever, and saying it 20 times does not make it truer. The set is
 * per-process, so a restart reports afresh — which is exactly when you are
 * looking.
 */
export function warnOnce(key: string, message: string): void {
  if (_seen.has(key)) return;
  _seen.add(key);
  console.warn(message);
}

/** First 8 characters of an id — enough to correlate, not enough to identify. */
export function shortId(id: string | null | undefined): string {
  return id ? String(id).slice(0, 8) : '(none)';
}

/**
 * Shorten every UUID inside a free-text string.
 *
 * Error messages carry ids we did not choose to log: "group: no sender key for
 * <full uuid>" is thrown from one layer and printed by another, so redacting at
 * the call site alone would miss it.
 */
export function redactIds(text: string): string {
  return text.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    m => m.slice(0, 8) + '…',
  );
}

/** Test seam: forget what has been warned. Not used by app code. */
export function _resetWarnOnce(): void {
  _seen.clear();
}
