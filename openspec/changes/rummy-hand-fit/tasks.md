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

- [ ] 3.1 Build and install
- [ ] 3.2 Measure on the Redmi in landscape: 13 card nodes, extent within the
      scroller viewport
- [ ] 3.3 Confirm a wide display still spreads without overlap

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
