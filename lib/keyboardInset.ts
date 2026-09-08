// lib/keyboardInset.ts — how much of the screen the keyboard is covering.
//
// WHY THIS EXISTS RATHER THAN KeyboardAvoidingView
// ------------------------------------------------
// app.json sets edgeToEdgeEnabled. With edge-to-edge on, Android's
// `adjustResize` does NOT resize the window — the app keeps the full height and
// is expected to consume the IME inset itself. So the manifest says
// adjustResize, the screen looks like it should just work, and nothing moves.
//
// Twenty-three screens wrote `behavior={Platform.OS === 'ios' ? 'padding' :
// undefined}`, which is no avoidance at all on Android. Measured on device:
// opening the keyboard on Delete account left the "Delete my account" button
// completely behind it, with no way to reach it but dismissing the keyboard.
//
// AND WHY screenY RATHER THAN height
// ----------------------------------
// `endCoordinates.height` is not navigation-bar-inclusive on this stack — it
// came back short by exactly the nav-bar inset, which put the chat composer
// that far too low and clipped the send button (about 60px of a 50dp control
// behind the IME, measured at 420dpi).
//
// `screenY` is the keyboard's TOP edge in screen coordinates, so
// `screenHeight - screenY` is the distance from that edge to the physical
// bottom of the display. Whatever lives down there — nav bar, gesture pill — is
// inside it by construction, with no assumption left to get wrong.

// No react-native import in this file ON PURPOSE: the selftest runs under
// Node, and pulling in react-native's index.js there fails to transform. The
// hook that needs Dimensions/Keyboard lives in ./useKeyboardInset.

/** The subset of a keyboard event's endCoordinates that matters here. */
export interface KeyboardFrame {
  height?: number;
  screenY?: number;
}

/**
 * How far the keyboard reaches up from the bottom of the screen.
 *
 * Prefers the top-edge measurement and falls back to the reported height, so a
 * platform that omits `screenY` still gets the old behaviour rather than zero.
 * Never negative: a bogus screenY must not pull layout downward.
 */
export function keyboardInsetFrom(frame: KeyboardFrame | undefined, screenHeight: number): number {
  if (!frame) return 0;
  const fromTopEdge = frame.screenY != null ? screenHeight - frame.screenY : 0;
  return Math.max(0, fromTopEdge, frame.height ?? 0);
}

export default { keyboardInsetFrom };
