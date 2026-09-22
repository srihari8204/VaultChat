# Interaction integrity

## Why

There are **1,787 `onPress` handlers** across 190 screens and 84 components, and
nothing sits between a tap and what it does. No action hook, no press wrapper,
no route registry. Whether a button can be double-fired, whether a failure is
shown, whether a spinner ever stops, is decided screen by screen by whoever
wrote it.

The counts say it is mostly not decided at all:

| | Count |
|---|---|
| `onPress={` props | 1,787 |
| Explicit re-entrancy guards (`if (busy) return`) | 31 across 20 files — **and this number is not evidence, see below** |
| `useRef`-based press guards | **0** (exact; the string does not appear) |
| Screens declaring any busy/saving/sending state | 62 of 190 |
| Screens containing `await` | 167 of 190 |
| `Alert.alert` call sites | 705 across 137 files |
| Raw `ActivityIndicator` | 267 across 147 files |
| Shared loading/empty/error in `components/ui/` | none |
| `router.push` sites / of those with `as any` | 247 / **163** |
| `components/ui/Button.tsx` consumers | **1** |

**The brief this came from leads with dead buttons, and in this codebase there
are none.** A full sweep found:

- **0** TODO/FIXME/STUB comments in `app/` + `components/`.
- **0** reachable "coming soon" handlers. The two `Alert.alert('Coming Soon')`
  calls at `app/(tabs)/mini.tsx:92,95` are **unreachable**: `MINI_APPS_MAIN`
  (`:40-61`) closes with `satisfies readonly { …; route: string; … }[]`, so a
  tile without a route does not type-check and the `if (mainApp &&
  !mainApp.route)` branch cannot be entered.
- **0** genuinely empty handlers. Of 13 `onPress={() => {}}`, twelve are the
  modal-backdrop tap-swallow idiom — an inner `Pressable` eating the touch so
  the backdrop's dismiss does not fire (`app/chat.tsx:4176,4218,4256`,
  `app/(tabs)/chats.tsx:713,735,763`, and six more) — and the thirteenth is a
  deliberately inert button already carrying `busy`.
- **0** navigation calls to a route that does not exist.
- **0** confirmed stuck interactions. The "sets loading, no `finally`" heuristic
  flagged 15 files; nine were opened and all nine reset the flag correctly in
  the catch or after a non-rethrowing try. The absence of `finally` here is
  style, not a defect.

An audit budgeted to find dead buttons comes back empty. The codebase already
carries its own enforcement — `lib/orphanRoutes.selftest.ts` and 60+ sibling
guards — and this is the result of that, not a gap in the search.

What is actually there is narrower, and two of the three are not what the brief
predicted:

- **Duplicate execution — magnitude genuinely unknown, and every estimate so
  far has been wrong.** An adversarial pass sampled four duplicate-sensitive
  screens that a grep called unguarded. **All four were guarded**, by three
  different mechanisms the grep could not see:

  | Screen | What the grep missed |
  |---|---|
  | `app/create-poll.tsx:85` | `disabled={posting}` — the variable is not called `busy` |
  | `app/group-trip.tsx:192` | `disabled={!where.trim() \|\| busy}` — a compound expression |
  | `app/emergency-sos.tsx:166,190` | a countdown interposes, and the shake path guards on `countdown === null && !sending && !sent` |
  | `app/group-members.tsx` | guarded conventionally |

  The app uses dozens of distinct guard variable names — `posting`, `bkBusy`,
  `attaching`, `creating`, `clearing`, `arriving`, `callingDriver` and more —
  and the guard usually lives on the element as `disabled=`, not in the handler
  as `if (x) return`. Only **20** of 1,787 press sites are written
  `onPress={async`; the rest are a synchronous press calling a named function
  elsewhere in the file.

  **No grep can size this category, including the ones that produced the
  numbers above.** It might be large. It might be largely handled. Nobody knows
  yet, and this proposal must stop implying otherwise.
- **Silent failure — 210 empty catches, but only ~9 files are the pattern that
  matters.** Most are deliberate best-effort teardown on logout and delete
  paths, with comments saying so (`app/delete-account.tsx:99`). The real ones
  swallow a data mutation: `app/chat.tsx:3719` unpins locally, `await
  pinMessage(chatId, null)` fails, and the failure is invisible and un-reverted.
- **One screen that lies about a security property.** `app/email-bridge.tsx`
  renders `MOCK_INBOX` (`:17`) and its send handler is `setSending(true)` → a
  1,800 ms `setTimeout` → `Alert.alert('Encrypted & Sent', '…encrypted with
  AES-256-GCM and sent successfully')` (`:94-104`). No network call. No crypto.
  It is also unrouted. This is not an interaction defect — it is an honesty
  defect, and it outranks everything else in this proposal.
