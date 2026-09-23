# Implementation plan — interaction integrity

Three levels of done, as elsewhere in this repo:

- **written** — code in the repo, selftest passes, `tsc` clean.
- **deployed** — the file is on prod (deploys are FILE COPY, not git).
- **device-verified** — proven on the two test phones, not inferred from a log.

Architecture is fixed by the work order: **current architecture + ratchets**,
plus a targeted shared primitive only if several confirmed defects share one
cause. Global press interception is prohibited (design D-5). Production
telemetry is out of scope (design D-6).

## Phase A — baseline

- [x] A.1 Record pre-change state so nothing existing is blamed on this work.
      `npx tsc --noEmit` **exit 0**. `npx expo lint` **0 errors**, 268 warnings
      (55 auto-fixable) — the standing baseline. `npm test` **349/350**, the one
      failure being `lib/chatsDeltaProto.selftest.ts`, which is **pre-existing**:
      its 8 failing checks are in §6 account-switch/logout, and `git status`
      shows nothing in that area was touched — **written**

## Phase B — census (evidence only, no fixes)

- [ ] B.1 Duplicate-execution trace for genuinely side-effecting operations:
      press site → handler → guard → mutating call. Must recognise guards under
      any variable name, `disabled={…}` compound expressions, interposed
      countdowns and confirmations, and server-side idempotency. Grep counts are
      not evidence — three prior grep attempts produced false positives on
      `create-poll`, `group-trip` and `emergency-sos`, all of which are guarded — **written**
- [ ] B.2 Silent-failure trace limited to user-initiated mutations that leave
      local state inconsistent with the server. The ~210 empty catches are
      mostly deliberate teardown and are out of scope — **written**
- [ ] B.3 Stuck-state trace. A previous pass found zero; only control flow that
      demonstrates a permanently unresolved state counts — **written**
- [ ] B.4 Navigation: resolve the COMPUTED push targets that literal scanning
      could not (`router.push(mainApp.route as any)` and kin), and record what
      `lib/orphanRoutes.selftest.ts` already proves so nothing is duplicated — **written**
- [ ] B.5 Catalogue INTENTIONAL patterns so they are never "fixed": the twelve
      modal-backdrop touch-swallowing empty handlers, the two unreachable
      `Coming Soon` branches (unreachable because `MINI_APPS_MAIN` is closed
      with `satisfies … route: string`), and the deliberately inert button — **written**
- [ ] B.6 Publish the verified defect list. Categories stay separate:
      CONFIRMED_DEFECT / CONFIRMED_SAFE / INTENTIONAL_PATTERN /
      RUNTIME_VERIFICATION_REQUIRED / UNKNOWN. Unknowns are not defects — **written**

## Phase B result — the verified defect list

Duplicate execution: **one root cause, six call sites.** `components/finance/ui.tsx`
`Btn` is a bare Pressable guarded only by its own props; six finance forms pass
neither `disabled` nor `loading` and hold no busy state, and every write mints a
fresh `uuid()` with no unique index behind it. Everything else checked —
message send, file transfer, group create/join/roles/invites, story post,
profile, delete account, broadcast, community — is **guarded**, several by
server-side idempotency (`directChatEnsure`, the by-id invitation re-arm, the
chitti auction/collection upserts).

Navigation: **no gap.** All 13 computed targets resolve to real route files. Two
are unresolvable by design (an OS launch deep link, and a `returnTo` param) and
neither is a defect in the call. `lib/orphanRoutes.selftest.ts` already owns the
other direction, so **no navigation ratchet was added** — there was nothing to
protect that is not already protected.

Intentional patterns confirmed and preserved: 12/12 empty `onPress` are the
modal-backdrop touch-swallow idiom; 25 `onLongPress` sites are all distinct
secondary actions; the two `Coming Soon` branches are unreachable by type.

## Phase C — fixes applied

- [x] C.1 **Six duplicate finance writes — one latch.** `components/finance/ui.tsx`
      `Btn` takes a `useRef` single-flight latch, released in `.finally`, and
      **only when the handler returns a thenable** so synchronous presses behave
      exactly as before. One change instead of six busy states, in the component
      the six screens already share — **written**
