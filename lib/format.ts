// lib/format.ts — small, pure display formatters shared across screens.
//
// Pure functions only: no React, no react-native, no I/O. That keeps them
// runnable under Node/tsx (same as lib/nav/geo.ts and utils/interest.ts) and
// free to import from anywhere without pulling a dependency graph along.

/**
 * Call-screen duration, `MM:SS` zero-padded.
 *
 * Byte-identical to the two private copies this replaces (app/voicecall.tsx and
 * app/videocall.tsx), INCLUDING the behaviour past one hour: 90 minutes renders
 * as "90:05", not "1:30:05". That is the shipped format on both call screens and
 * is preserved deliberately — this extraction changes no pixels.
 *
 * The call LOG uses a different, deliberately shorter format ("3:07" / "45s")
 * and keeps its own formatter in app/(tabs)/calls.tsx. Two formats, two
 * audiences; collapsing them would change what users see.
 */
export function formatDuration(totalSeconds: number): string {
  const s = totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export default {};
