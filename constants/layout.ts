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
// WHY A MODULE CONSTANT AND NOT A HOOK
// ------------------------------------
// Every one of those values lives inside a `StyleSheet.create({...})` object
// literal — often inside a `makeStyles(colors)` factory — where a React hook
// cannot be called. Converting fifty files to thread insets through their style
// factories would be a large, risky diff for a value that is fixed for the life
// of the process anyway. `initialWindowMetrics` is resolved natively before the
// first render, so it is available at module scope and needs no provider.
//
// The trade is that these do not react to a live inset change (a phone that
// grows a status bar mid-session). That does not happen; rotation does not move
// the top inset on a phone, and a foldable re-launches the activity.
// ponytail: module constant, not reactive. If a device ever does change its top
// inset live, the fix is useSafeAreaInsets() at the few screens that show it.

import { Dimensions, Platform, StatusBar } from 'react-native';
import { initialWindowMetrics } from 'react-native-safe-area-context';

/** The real status-bar / notch inset, with a per-platform fallback. */
const TOP_INSET: number =
  initialWindowMetrics?.insets.top ??
  (Platform.OS === 'android' ? StatusBar.currentHeight ?? 24 : 44);

const BOTTOM_INSET: number = initialWindowMetrics?.insets.bottom ?? 0;

// Short screens pay the biggest price for a fat header, so they get the smaller
// gap. 700dp is about where a 16:9 phone sits once the status and nav bars are
// taken out — below it, vertical space is the scarce resource.
const SHORT = Dimensions.get('window').height < 700;
const NARROW = Dimensions.get('window').width < 360;

/**
 * Top padding for a screen header: the actual status bar plus a small gap.
 *
 * Drop-in for the `paddingTop: 56` literals — same position in the same style
 * object, but sized to the device instead of to one phone someone tested on.
 */
export const HEADER_TOP: number = TOP_INSET + (SHORT ? 4 : 8);

/**
 * Bottom padding for content that must clear the gesture bar. app.json sets
 * edgeToEdgeEnabled, so screens draw UNDER the navigation bar and anything
 * pinned to the bottom sits beneath it unless it accounts for this.
 */
export const SCREEN_BOTTOM: number = BOTTOM_INSET;

/** True on small-width devices, for stepping padding and icon sizes down. */
export const IS_NARROW = NARROW;
/** True on short devices, where vertical space is the constraint. */
export const IS_SHORT = SHORT;

export default { HEADER_TOP, SCREEN_BOTTOM, IS_NARROW, IS_SHORT };

/**
 * Vertical space the FLOATING tab bar occupies (Aurora Glass, U6).
 *
 * The bar is `position: absolute` so content scrolls under its blur — that is
 * the whole point of the treatment. The cost is that any scroll container on a
 * tab screen must reserve this much bottom padding, or its last row can never
 * be brought clear of the glass.
 *
 * 66 bar + 12 gap below it + the device's own bottom inset + 12 breathing room.
 */
export const TAB_BAR_SPACE: number = 66 + 12 + Math.max(BOTTOM_INSET, 10) + 12;
