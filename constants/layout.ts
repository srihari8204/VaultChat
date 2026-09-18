// constants/layout.ts — device-derived edge metrics.
//
// THE PROBLEM THIS REPLACES
// -------------------------
// Fifty screen headers hardcoded `paddingTop: 56` (or 54, or 60) to clear the
// status bar. 56 is about right on a tall modern phone with a notch and wrong
// on everything else: on a device with a 24pt status bar it spent 32pt of a
// small screen on nothing, every screen, which is what "the header occupies too
// much space" and "overlays hide content on smaller devices" both come from.
//
// The status bar height is not a design decision. The OS knows it. Ask it.
//
// WHY A MODULE BINDING AND NOT A HOOK
// -----------------------------------
// Every one of those values lives inside a `StyleSheet.create({...})` object
// literal — often inside a `makeStyles(colors)` factory — where a React hook
// cannot be called. Converting sixty files to thread insets through their style
// factories would be a large, risky diff. That reasoning still stands and is why
// these are module bindings rather than a hook.
//
// WHAT CHANGED (2026-09-17): they are now `let`, not `const`, and they are LIVE.
//
// The old comment justified freezing them by claiming "a foldable re-launches
// the activity". It does not: AndroidManifest declares
//   configChanges="keyboard|keyboardHidden|orientation|screenSize|screenLayout|uiMode|smallestScreenSize"
// so the activity is NEVER recreated, and rotation DOES move the top inset (a
// landscape notch moves to the side, the status bar can vanish). Frozen values
// were therefore wrong after any rotation, fold or split-screen change — on every
// Android version, because gradle.properties sets edgeToEdgeEnabled for all of
// them.
//
// HOW THE 53 FACTORY SCREENS UPDATE WITHOUT BEING TOUCHED
// ------------------------------------------------------
// ES module bindings are live: an importer reading `HEADER_TOP` sees the current
// value, not a copy taken at import time. Those screens build styles through
// `useMemo(() => makeStyles(colors), [colors])`, so re-running that factory is
// enough to pick up a new inset — and lib/theme.tsx gives `colors` a fresh
// identity whenever syncLayoutMetrics() reports a change. One call site drives
// every screen that already uses the factory pattern.
//
// ponytail: 10 screens build styles with a module-scope StyleSheet.create and so
// still snapshot these values once. They are listed in
// lib/layoutMetrics.selftest.ts; convert one to the factory pattern if it ever
// needs to be correct in landscape.

import { Dimensions, Platform, StatusBar } from 'react-native';
import { initialWindowMetrics } from 'react-native-safe-area-context';
import { deriveLayout, sameLayout, TAB_BAR_RAISE, type LayoutMetrics, type DerivedLayout } from './layoutMath';

export { TAB_BAR_RAISE, type LayoutMetrics };

/** The real status-bar / notch inset, with a per-platform fallback. */
let TOP_INSET: number =
  initialWindowMetrics?.insets.top ??
  (Platform.OS === 'android' ? StatusBar.currentHeight ?? 24 : 44);

// The TOP inset has a per-platform fallback (below) because the metrics can be
// missing; the bottom one silently fell back to 0, which is not the same kind of
// guess — it is the claim that the device HAS no gesture/navigation bar. When
// react-native-safe-area-context cannot resolve initialWindowMetrics at module
// eval (Android returns nothing when the activity is not up yet), every
// bottom-derived metric collapsed: TAB_BAR_SPACE reserved ~26pt too little and
// the floating bar — which positions itself from the LIVE insets — covered the
// last row of the list. `?? ` only fires when the metrics are ABSENT: a device
// that genuinely reports 0 still gets 0.
let BOTTOM_INSET: number =
  initialWindowMetrics?.insets.bottom ?? (Platform.OS === 'android' ? 24 : 0);

// Short screens pay the biggest price for a fat header, so they get the smaller
// gap. 700dp is about where a 16:9 phone sits once the status and nav bars are
// taken out — below it, vertical space is the scarce resource.
let SHORT = Dimensions.get('window').height < 700;
let NARROW = Dimensions.get('window').width < 360;

/**
 * Top padding for a screen header: the actual status bar plus a small gap.
 *
 * Drop-in for the `paddingTop: 56` literals — same position in the same style
 * object, but sized to the device instead of to one phone someone tested on.
 */
export let HEADER_TOP: number = TOP_INSET + (SHORT ? 4 : 8);

/**
 * Bottom padding for content that must clear the gesture bar. app.json sets
 * edgeToEdgeEnabled, so screens draw UNDER the navigation bar and anything
 * pinned to the bottom sits beneath it unless it accounts for this.
 */
export let SCREEN_BOTTOM: number = BOTTOM_INSET;

/** True on small-width devices, for stepping padding and icon sizes down. */
export let IS_NARROW = NARROW;
/** True on short devices, where vertical space is the constraint. */
export let IS_SHORT = SHORT;

/**
 * How far the raised Apps disc pops ABOVE the 66pt glass pill.
 *
 * Android does not hit-test a child outside its parent's bounds, so the disc
 * was drawn where nothing could be tapped. The bar's view is this much taller
 * than the pill it paints (the extra band is transparent) so the touchable
 * covers the art — which also means content has to clear the taller view, not
 * just the pill.
 */

/**
 * Vertical space the FLOATING tab bar occupies (Aurora Glass, U6).
 *
 * The bar is `position: absolute` so content scrolls under its blur — that is
 * the whole point of the treatment. The cost is that any scroll container on a
 * tab screen must reserve this much bottom padding, or its last row can never
 * be brought clear of the glass.
 *
 * 66 bar + the raised Apps disc above it + 12 gap below it + the device's own
 * bottom inset + 12 breathing room.
 */
export let TAB_BAR_SPACE: number = 66 + TAB_BAR_RAISE + 12 + Math.max(BOTTOM_INSET, 10) + 12;

/** Bumped every time a sync actually changed something. */
let generation = 0;

/**
 * Recompute every derived metric from the LIVE window and report whether
 * anything moved.
 *
 * Called from lib/theme.tsx, which owns the only subscription to the live
 * insets. It returns a generation number rather than the values themselves so
 * the caller can use it as a memo key: a new generation gives `colors` a fresh
 * identity, every `useMemo(() => makeStyles(colors), [colors])` re-runs, and the
 * style factories re-read the bindings below. Screens need no change.
 *
 * Idempotent: syncing the same metrics twice does not bump the generation, so a
 * re-render with unchanged insets does not invalidate every style in the app.
 */
export function syncLayoutMetrics(m: LayoutMetrics): number {
  const next = deriveLayout(m);
  const current: DerivedLayout = {
    headerTop: HEADER_TOP, screenBottom: SCREEN_BOTTOM,
    tabBarSpace: TAB_BAR_SPACE, isNarrow: IS_NARROW, isShort: IS_SHORT,
  };
  if (sameLayout(next, current)) return generation;

  TOP_INSET = m.top;
  BOTTOM_INSET = m.bottom;
  SHORT = next.isShort;
  NARROW = next.isNarrow;
  HEADER_TOP = next.headerTop;
  SCREEN_BOTTOM = next.screenBottom;
  IS_NARROW = next.isNarrow;
  IS_SHORT = next.isShort;
  TAB_BAR_SPACE = next.tabBarSpace;
  return ++generation;
}

/** Current generation, for tests and diagnostics. */
export function layoutGeneration(): number { return generation; }
