// constants/layoutMath.ts — the pure arithmetic behind the layout metrics.
//
// WHY THIS IS A SEPARATE FILE
// ---------------------------
// constants/layout.ts imports react-native, so it cannot be loaded by a plain
// `npx tsx` selftest — which is why the guards around it could only ever scan
// source text. Source scans prove a keyword is present; they cannot prove the
// numbers are right. Everything here is pure, imports nothing, and is therefore
// executable in a selftest, so "the insets actually recompute" is a RUN
// assertion rather than a grep.
//
// Keep this file dependency-free. The moment it imports react-native it stops
// being testable and the guard silently degrades back to a source scan.

/** Window metrics as the live window reports them. */
export type LayoutMetrics = { top: number; bottom: number; width: number; height: number };

/** Everything derived from the window. */
export type DerivedLayout = {
  headerTop: number;
  screenBottom: number;
  tabBarSpace: number;
  isNarrow: boolean;
  isShort: boolean;
};

/**
 * How far the raised Apps disc pops ABOVE the 66pt glass pill.
 *
 * Android does not hit-test a child outside its parent's bounds, so the disc
 * was drawn where nothing could be tapped. The bar's view is this much taller
 * than the pill it paints (the extra band is transparent) so the touchable
 * covers the art — which also means content has to clear the taller view, not
 * just the pill.
 */
export const TAB_BAR_RAISE = 32;

/** Below this height, vertical space is the scarce resource. */
export const SHORT_MAX_HEIGHT = 700;
/** Below this width, step padding and icon sizes down. */
export const NARROW_MAX_WIDTH = 360;

/**
 * Derive every layout metric from the live window.
 *
 * Pure: same input, same output, no module state. `syncLayoutMetrics` in
 * constants/layout.ts is the only thing that turns this into mutable bindings.
 */
export function deriveLayout(m: LayoutMetrics): DerivedLayout {
  const isShort = m.height < SHORT_MAX_HEIGHT;
  const isNarrow = m.width < NARROW_MAX_WIDTH;
  return {
    // Short screens pay the biggest price for a fat header, so they get the
    // smaller gap.
    headerTop: m.top + (isShort ? 4 : 8),
    // edgeToEdgeEnabled is set for every API level, so screens draw UNDER the
    // navigation bar; anything pinned to the bottom sits beneath it unless it
    // accounts for this.
    screenBottom: m.bottom,
    // 66 bar + the raised Apps disc above it + 12 gap below it + the device's
    // own bottom inset + 12 breathing room.
    tabBarSpace: 66 + TAB_BAR_RAISE + 12 + Math.max(m.bottom, 10) + 12,
    isNarrow,
    isShort,
  };
}

/** True when two derived layouts are identical, so a sync can skip the bump. */
export function sameLayout(a: DerivedLayout, b: DerivedLayout): boolean {
  return a.headerTop === b.headerTop
    && a.screenBottom === b.screenBottom
    && a.tabBarSpace === b.tabBarSpace
    && a.isNarrow === b.isNarrow
    && a.isShort === b.isShort;
}

/** Chat bubble geometry, kept here so a test can run the real arithmetic. */
export const BUBBLE_MAX_FRACTION = 0.78;   // components/chat/chatStyles.ts `bubble.maxWidth: '78%'`
export const BUBBLE_PAD_H = 14;            // ...and its paddingHorizontal
/**
 * The message FlatList's own gutter (app/chat.tsx `contentContainerStyle`).
 *
 * 2026-09-18: this was missing, and it is the whole reason the first pass at
 * this still overhung. `maxWidth: '78%'` resolves against the PARENT's content
 * box, and the parent is `bubbleRow` inside a list padded 12dp each side - not
 * the window. Omitting it made every slot 18-19dp too generous, so a 240dp
 * card still hung out of the bubble at the 320dp floor (real slot: 202dp).
 * Cross-check: at 369dp (the Honor) this gives 241, which is the measured
 * number the bug report carried.
 */
export const LIST_PAD_H = 12;

/**
 * Widest a card may be inside a chat bubble at a given window width.
 *
 * `padH` is the bubble's own horizontal padding: 14 for a TEXT bubble (file
 * cards and their previews, polls, audio rows), 3 for `mediaBubble`, which
 * image, video and GIF bubbles swap in. Both were hardcoded to 220-240, which
 * needs a ~368dp window in a text bubble and ~349dp in a media bubble.
 *
 * The 140 floor keeps a card usable if the window is ever reported absurdly
 * narrow (a split-screen sliver, a bad first frame) rather than collapsing it.
 */
export function chatCardMax(width: number, padH: number = BUBBLE_PAD_H): number {
  const row = width - LIST_PAD_H * 2;
  return Math.max(140, Math.floor(row * BUBBLE_MAX_FRACTION) - padH * 2);
}
