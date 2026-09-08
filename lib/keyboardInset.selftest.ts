// lib/keyboardInset.selftest.ts — run: npx tsx lib/keyboardInset.selftest.ts
//
// The bug this locks down was measured on a real handset: with edge-to-edge on,
// `endCoordinates.height` came back SHORT by the navigation-bar inset, so the
// chat composer sat that far too low and the send button was clipped by the
// keyboard. Measuring from the keyboard's top edge instead cannot make that
// mistake — whatever is below the keyboard is inside the number by definition.
//
// Numbers below are the real device: 2392px tall at 420dpi, a 56px navigation
// bar, keyboard top edge at y=1601.

import { keyboardInsetFrom } from './keyboardInset';

let failures = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `  (got ${actual}, want ${expected})`}`);
}

console.log('\nKeyboard-inset self-test\n');

const SCREEN = 2392;
const KB_TOP = 1601;          // measured: where the IME actually starts
const NAV = 56;
const REAL = SCREEN - KB_TOP; // 791 — what the composer must clear

console.log('The device case that produced the bug:');
// What Android reported: the keyboard height WITHOUT the nav bar under it.
eq('top-edge measurement is nav-bar inclusive',
  keyboardInsetFrom({ screenY: KB_TOP, height: REAL - NAV }, SCREEN), REAL);
eq('...and the reported height alone would have been short by the nav bar',
  REAL - NAV, 735);

console.log('\nFallbacks:');
eq('no screenY falls back to the reported height',
  keyboardInsetFrom({ height: 700 }, SCREEN), 700);
eq('the larger of the two wins when both are present',
  keyboardInsetFrom({ screenY: SCREEN - 500, height: 640 }, SCREEN), 640);
eq('no frame at all is zero', keyboardInsetFrom(undefined, SCREEN), 0);
eq('an empty frame is zero', keyboardInsetFrom({}, SCREEN), 0);

console.log('\nNothing may push layout downward:');
// A screenY beyond the screen bottom would give a negative inset, which as
// paddingBottom would drag content off the bottom of the display.
eq('a screenY past the bottom clamps to 0',
  keyboardInsetFrom({ screenY: SCREEN + 120 }, SCREEN), 0);
eq('a negative reported height clamps to 0',
  keyboardInsetFrom({ height: -50 }, SCREEN), 0);

console.log('\nKeyboard closed:');
eq('a keyboard flush with the bottom covers nothing',
  keyboardInsetFrom({ screenY: SCREEN, height: 0 }, SCREEN), 0);

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all keyboard-inset checks passed\n');
process.exit(failures ? 1 : 0);