- [x] C.2 **`app/group-insights.tsx:167` stuck spinner.** Re-tapping the active
      span tab: `setSpan(sp)` bails out, `range` (`useMemo([span])`) keeps its
      identity, the `useFocusEffect` deps are unchanged, the effect never re-runs
      and the only `setLoading(false)` lives inside it. The proposed
      `finally` fix was **rejected — it does not work**: the effect body never
      executes. Fixed by not entering the loading state — **written**
- [x] C.3 **`app/chat.tsx` pin/unpin silent failure, both paths.** The bar's
      unpin swallowed the failure entirely; the action-sheet path alerted but
      left the optimistic value on screen. Both now restore the previous pinned
      id and surface the error — **written**
- [x] C.4 **`app/message-reminder.tsx:217` uncancellable reminder.** The row was
      deleted even when the OS cancel threw — and `r.id` is the cancellation
      handle, so the notification would fire with nothing left to stop it. Now
      the row is removed only if the cancel succeeded — **written**

## Phase C — remaining backlog, now closed

- [x] C.5 **`app/chat.tsx` "Clear chat" swallowed the server-side hide.**
      `clearChatMessages` is local-only (`lib/localDb.ts`, four DELETEs incl.
      `sync_cursor`); the single remote call is `setHidden`, and it ran inside
      `try { … } catch {}` directly beneath a comment stating that skipping it
      makes sync pull the whole history back. Swallowed, the screen popped back
      looking cleared. The inner catch is removed: the existing outer catch
      reports it and the success-looking `setMessages([])`/`router.back()` are
      skipped. Retry is safe — every local statement is `DELETE … WHERE` and
      `setHidden` is an absolute SET, both idempotent — **written**
- [x] C.6 **`app/(tabs)/chats.tsx` bulk actions told the user nothing.** The
      **rollback was never missing** — `fetchList()` refetches and replaces the
      optimistic patch with server truth. The *telling* was: selection is
      cleared first, so a Mute that applied to 4 of 6 chats left nothing on
      screen saying so and no selection to retry with. Failures are now counted
      and reported through the same `error` bar the single-chat actions use, and
      reported **after** the refetch is awaited, because `loadList()` calls
      `setError(null)` on success and would otherwise erase the message — **written**
- [x] C.7 **`app/finance/interest.tsx` dropped the history row silently.** The
      latch (C.1) stops the duplicate, not the loss. The file's own header
      promises "Saves to on-device history" and `Saved & History` tells the user
      "Nothing has been lost"; the result on screen is ephemeral (`onClear` and
      navigating away destroy it, and there is no detail route to reopen).
      Announced as `ledger/new.tsx` announces a failed write, under a different
      title because here the *calculation* succeeded — **written**
- [x] C.8 **`app/(tabs)/chats.tsx` dead long-press sheet — deleted, not
      rewired.** `setMenuChat` was only ever called with `null`, so
      `visible={!!menuChat}` was permanently false and all five rows were
      unreachable. **Nothing was lost**: Pin/Mute are the left swipe actions,
      Archive/Delete the right, and Favourite is the header heart in selection
      mode (`bulkFav`, which toggles). Restoring the sheet would take long-press
      away from selection mode, which Split view is reached through — so the
      sheet, the state and the orphaned `doFavourite` are removed — **written**
- [x] C.9 **`app/vault-features.tsx` "Revoke" only deleted the local copy.**
      Verified against the server: `contacts.go` registers
      create/status/verify and **no revoke endpoint**, and codes are minted with
      `INTERVAL '5 minutes'`. Rather than weaken the promise the button makes,
      the promise is kept: `POST /contacts/sync/create` opens with
      `DELETE FROM sync_codes WHERE initiator_id = $1`, so minting a replacement
      and discarding it invalidates the shared code at once. On failure the
      local copy is **kept** and the user is told the code is still valid.
      Same screen, same defect: the section said "expires in 24 hours" against a
      5-minute server TTL — corrected — **written**

## Phase C — fix rules

For each: reproduce or prove by control flow, identify the owning module, make
the smallest change, add regression cover, run targeted tests, verify nothing
else moved. No unrelated cleanup in a touched file.

- [ ] C.1 Fix the defects B.6 confirms — **written**
- [ ] C.2 Each fix carries its evidence: before, proof, root cause, minimal
      change, regression protection, compatibility verified — **written**

## Phase D — ratchets for observed patterns only

