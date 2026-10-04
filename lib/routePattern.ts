// lib/routePattern.ts — a screen's route PATTERN, for usage counting. Pure.
//
// components/UsageCounter used to count usePathname(), the RESOLVED path, so
// `/join/AB12CD` (an invite code), `/live/join/<code>` and `/add/<vault id>`
// were POSTed to /app/usage verbatim. expo-router's useSegments() gives the
// file-system segments instead (`['join', '[code]']`); this joins them with
// route groups such as `(tabs)` dropped, so the counter only ever sees
// `join/[code]` (2026-10-04). Node-tested in routePattern.selftest.ts.

export function routePatternName(segments: readonly string[]): string {
  return segments.filter((s) => !!s && !/^\(.*\)$/.test(s)).join('/');
}
