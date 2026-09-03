// lib/games/boardFit.ts — how big a square board may be on THIS screen.
//
// Chess, Ludo and Tic-Tac-Toe are all one square board with chrome above and
// below it. They shared a sizing hook that did the right shape of thing and two
// wrong things:
//
//   1. IT CAPPED THE BOARD at 460 (380 for tic-tac-toe). On anything larger
//      than a mid-size phone the board simply stopped growing and sat in the
//      middle of an empty screen. A board that refuses the space it has been
//      given is not responsive, it is fixed with extra steps.
//
//   2. IT COULD RETURN MORE SPACE THAN EXISTED. The floor was applied last —
//      `max(200, min(...))` — so on a short screen it handed back 200 even when
//      only 150 was available, and the board ran off the bottom taking the
//      controls with it.
//
// It also sized against the raw window, so a cutout or a gesture bar ate into
// the board rather than into the margin around it.
//
// This module is the pure arithmetic, so it can be checked without a renderer
// (boardFit.selftest.ts). The hook in components/games/ui.tsx is a thin wrapper.

export interface Insets { top: number; bottom: number; left: number; right: number }

/**
 * Never smaller than this. Below it the pieces stop being tappable, and a board
 * that cannot be played is worse than one that has to scroll — so this is the
 * one case where the board is allowed to exceed its box and the screen scrolls.
 */
export const BOARD_MIN = 200;

/** The gap left around the board so it never touches the screen edge. */
export const BOARD_GUTTER = 16;

export interface BoardFit {
  /** The edge of the square board. */
  size: number;
  /** True when the board had to exceed its box to stay playable. */
  scrolls: boolean;
}

/**
 * The largest square that fits the space actually available.
 *
 * Both axes bind. Width binds in portrait; height binds in landscape and on
 * short screens, and taking the smaller is what keeps the controls under the
 * board reachable instead of pushed off the bottom.
 *
 * `chrome` is the vertical space the seats, status line and buttons need. It is
 * subtracted from the height, along with the safe-area insets, before the board
 * is allowed to claim anything.
 */
export function boardFit(
  win: { width: number; height: number },
  insets: Insets,
  chrome: number,
  gutter: number = BOARD_GUTTER,
): BoardFit {
  const byWidth = win.width - insets.left - insets.right - gutter * 2;
  const byHeight = win.height - insets.top - insets.bottom - chrome;
  const available = Math.min(byWidth, byHeight);

  // No upper cap. The board takes the room it is given — that is the whole
  // point, and it is what makes a tablet look designed for rather than
  // tolerated.
  if (available >= BOARD_MIN) return { size: Math.floor(available), scrolls: false };

  // Not enough room to stay playable. Keep it usable and let the screen scroll,
  // rather than shrinking the pieces past the point of being tappable.
  return { size: BOARD_MIN, scrolls: true };
}