- **16–17 orphan screens**, carrying maintenance cost and rot.
  `lib/orphanRoutes.selftest.ts:142-154` already pins which routes are permitted
  to be unreachable and from where.

The prevailing guard is also weaker than it reads in one specific way.
`if (busy) return; setBusy(true)` gates on **state**, which blocks the second
press only once a render has flushed the new value and the `disabled` prop with
it. Two presses with no render between them both see `busy === false`.

Not reproduced on a device, and **not claimed as an observed production
defect**. It is a reason to reach for a synchronous guard at a *specific*
verified race, per the correctness rule — not a reason to add one everywhere.

## What changes

**Architecture: current architecture + ratchets, plus a targeted shared
primitive only where several confirmed defects share one cause.** No new global
interaction layer. This is the authorised default and the evidence below
supports it rather than merely permitting it.

- **Confirmed defects only, smallest fix each.** The census (task 0.x) produces
  the backlog; nothing is "fixed" that was not first proven by reading the
  control flow.
- **Ratchets** in the established shape of `lib/apiBypasses.selftest.ts` and
  `lib/a11yCoverage.selftest.ts`, written only for defect patterns actually
  observed — never for hypothetical ones.
- **Targeted Layer 1** — a small reusable primitive — only if several confirmed
  defects share exactly one cause. Feature ownership stays with the feature.

## Explicitly prohibited in this change

- **Layer 0 / global press interception.** Not merely deferred: prohibited.
  React Native exports components as getters
  (`node_modules/react-native/index.js:69` is `get Pressable() { … }`), so the
  `alertGuard` assignment technique cannot apply, and `Object.defineProperty`
  against a dependency's property descriptor is not a foundation. Coverage would
  also be partial — 5 files import touchables from `react-native-gesture-handler`,
  1 builds one through `Animated.createAnimatedComponent`, and 26 `onLongPress`
  sites are untouched by an `onPress` guard. If evidence ever demands it, it
  needs its own proposal carrying RN-version compatibility, refs/measure
  implications, gesture-handler and Animated coverage, upgrade risk, measured
  performance and a rollback plan.
- **Production telemetry.** Out of scope. The usage pipe's contract — screen
  name only, no user, no time, no order — stays exactly as it is, along with
  `caddy/public/privacy.html`, `lib/usageCounter.selftest.ts`, the allow-list in
  `usage.go:42` and `migrations/130_screen_usage.sql`. Per-click events,
  interaction sequences and interaction histories are not sent anywhere. Any
  diagnostic logging added is development-only, carries no message or file
  content, and costs nothing in production.
- **Replacing guards that work.** A guard named `posting` or expressed as
  `disabled={!text.trim() || busy}` is a guard. Renaming it is not a fix.

## What this deliberately does not change

- **No default `accessibilityRole` injected.** Defaulting every touchable to
  `"button"` is wrong for the controls already using `tab`, `radio`, `switch`
  and `checkbox` (`app/camera.tsx:384,462,508`, `app/receipt-control.tsx`), and
  a confidently wrong role spoken aloud is worse than silence — the same
  reasoning `lib/a11yCoverage.selftest.ts:79` applies to labels. Roles stay a
  ratcheted sweep.
- **No migration of the 1,787 call sites.** Only the handlers behind confirmed
  defects are touched. A working handler is left alone whatever it looks like.
- **No `app/email-bridge.tsx` cleanup here.** It is a real finding — mock inbox,
  a 1,800 ms `setTimeout`, then "encrypted with AES-256-GCM and sent
  successfully", with no network and no crypto — but it is an honesty defect in
  an unrouted screen, not an interaction defect. Recorded separately so this
  change does not quietly widen into deletions.
- **No convergence of the three button systems** (`components/ui/Button.tsx`,
  `components/finance/ui.tsx:216`, `components/games/ui.tsx:362`) in this
  change. It is cosmetic and must not block the correctness work.

## Telemetry, and why it is not here

"End-to-end interaction traceability" was considered and is **excluded**. The
usage pipe stores `screen_usage (screen, day, views)` with no user, no
timestamp and no ordering, behind a ~48-name allow-list, a fail-closed
12-batches/hour limit answering 204, and an 8 KiB cap. That shape is asserted by
`lib/usageCounter.selftest.ts` and published in `caddy/public/privacy.html`.

Per-interaction data would mean rewriting a public privacy promise. That is a
privacy decision with code attached, it is separable from every correctness fix
here, and it therefore belongs in its own proposal with its own review. Nothing
in this change touches it.

## Non-goals

- Visual redesign of any screen.
- Replacing `Alert.alert` at its 705 call sites. Layer 1 gives new code a better
  surface; the existing ones are left alone, as `alertGuard` left them.
- Any claim that a structural check proves device behaviour. The repo's
  convention is that these are separate evidence
  (`lib/call/reconnectWiring.selftest.ts:3`), and this change keeps it.
