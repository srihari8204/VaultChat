// lib/status/gate.ts — the pure decisions behind a GATED status.
//
// A status can carry one gate. Which one changes what it actually promises,
// and the difference is not cosmetic:
//
//   'question'  REAL. The content key is wrapped under a key derived from the
//               ANSWER (scrypt, per-story salt). Someone who does not know the
//               answer cannot decrypt it, whatever client they run. The server
//               never sees the answer.
//
//   'puzzle'    ENGAGEMENT. The viewer already holds the wrapped key — solving
//               only decides when the UI reveals it. A modified client skips
//               it. It is NOT protection, and this file will not pretend it is.
//
// The puzzle is still worth having because it never WEAKENS anything: the
// audience list and its per-viewer Double Ratchet wrap (lib/storyKeys) still
// decide who can decrypt at all. The puzzle is a second, playful gate INSIDE an
// already-authorised audience. It is built from a degraded preview rather than
// the full-resolution media, so the pieces are never the payload.
//
// PURE — no react-native, no crypto. Runs under `npx tsx`.

export type GateKind = 'none' | 'puzzle' | 'question';

/** Grid sizes a poster may choose. 9x9 is 81 pieces — allowed, but brutal on a phone. */
export const GRID_MIN = 3;
export const GRID_MAX = 9;

/** Shortest answer we will accept, after normalising. */
export const ANSWER_MIN_LEN = 2;

export function isValidGrid(n: number): boolean {
  return Number.isInteger(n) && n >= GRID_MIN && n <= GRID_MAX;
}

export function pieceCount(grid: number): number {
  return isValidGrid(grid) ? grid * grid : 0;
}

/**
 * Normalise an answer so the poster and the viewer can actually match.
 *
 * This is the detail that quietly kills features like this: the poster types
 * "Mumbai " and the viewer types "mumbai", and a byte comparison says no
 * forever, with no way for either of them to find out why.
 *
 * NFKC first so visually identical characters from different keyboards agree,
 * then case-folded, then internal runs of whitespace collapsed. Punctuation is
 * deliberately KEPT: stripping it would make "St. Mary" and "St Mary" match,
 * but also collapses genuinely different answers together and quietly shrinks
 * an already small keyspace.
 */
export function normalizeAnswer(raw: string): string {
  return (raw ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Is this usable as a gate answer at all? */
export function isAcceptableAnswer(raw: string): boolean {
  return normalizeAnswer(raw).length >= ANSWER_MIN_LEN;
}

/**
 * Is the arrangement solved?
 *
 * A jigsaw where pieces are dragged and swapped, NOT a sliding puzzle: every
 * permutation is reachable, so a poster can never publish a status that is
 * impossible to open. (Half of random 15-puzzle shuffles are unsolvable — that
 * would be a status nobody could ever see, which is the worst possible bug in
 * a feature whose whole point is being seen.)
 */
export function isSolved(arrangement: readonly number[]): boolean {
  return arrangement.every((piece, i) => piece === i);
}

/**
 * A shuffle that is never accidentally already solved.
 *
 * `rand` is injected so this is deterministic under test — the caller passes
 * Math.random in the app.
 */
export function shuffle(count: number, rand: () => number): number[] {
  if (count <= 1) return count === 1 ? [0] : [];
  const a = Array.from({ length: count }, (_, i) => i);
  for (let i = a.length - 1; i > 0; i--) {          // Fisher-Yates, unbiased
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  // Handing someone a solved puzzle reads as a broken feature. Swapping the
  // first two pieces guarantees a different arrangement without another shuffle
  // that might land here again.
  if (isSolved(a)) { [a[0], a[1]] = [a[1], a[0]]; }
  return a;
}

/** Does this gate hold back the CONTENT KEY, or only the UI? */
export function isCryptographic(kind: GateKind): boolean {
  return kind === 'question';
}

export default {};
