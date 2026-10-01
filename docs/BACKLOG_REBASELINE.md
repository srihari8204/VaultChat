# Backlog re-baseline

Measured 2026-10-02. **"227 open tasks" is not 227 units of coding work**, and planning
from that number overstates the remaining effort substantially.

This was prompted by a pattern: across three remediation phases, four separate items were
already complete while their source documents still listed them as open — the F03
authorization fix (with a two-user regression test), VC-009 retry idempotency, the WebSocket
upgrade fix, and the identity-change/reinstall test. In each case the document was more
pessimistic than the code, and work was nearly redone.

## What the 227 actually contains

| Category | Count | Why it is not coding work |
|---|---|---|
| **Built, awaiting device verification** | 15 | All of `interaction-integrity`. Its own legend has three levels — `written` (code in repo, selftest passes, tsc clean), `deployed`, `device-verified` — and **every one of its 15 open tasks is marked `written`**. The code exists. |
| **Device-, vendor- or authorization-gated** | ~60 | Needs the two physical handsets, an Apple entitlement, a Play listing, a Figma quota, a second account, a Mac, or an owner decision. Not closable by writing code. |
| **Already done but unmarked** | sampled ~33% of the rest | See the sample below. |
| **Genuinely open coding work** | **roughly 100–110** | The honest planning number. |

Only **20 of 227 (8%)** carry an explicit built/written marker, so the absence of one proves
nothing — it means unmarked, not unbuilt. That is why a sample was needed.

## The sample: `global-device-support` (31 open, 0 marked)

The largest open spec, chosen because its tasks make directly falsifiable claims. Six
checked:

| Task | Claim | Reality |
|---|---|---|
| 5.2 | Delete `utils/notifications.ts`, a duplicate with zero importers | **ALREADY DONE** — the file does not exist |
| 5.3 | `app/(tabs)/chats.tsx` holds `doFavourite` behind an unreachable long-press sheet, and it is "the **only** un-favourite path in the app" | **ALREADY FIXED 2026-09-17.** `chats.tsx:495-503` carries a dated comment: `setFavourite(id, false)` was unreachable, the Favourites folder filled up, and it is now a TOGGLE — "if everything selected is already a favourite, the action removes them." The symbol `doFavourite` no longer exists |
| 2.1 | 42 screens override the root `StatusBar` | **PARTLY DONE** — 21 now, so about half the work is gone |
| 4.6 | Remove the unused `@expo-google-fonts` dependencies | Still open — 2 hits in `package.json` |
| 4.6 | Remove the inert `react-native.config.js` assets key | Still open — `assets: ['./assets/fonts']` present |
| 6.3 | Add a direction-aware layout guardrail | Still open — no such selftest |

**Two of six fully stale, one half-done.** On a 31-task spec that is roughly ten tasks of
phantom work, in one change.

## Consequences for the plan

1. **Phase 7's 8–14 week estimate is too high.** It was sized on 227 tasks. Against
   ~100–110 genuine ones, with 15 needing only device verification, the coding half is
   materially smaller.
2. **Re-baseline before starting any spec, not after.** The cost of checking a task against
   the code is minutes; the cost of re-implementing a finished one is hours, and it also
   risks reverting a later fix.
3. **`interaction-integrity` should be reclassified**, not scheduled. Its 15 tasks belong in
   the device-verification register beside the calls and layout items, because that is the
   only thing standing between them and done.
4. **Mark tasks when they are finished, in the task file.** Every stale item found here was
   closed by a commit that did not update the spec. The three-level legend in
   `interaction-integrity` is the right model and is worth copying: it distinguishes "code
   written" from "proven on hardware", which is exactly the distinction the other specs lose.

## How to re-check a task cheaply

Most tasks in this repo name a file, a symbol or a count. All three are directly checkable:

```
# does the thing the task says to delete still exist?
ls <path>
# does the symbol the task describes still exist?
grep -rn "<symbol>" app lib services
# is the count the task quotes still true?
grep -rln "<pattern>" app/*.tsx | wc -l
```

A dated comment near the code is the strongest signal — several fixes in this repo record
the date and the reasoning inline, which is how task 5.3 was settled in one read.
