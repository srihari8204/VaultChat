# Tasks — make the rummy hand fit

## 1. Fix

- [x] 1.1 Apply the tuck as negative `marginLeft` on cards after the first, and
      remove the negative `gap` and its compensating `paddingRight`
- [x] 1.2 Correct the width model constants to match the rendered layout: tray
      border, `S[3]` inter-tray gap, scroll-content padding

## 2. Prove it

- [x] 2.1 Fit assertion across the device table, both orientations
- [x] 2.2 Source guard: no negative `gap` in the hand layout
- [x] 2.3 Full games suite still green

## 3. Device

- [x] 3.1 Build and install — APK 5152a428, on the Redmi and the emulator
- [x] 3.2 Measured on the Redmi in landscape, and it holds:
      `says=13 cards  rendered=13  card=148px  tucked=9/12  viewport=76..2264  outside=0`.
      Rendered went 12 -> 13 and the tuck went 0 -> 9 of 12 pairs, which is the
      fan finally being applied rather than discarded.
- [x] 3.3 Confirm a wide display still spreads WITHOUT overlap — CLOSED as
      not-provable-here, deliberately. Not verified on
      device: the Redmi at 2264px is the widest display available here and it
      legitimately tucks (9 of 12 pairs), so there is nothing to hand that can
      show the no-overlap case. The selftest covers it - fanFor returns 1 once
      there is room - but that is the model, and the model is exactly what was
      wrong before.

## 4. Found while fixing

- **There is a real floor.** Below about 454 dp of width, thirteen cards cannot
  fit even at `CARD_MIN` (32) and the tightest permitted tuck (`FAN` 0.58):
  `32 x (5 + 8 x 0.58) + 146 chrome = 454`. The hand is a horizontal scroller,
  so it degrades to scrolling rather than shrinking cards past legibility. That
  is deliberate, and it never bites in play — rummy locks landscape while
  playing, and the narrowest realistic landscape width is 640 dp.
- **The old test could not have caught this.** It asserted the model against
  itself (`handWidthAt(cardW, f) < width`) and never what rendered, so it stayed
  green while the device overflowed. The new guards read `Rummy.tsx` directly.

## 5. Centring, and where it landed

The hand fitting is fixed and measured. Centring it took three attempts and the
last one is the durable answer:

1. `justifyContent: 'center'` + `flexGrow` on the scroll content — the hand
   became perfectly centred INSIDE its scroller (skew 113px -> 0) and still sat
   76px right of the screen's middle, because the scroller itself ran 76..2264.
2. Symmetric side insets (`max(insets.left, insets.right)` feeding both the
   padding and `metrics()`) — did not survive: the box still measured 76..2264,
   exactly ONE of the two paddings applied. Root cause never identified.
3. **Centre by WIDTH, not padding** (`2709248`). The felt and the hand take an
   explicit `m.tableW`, which `metrics()` already derives as
   `width - 2 x sideInset`, and are centred. Equal margins fall out of the
   arithmetic rather than depending on a padding chain this file does not
   control. Vertical insets still use padding — they were never the problem.

Two builds were spent on an on-screen diagnostic that never surfaced:
`uiautomator` skips `opacity: 0` nodes and prunes a 1x1 `accessible` View, and
release builds strip console logs while MIUI's dumpsys omits the cutout. There
is currently no working way to read live inset values on that device, which is
why attempt 3 removes the dependency on knowing them.
