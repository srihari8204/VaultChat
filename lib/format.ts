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

/**
 * Avatar initial — first letter of the first part that actually has one.
 *
 * Replaces `(a ?? b ?? '?').trim()[0].toUpperCase()`, which white-screened the
 * moment `a` was an EMPTY STRING: `??` only catches null/undefined, so `''`
 * won the chain, `''.trim()[0]` was `undefined`, and `.toUpperCase()` threw.
 * The `||` spelling of the same line had the same crash one step further out —
 * a name of `'   '` is truthy, trims to nothing, and throws identically.
 *
 * Email is now optional on an account, so "name missing, email missing" is an
 * ordinary state rather than a corrupt row, and every one of these call sites
 * is a render path: it must return a character, never throw.
 */
export function initialOf(...parts: (string | null | undefined)[]): string {
  for (const p of parts) {
    // Spread, not [0]: an emoji or Devanagari name is a surrogate pair, and
    // index 0 of one is half a character — which renders as a tofu box.
    const c = p ? [...p.trim()][0] : undefined;
    if (c) return c.toUpperCase();
  }
  return '?';
}

export default {};
