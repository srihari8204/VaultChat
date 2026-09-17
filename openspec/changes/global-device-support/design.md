## Context

The app already owns every abstraction this change needs — `constants/layout.ts`, `components/ui/KeyboardSafe.tsx`, `lib/useKeyboardInset.ts`, `components/ui/Text.tsx`, `lib/typeScale.ts`, `constants/theme.ts`, `lib/i18n/engine.ts` — plus six passing source-scan selftests. Nothing is missing. Two things are wrong: the **foundation is frozen**, and **adoption is partial**.

Frozen foundation: `constants/layout.ts` derives `TOP_INSET`, `BOTTOM_INSET`, `IS_NARROW` and `IS_SHORT` once, at module scope. Its in-file justification — that a foldable re-launches the activity — is contradicted by `AndroidManifest.xml`, which declares `configChanges` including `screenSize|screenLayout|smallestScreenSize`. The activity is never recreated, so those values never change after launch. Because `android/gradle.properties:46` sets `edgeToEdgeEnabled=true` for all API levels, this affects Android 7 through 16 equally; Android 15+ only removes the ability to opt out.

Partial adoption, measured: 113 of 192 `app/` files use neither `HEADER_TOP` nor safe-area insets; 42 screens override the single theme-aware status bar; 128 files import `Text` directly instead of the shared component, so the type scale reaches 13 files and the brand fonts reach ~1.8% of rendered text; ~30 keyboard sites bypass `KeyboardSafe`; 4 rows overflow because they lay out a variable number of fixed-width children.

Constraint that shapes everything below: the repo's own conventions require the smallest correct implementation, reuse before new abstractions, and one runnable assert-based check per non-trivial change, with no `require('fs')` in app code.

## Goals / Non-Goals

**Goals:**
- Make insets and breakpoints window-reactive, so rotation, folding and split-screen are correct by construction.
- Establish single ownership for the status bar, keyboard avoidance, and typeface selection, so per-screen divergence becomes impossible rather than merely discouraged.
- Remove the overflow class where a variable count of fixed-width children sits in a non-wrapping row.
- Leave no unrouted screen or duplicate module: reroute what is useful, delete what is not.
- Extend the existing guardrails so every fixed class is pinned, and ratchet the two counts (direct `Text` imports, hardcoded strings) that can only improve gradually.

**Non-Goals:**
- No new layout, theming or design-system dependency. `react-native-edge-to-edge` is correctly absent — RN 0.81 handles edge-to-edge natively.
- No rewrite of `typeScale`, `responsive` or the theme palettes; they are sound.
- No per-screen visual redesign, and no migration of all 128 direct `Text` importers in this change.
- No RTL locale content, no iOS CallKit, no changes to CC-Wire, E2EE, money, `FLAG_SECURE`, or road-distance rules.

## Decisions

**1. Fix the foundation first, alone.** `constants/layout.ts` becomes hook-based. This is the only item with wide blast radius, so it lands as its own step with the full suite run against it, before any adoption work. Alternative considered: migrate screens first and fix the foundation later — rejected, because every migrated screen would consume frozen values and need revisiting.

**2. Keep the constant names; change what they read.** Call sites keep referring to `HEADER_TOP` and `SCREEN_BOTTOM` through a hook rather than a module constant. Alternative considered: a new `useLayout()` API with new names — rejected as churn across 62 files for no behavioural gain.

**3. Enforce single ownership by guardrail, not by review.** The status bar, keyboard avoidance and typeface each get a source-scan assertion in the existing selftest style. A rule that is only documented decays; the repo already demonstrates the pattern with its a11y ratchet. Alternative considered: lint rules — rejected, because the project's enforcement idiom is assert-based selftests and adding an ESLint plugin is a new dependency for the same outcome.

