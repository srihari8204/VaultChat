// lib/imeFocus.ts — get the soft keyboard up, and keep a way back if it doesn't.
//
// THE BUG THIS EXISTS FOR
// A PIN gate that focuses its input once on a timer:
//
//   setTimeout(() => inputRef.current?.focus(), 250)
//
// is one IME request and no second chance. On a cold deep-link the window is
// often not focused yet, Android refuses showSoftInput, and React Native still
// marks the input focused. From then on every tap calls focus() on an
// ALREADY-FOCUSED input — a no-op that never re-requests the keyboard. The
// screen is left focused-but-typeless, permanently, however many times you tap.
// Device-observed on the Redmi Note 8 Pro: focused="true" in the a11y tree with
// mInputShown=false and mShowRequested=false in dumpsys input_method.
//
// This is the same trap components/auth/MpinInput.tsx hit (2026-08-28), and it
// blocked the Encrypted Notes gate the same way — so the recovery lives here
// once instead of being rediscovered per screen. MIUI is the strict case, but
// nothing here is MIUI-specific.
//
// THE FIX, both halves needed
//   • blur() before focus(), with the focus in a requestAnimationFrame — the
//     blur must reach the native view first or Android coalesces the pair back
//     into the same no-op.
//   • retry, because the first attempt is the one that loses the race with the
//     window. Stops the moment the keyboard actually shows, so a device that
//     works on the first try does exactly one focus.

import { Keyboard } from 'react-native';

interface Focusable { focus(): void; blur(): void }

const ATTEMPTS = 4;
const RETRY_MS = 600;

/**
 * Raise the keyboard for `ref`, retrying until it appears.
 *
 * Returns a cancel function — call it from the effect's cleanup, or the retries
 * outlive the screen and steal focus back after the user has moved on.
 *
 * `firstDelayMs` defers the first attempt past the window's own layout; the
 * callers' original 200–250ms values were chosen to avoid grabbing focus before
 * the window had drawn (which is its own ANR trap), so that stays the default.
 */
export function focusWithKeyboard(
  ref: { current: Focusable | null },
  firstDelayMs = 250,
): () => void {
  let done = false;
  let attempts = 0;
  const timers: ReturnType<typeof setTimeout>[] = [];

  // The keyboard actually appearing is the only success signal worth trusting;
  // the focus() call itself returns nothing and succeeds even when refused.
  const sub = Keyboard.addListener('keyboardDidShow', () => { done = true; });

  const attempt = () => {
    if (done || !ref.current || attempts >= ATTEMPTS) return;
    attempts++;
    ref.current.blur();
    requestAnimationFrame(() => {
      if (done) return;
      ref.current?.focus();
      timers.push(setTimeout(attempt, RETRY_MS));
    });
  };

  timers.push(setTimeout(attempt, firstDelayMs));

  return () => {
    done = true;
    sub.remove();
    for (const t of timers) clearTimeout(t);
  };
}

/**
 * Tap-to-recover for the "focused but no keyboard" state. Plain focus() cannot
 * escape it — the input is already focused — so this always blurs first.
 * Wire it to a Pressable wrapping the input, so a user who lands in the dead
 * state has a way out that does not involve restarting the app.
 */
export function retryKeyboard(ref: { current: Focusable | null }): void {
  // Safe to wire to onPressIn: when the keyboard is already up there is nothing
  // to recover, and blurring mid-typing would drop the caret on every tap.
  if (Keyboard.isVisible()) return;
  const el = ref.current;
  if (!el) return;
  el.blur();
  requestAnimationFrame(() => ref.current?.focus());
}

// DEVICE NOTE (Redmi Note 8 Pro, 2026-08-31). On that phone this helper was NOT
// enough for the Encrypted Notes gate: instrumentation showed all four attempts
// running with the ref attached, while dumpsys held mShowRequested=false and the
// IME never bound to the app window at all — React Native's focus() produced no
// showSoftInput. Android does not guarantee the IME on PROGRAMMATIC focus; a
// real touch is the reliable trigger, and MIUI is strict. So for a gate that
// MUST be passable, prefer components/PinPad (an in-app keypad, no IME) over any
// amount of focus retrying. This helper remains worthwhile for ordinary inputs,
// where it turns a dead first request into a recoverable one.
