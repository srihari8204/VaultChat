# Design — make the rummy hand fit

## Root cause

Two layers disagree, and the render layer silently wins.

**The model** (`lib/games/rummyTable.ts`) picks a card width and then a fan:

```
handWidthAt(cardW, fan) = cardW * (GROUPS + (HAND_SIZE - GROUPS) * fan)
                        + TRAY_PAD * GROUPS + TRAY_GAP * (GROUPS - 1)
fanFor(cardW, width)    = clamp(FAN, 1, (width - fixed - margin) / fanned)
```

On the Redmi in landscape (823 dp usable, 54 dp cards) this yields a fan of
about **0.795** — an 11 dp tuck per card — and the model then reports that the
hand fits.

**The render** (`components/games/Rummy.tsx`, `GroupZone`) applies that tuck as:

```
<View style={{ flexDirection: 'row', gap: -overlap, paddingRight: overlap }}>
```

`gap` is a Yoga/CSS gutter and **may not be negative**. The value is invalid, so
it resolves to `0`. The cards never tuck; the hand lays out at fan 1 no matter
what the model chose.

Measured on device, cards step 149 px against a 148 px card — a 1 px gap, i.e.
no overlap at all, where the model believed there was a 30 px tuck per card.
That is the entire overflow.

The selftest did not catch it because it asserts the *model* against itself
(`handWidthAt(cardW, f) < width`) and never the rendered result.

## The fix

**1. Make the tuck real.** Overlap with a negative `marginLeft` on every card
after the first — which Yoga honours — instead of a negative `gap`, and drop the
`paddingRight` that existed to compensate for it.

**2. Make the model describe the real layout.** The current constants do not
match `Rummy.tsx`:

| | model | actual |
|---|---|---|
| tray padding | `TRAY_PAD` 16 | `paddingHorizontal: S[2]` = 8 + 8 = 16 ✓ |
| tray border | not modelled | `borderWidth: 1` on both sides = 2 |
| gap between trays | `TRAY_GAP` 20 | `contentContainerStyle.gap: S[3]` = 12 |
| scroll content padding | not modelled | `paddingHorizontal: S[1]` = 4 + 4 = 8 |

**3. Test the thing that failed.** Two additions: the fit assertion runs across
the device table at both orientations, and a source guard rejects a negative
`gap` in the hand — the exact construct that made this silent.

## Why not just shrink the cards

`CARD_MAX` has already been walked 70 → 62 → 54 across two rounds of owner
feedback on real phones. The cards are not too big; the tuck that was supposed
to absorb the difference simply never happened. Shrinking further would trade
readability for a bug fix.

## Verification

Device measurement, not inspection. On the Redmi in landscape: count the card
nodes, and check the hand extent against the scroller's own viewport bounds.

- Before: reports `13 cards`, 12 nodes rendered, extent `112..2264` in a
  `2188 px` viewport.
- After: 13 nodes rendered, extent inside the viewport.