- [x] D.1 `lib/financeBtnLatch.selftest.ts` — pins the latch and its wiring, and
      pins that all six screens still save through `Btn`, since the latch only
      protects a screen that renders it. Comments are stripped before matching
      so prose cannot satisfy a code check — **written**
- [x] D.2 **Proved it bites.** Rewiring `onPress={guardedPress}` back to
      `onPress={onPress}` fails check 5b; restoring it passes. The guard also
      caught its own first false positive — an unscoped version failed on
      `IconBtn`/`QuickAction`, which pass `onPress` through correctly — **written**
- [x] D.3 `lib/silentFailure.selftest.ts` — 18 checks pinning all eight
      confirmed defects (C.2–C.9) in one ratchet, in the shape of
      `lib/apiBypasses.selftest.ts`: comments stripped before matching, each
      check naming its invariant and its consequence, auto-discovered by
      `scripts/test-all.ts`. It pins **ordering** as well as presence — the
      success-looking `router.back()` after the hide, the bulk `setError` after
      the awaited refetch, the interest result before its failure alert — so a
      fix cannot be turned back into a silent one by reordering — **written**
- [x] D.4 **Proved it bites.** Five mutations, five expected failures and no
      others: reinstating `catch {}` in `bulkRun` failed 8; reintroducing
      `menuChat` failed 11; dropping `createSyncCode()` from revoke failed 16;
      renaming the interest alert failed 14 and 15; re-wrapping `setHidden` in
      `try/catch {}` failed 6. Sources restored, ratchet green — **written**
- [ ] D.5 A ratchet per further defect pattern actually found, in the shape of
      `lib/apiBypasses.selftest.ts` / `lib/a11yCoverage.selftest.ts`. Each must
      name its invariant, document intentional exceptions, avoid false
      positives, be cheap, and fail on a deliberately introduced violation — **written**
- [ ] D.2 Prove each new ratchet bites by introducing a violation and seeing it
      fail. A guard that cannot fail is decoration — `lib/orphanRoutes.selftest.ts`
      was rebuilt once for exactly this reason — **written**

## Phase E — targeted shared primitive, only if earned

- [x] E.1 **Outcome: no new runtime interaction layer was required.** Exactly
      one cause was shared by several defects — the finance `Btn` behind six
      duplicate writes — and it already had a shared owner, so the fix was one
      latch in that component (C.1), not a new primitive. The other eight
      defects have eight unrelated causes in eight screens; a shared abstraction
      over them would have been invented, not earned. This is the result design
      D-5 and the proposal both predicted — **written**

## Phase F — critical journey tests

- [ ] F.1 Extend existing test infrastructure for the highest-value flows —
      messaging send, call setup, file transfer, settings persistence, a
      destructive action executing exactly once. Tests must exercise
      consequences, not that a button renders — **written**

## Phase G — performance and regression

- [x] G.1 **No performance claim is made, because none was measured.** The
      changes are one `useRef` latch, removed `catch {}` blocks, added
      `Alert.alert` calls on failure paths, and the deletion of an unreachable
      `Modal`. None runs on a render hot path; the deleted Modal removes a small
      amount of per-render work in the chat list, which is **not** claimed as an
      improvement since it was not measured. Baseline held exactly: `tsc`
      **exit 0**, lint **0 errors / 268 warnings**, `npm test` **351/352** with
      the sole failure `lib/chatsDeltaProto.selftest.ts`, pre-existing and
      untouched — **written**

## Phase H — adversarial review

- [ ] H.1 Independent review of the final diff: was each change a confirmed
      defect, was intentional behaviour altered, was an existing solution
      duplicated, could a test have replaced runtime machinery, did security or
      network semantics move, could the change be smaller — **written**

## Separate findings — not in this change

- [ ] S.1 `app/email-bridge.tsx` — verify again, then propose remediation on its
      own terms. It renders `MOCK_INBOX` and answers a send with a 1,800 ms
      `setTimeout` then "encrypted with AES-256-GCM and sent successfully", with
      no network call and no crypto. Unrouted. Honesty defect, not an
      interaction defect; must not be presented as real encryption — **written**
- [ ] S.2 16–17 orphan screens — route or delete, one decision each, under
      `lib/orphanRoutes.selftest.ts`'s existing rule that deleting is safe and
      routing a duplicate is the hazard — **written**
- [ ] S.3 Production interaction telemetry — separate proposal, privacy review
      first — **written**
