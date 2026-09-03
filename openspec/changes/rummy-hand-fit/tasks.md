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

## 6. The 76px offset — measured ancestor chain (final state)

Walked the FULL ancestor chain of the hand's `HorizontalScrollView` on the
Redmi in landscape, on the shipping build `885f9fd2`. Every parent, with bounds:

```
screen width 2264
#1..#12  FrameLayout / LinearLayout / ViewGroup / ScrollView   [0,0][2264,1036]   left 0  right 0
#13      HorizontalScrollView                                  [114,569][2226,866] left 114 right 38
```

**Every one of the twelve ancestors is 0..2264 — perfectly symmetric.** The
offset is not a window inset, not a navigator wrapper, and not a SafeAreaView:
there is no SafeAreaProvider or SafeAreaView anywhere in the games shell, and
`TableBackground` applies no padding.

The offset appears at the scroller itself, inside its direct parent, and the
arithmetic is exact:

- scroller width 2112 = `m.tableW` (so the explicit-width fix IS applied)
- parent 2264 wide; a centred 2112 child would sit at 76..2188
- actual 114..2226 — right by 38, which is precisely what centring 2112 inside
  a content box of **76..2264** produces

So the direct parent behaves as though it has `paddingLeft: 76px` and
`paddingRight: 0` — but `Rummy.tsx` no longer sets any horizontal padding on
that View. Padding does not appear in uiautomator bounds, so it cannot be
confirmed or refuted from a hierarchy dump.

### Why this stops here

Four attempts, each measured and each ruled out:

1. centre the content in the scroller — worked (skew 113 -> 0), didn't move the
   scroller
2. symmetric side insets feeding both padding and `metrics()` — box still
   measured 76..2264
3. centre by explicit width instead of padding — scroller is now correctly
   2112 wide and still lands at 114
4. full ancestor-chain measurement — proves the chain is symmetric and the
   cause is inside the direct parent's content box

**A live inspector is now required** (React DevTools / Flipper layout
inspector), to read the computed padding and `useSafeAreaInsets()` values on
that specific View at runtime. A hierarchy dump cannot see either, and the
on-screen diagnostic route is closed: uiautomator skips `opacity: 0` nodes and
prunes 1x1 `accessible` views, release builds strip console logs, and MIUI's
dumpsys omits the cutout.

**No hard-coded compensation has been added**, deliberately. A `marginLeft: -76`
would move this device and break any device whose inset differs, and the source
of the 76 is still unproven.

**Impact: cosmetic only.** All 13 cards render, nothing is clipped, every card
is reachable, and the hand is correctly centred relative to its own scroller.

## 7. Root-cause investigation, measurement-first (per the 76px brief)

### The padding hypothesis is DEAD

Measured every child of the scroller's direct parent on build `885f9fd2`:

```
parent                     [0,0][2264,1036]
  SvgView (Baize)          [0,0][2263,1034]      left 0      full bleed
  SvgView (TableTop/felt)  [114,76][2223,486]    left 114    width 2109
  HorizontalScrollView     [114,569][2226,866]   left 114    width 2112
  Button "Sort your hand"  [0,866][218,992]      left 0
  Button "Drop"            [2151,866][2264,992]  right 0
```

**A parent with `paddingLeft: 76` cannot have a child at x=0.** The Sort button
starts at 0 and Drop ends at 2264. The parent's content box is the full width.
That eliminates the padding explanation — mine, and the one the brief's §3/§15
proposed.

It also eliminates the ScrollView: the felt (`SvgView`, a plain View child) and
the scroller both start at **114**. They agree with each other. Two different
node types, same offset, so it is not a ScrollView quirk.

### What the numbers actually fit

Both offset children are ~2112px wide and both sit at 114. Centring is exact
for one width and one width only:

```
(2340 - 2112) / 2 = 114   <- the Redmi's PHYSICAL display long edge
(2264 - 2112) / 2 =  76   <- the app WINDOW's usable width
```

2340 - 2264 = 76 = the status bar, which sits on the left edge at rotation 1.

**Hypothesis (fits to the pixel, not yet proven):** the container is laid out
edge-to-edge at the full display width (2340px / 851dp), while `metrics()`
sizes its children from `useWindowDimensions()` (2264px / 823dp). A child sized
for the window, centred inside a parent laid out to the display, lands exactly
38px right of the window's centre. uiautomator clips reported bounds at the
screen edge, so a parent that really extends to 2340 is reported as ending at
2264 — which is why the chain looked symmetric.

`m.tableW = 2112px = 768dp` corroborates it: `823.27 - 2 x 27.6 = 768.07dp`, so
metrics IS working from the 823dp window figure.

### Why this stops here, per §21

Confirming it needs runtime values a hierarchy dump cannot give:

- `useWindowDimensions()` -> width/height as the component sees them
- `Dimensions.get('window')` vs `Dimensions.get('screen')`
- `useSafeAreaInsets()` -> left/right at rotation 1
- the padded View's `onLayout` width — the decisive one: **2340 or 2264?**

If `onLayout` reports 2340 while `useWindowDimensions()` reports 2264, the
hypothesis is proven and the fix is to derive the table geometry from the
measured container width rather than the window, which is responsive and
carries no hard-coded 76.

**No compensation has been added.** The previous "centre by width" change is
also now suspect: if the container really is display-width, the ORIGINAL
asymmetric `paddingLeft: insets.left` may have been correct, with the dump's
"flush right" reading being a clipping artefact rather than a bug.

## 8. SOLVED — the inset was applied twice

Runtime measurement (temporary visible probe, since removed) on the Redmi in
landscape:

```
BOX 851x393    SCR 851    WIN 823    INS 28/0    TW 768
```

`BOX === SCR`, so the container is laid out EDGE-TO-EDGE at display width,
while `useWindowDimensions()` reports the WINDOW — which has already had the
28dp system bar removed (`823 = 851 - 28`). `metrics()` was handed that window
width and subtracted the inset again on both sides: `823 - 56 = 767`. Centring
a 768dp child inside the 851dp container puts it `(851-768)/2 = 41.5dp` from
the edge instead of 28dp — the 114px offset, to the pixel.

**The offset was never padding, never a wrapper, never the ScrollView.** It was
one inset counted twice across two coordinate systems.

### Fix

`metrics()` now takes the MEASURED container size (`onLayout`, guarded by
change detection so it cannot loop) and subtracts the inset once:

```
metrics({ width: box.w || win.width, height: box.h || win.height }, boxInsets)
```

One coordinate system, no hard-coded compensation, and it recomputes on any
dimension change.

### Verified on device — Redmi, landscape

```
                 BEFORE            AFTER
table width      2112              2188
left              114                76
right             114 (of 2340)      76
vs window right    38  (artefact)    76
centring diff      38                 0   PASS
cards rendered     13                13   PASS
```

Measured against the DISPLAY width from `wm size`, not uiautomator's screen
width — uiautomator reports the window and clips bounds at its edge, which is
what made the right-hand space read as 38 and sent three earlier attempts after
the wrong cause.
