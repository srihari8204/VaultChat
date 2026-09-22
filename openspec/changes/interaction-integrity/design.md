## Context

Two mechanisms already exist in this repo for exactly this class of problem, and
this design is built out of both rather than beside them.

**Wrap once at a boundary.** `lib/alertGuard.ts:38` monkey-patches `Alert.alert`
at startup because there were 694 call sites and therefore "no boundary to
suppress it at — unless one is made". One line at `app/_layout.tsx:129`, pinned
structurally by `lib/sessionEnded.selftest.ts:72`. It is idempotent, it wraps
the bound original, and its header explicitly forbids widening what it
suppresses. It is cited here as the repo's precedent for cross-cutting concerns
— and as the one this change deliberately does NOT extend to presses, for the
reasons in D-5.

**Scan the source and ratchet.** 272 `*.selftest.ts` files, ~160 reading source,
discovered by `scripts/test-all.ts:75` with no registration. Three are direct
templates:

- `lib/apiBypasses.selftest.ts` — every raw `fetch(SERVER_URL…)` is listed with
  a reason; the guard exists so that "it fails when a SEVENTH appears". It is
  explicit that it cannot tell a justified bypass from a lazy one, and that the
  judgement lives in a document.
- `lib/a11yCoverage.selftest.ts` — a `BUDGET` that may only fall, an in-source
  `a11y-exempt:` opt-out requiring a reason, and a failure when the real count
  drops *below* the budget so a finished sweep must be recorded. It is at
  `BUDGET = 0` with zero exemptions in use, which is the evidence that this
  mechanism reaches the end here rather than stalling.
- `lib/orphanRoutes.selftest.ts` — was rebuilt after being "proved unfalsifiable
  by mutation"; matches a route as a string literal wherever it appears, so
  quoting and push/replace/Link are irrelevant. It already computes the two sets
  this change needs.

## Goals / Non-Goals

**Goals.** Close duplicate execution, silent failure and never-settling
interactions, without a 1,787-site migration, and make the position
unrepeatable-backwards.

**Non-Goals.** Uniformity for its own sake. Three button systems may keep
existing. 705 `Alert.alert` sites stay. No screen is redesigned.

## Decisions

### D-1: a synchronous guard only at a verified race, never by default

`if (busy) return; setBusy(true)` gates on state, so it blocks the second press
only once a render has flushed. A ref closes that window. That is a reason to
use one **where a specific race has been demonstrated**, not a reason to add
refs across the app.

And a UI guard is not the correctness mechanism for a distributed operation.
Where the server already deduplicates — an idempotency key, a unique index, a
client-generated id — that is the guarantee, and the UI guard is only there to
stop the user seeing two spinners. Debounce is not exactly-once and must never
be described as if it were.

### D-2: a guard is meaningful only while a promise is pending

A synchronous handler is effectively unguardable and does not need guarding — it
finishes before a second press can land. Any guard added by this change applies
while the handler's returned promise is pending, and a handler that returns
nothing keeps behaving exactly as it does today.

### D-3: drop the second press, never queue it

A queued second press fires an action the user believes they cancelled, which
for a send or a payment is worse than doing nothing.

### D-4: no `accessibilityRole` default

Rejected. The wrong role is spoken confidently; `app/camera.tsx:384,462,508`
alone uses `tab`, `checkbox` and `radio`. `lib/a11yCoverage.selftest.ts:79`
already refuses to guess labels for the same reason. Roles remain a ratcheted
sweep — 322 roles against 1,425 touchables, and `accessibilityState` at 65.

### D-5: Layer 0 is prohibited in this change

Not deferred — prohibited, and the evidence is why.

**The technique does not transfer.** `lib/alertGuard.ts` works because
`Alert.alert` is a writable property. React Native exports components as
**getters**: `node_modules/react-native/index.js:69` is `get Pressable() { … }`
in a getter-only object literal. Assignment fails silently in sloppy mode and
**throws in strict mode**, which is what Babel emits. `Object.defineProperty`
against a dependency's property descriptor is not a foundation to build on.

**And the coverage is partial anyway:** 5 files import touchables from
`react-native-gesture-handler`, 1 builds one via
`Animated.createAnimatedComponent`, and 26 `onLongPress` sites are untouched by
an `onPress` guard.

If evidence later demands global interception, it gets its own proposal stating
the verified problem, why a targeted primitive cannot solve it, RN-version
compatibility, refs/measure implications, gesture-handler and Animated
coverage, upgrade risk, measured performance, and a rollback strategy.

### D-6: production telemetry is out of scope

The usage pipe's contract is screen name only — no user, no timestamp, no
ordering — pinned by `lib/usageCounter.selftest.ts` and published in
`caddy/public/privacy.html`. Changing it is a privacy decision, it is separable
from every correctness fix here, and it therefore belongs elsewhere.

Development-only diagnostics are permitted where they help, on three
conditions: disabled in production, no message or file content, negligible
overhead.

### D-7: the census is a script, not a document

`docs/FEATURE_GAP_MATRIX.md` is the warning: a hand-written audit that was
accurate when written and is now wrong in the direction that causes damage,
marking shipped features as broken. The inventory this change produces must be
re-runnable, so it is a script whose output is regenerated, not prose.

## Risks / Trade-offs

| Risk | Mitigation |
|---|---|
| A "fix" changes a working handler | Only confirmed defects are touched; a guard under another name is still a guard (D-1) |
| A UI guard is mistaken for exactly-once | D-1: where the server deduplicates, that is the guarantee; debounce is never described as exactly-once |
| A ratchet written for a hypothetical pattern produces false positives | Ratchets are written only for defect shapes actually observed in the census, with documented exceptions, and each must fail on a deliberately introduced violation |
| The census's own method is unreliable | D-7 plus the record of three failed grep-based attempts; the census traces press → handler → guard and reports UNKNOWN rather than guessing |
| Scope creeps into unrelated cleanup | `email-bridge` and the orphan screens are recorded as separate findings, not folded in |

## Migration Plan

Baseline → census → fix confirmed defects only → ratchets for observed patterns
→ a targeted shared primitive only if several defects share one cause →
critical-journey tests → performance check → adversarial review.

Every step is independently revertible, and none of them changes a working
screen's behaviour.

## Open Questions

- Do enough confirmed defects share a single cause to justify any shared
  primitive at all? If not, the answer is "no new runtime layer", and that is a
  legitimate and likely outcome.
- Where a verified duplicate-send race exists, is the right fix in the UI or is
  the server already idempotent for that endpoint? Checked per operation, not
  assumed.