**4. Fix typography at the wrapper, not the call sites.** A caller-supplied `fontWeight ≥ 700` currently swaps the brand face to the system font, because Android resolves asset fonts by filename and no `_bold` variant exists. Fixing the shared component fixes 22 current sites and every future one. Alternative considered: correcting each call site — rejected; it treats symptoms and the next contributor reintroduces it.

**5. Ratchet what cannot be fixed at once.** Direct `Text` imports and hardcoded strings are counted, recorded, and only allowed to fall. This converts two large migrations into a monotonic process without blocking this change on either.

**6. Reroute-or-delete is decided per path, and both outcomes are acceptable.** The orphaned `permissions` → `biometric-setup` → `security-questions` chain, `utils/notifications.ts`, the `mini.tsx` calculator and the `chats.tsx` long-press sheet are each judged on whether the product needs the capability. One is already decided by evidence: the long-press sheet holds the **only** un-favourite path in the app, so that capability is currently absent from the product and must be rewired, not deleted.

**7. Overflow is fixed by the cheapest escape that matches the design.** Wrap where controls are peers (call controls), size relatively where the parent already caps width (chat media cards), shorten where a label is the sole cause (recording actions). Alternative considered: a horizontal `ScrollView` everywhere — rejected, because a control the user cannot see is not discoverable even if it is scrollable, and End-call must never be off-screen.

## Risks / Trade-offs

- **The hook migration is the risky step** → Landed alone, ahead of everything else, with the full suite and both reference devices exercised before the next step begins. Revert is a single-file rollback.
- **Hook-based insets re-render more often than frozen constants** → Values change only on genuine window changes; screens already re-render on theme and navigation. If a hot path measures worse, memoise at that screen rather than reverting the foundation.
- **Removing `StatusBar` from 42 screens could reveal screens that relied on the override to be legible** → The root bar is theme-aware, so the correct appearance follows the theme; any screen that genuinely needs a different treatment gets a documented exemption rather than a local override.
- **Ratchets can be gamed or can block unrelated work** → They fail only on an increase and the budget is lowered on improvement, so they never block work that leaves the count flat.
- **A wrapping call-control bar changes call-screen layout** → Controls keep their order and size; only the line count changes. Verified on both reference devices and at 320 dp before it ships.
- **Deleting orphaned screens could remove something a future feature wanted** → Deletion is per-path and justified in the task; anything ambiguous is rerouted instead, which is the reversible choice.

## Migration Plan

1. Foundation: `constants/layout.ts` becomes hook-based; full suite; both devices.
2. Chrome ownership: status bar removed from 42 screens; keyboard sites routed through `KeyboardSafe`, starting with account recovery and the `Modal` composers.
3. Overflow: call controls, recording actions, chat media cards.
4. Typography: shared component made authoritative; font names resolved for both platforms.
5. Route integrity: reroute-or-delete each orphaned path, with the un-favourite action rewired.
6. Guardrails: extend the selftests and record the two ratchet budgets.

Each step is independently revertible. Rollback is per-step; no step depends on a later one.

## Open Questions

- **Figma**: the request named Figma as an input, but no design file or link has been provided and none is referenced in the repo. Visual decisions in this change are therefore limited to correctness — clearing insets, preventing clipping, honouring theme — and no aesthetic redesign is attempted. A file link would let the type scale, spacing and palette be reconciled against the intended design rather than inferred from code.
- **iOS**: the font-resolution requirement assumes iOS remains a target. There is no `ios/` directory in the repo, so the iOS path has never been exercised. If iOS is not a near-term target, the font-name fix is still correct but the verification scenario cannot be run.
- **RTL**: `lib/i18n/engine.ts` carries direction awareness but no RTL locale ships. The direction-aware layout requirement is written so it can be enforced by guardrail before a locale exists; whether to ship an RTL locale is a product decision outside this change.
- **Which orphaned screens the product still wants**: `permissions`, `biometric-setup` and `security-questions` are reachable only from each other. Rerouting them into settings or onboarding is a product call; deletion is the alternative. This needs an owner decision before that task is executed.
