# Rummy hand does not fit the table

## Why

A rummy player must see all thirteen of their cards at once. Deciding what to
discard means comparing the whole hand, and a card you cannot see is a card you
do not play.

On the Redmi Note 8 Pro in landscape — the orientation rummy locks to while
playing — the app reports `13 cards` and only **twelve** are on screen. The hand
runs to the right edge of its scroller and the last group sits beyond it. In the
measured hand the card scrolled out of sight was the **joker**.

It does not clip or lose the card: the hand is a `HorizontalScrollView`, so the
thirteenth is reachable by scrolling. That is the whole problem — a hand that has
to be scrolled cannot be read at a glance, which is what the card-sizing work in
`rummyTable.ts` exists to guarantee.

## What changes

The tuck that is supposed to make thirteen cards fit is **inert**.

`GroupZone` overlaps cards with `gap: -overlap`. Gap cannot be negative in
Yoga — as in CSS, a negative value is invalid and resolves to `0`. So the fan
`fanFor()` computes is discarded at render time and the hand always lays out
fully spread, whatever the maths decided.

- Apply the tuck with a negative `marginLeft` on every card after the first,
  which Yoga does honour, and drop the compensating `paddingRight`.
- Correct the width model so it describes the layout that actually renders: the
  inter-group gap is `S[3]` (12), not 20; each tray adds a 1 px border on both
  sides; the scroll content carries its own `S[1]` padding at each end.
- Add a self-check that the chosen fan fits at every device size in the table,
  and a source guard so a negative `gap` cannot come back.

No rule, score, limit, control, string or navigation path changes. The hand
holds the same thirteen cards, in the same groups, with the same interactions.

## Impact

- **Code:** `lib/games/rummyTable.ts` (width model), `components/games/Rummy.tsx`
  (`GroupZone` card row), `lib/games/rummyTable.selftest.ts`.
- **Not affected:** game logic, the server protocol, sorting, grouping, melds,
  scoring, backend.
- **Verification:** measured on device — thirteen card nodes present, hand extent
  within the scroller viewport, no horizontal scroll needed.
- **Risk:** low. The change makes cards overlap slightly on displays where they
  did not fit; on displays with room, `fanFor` already returns 1 and nothing
  moves.
