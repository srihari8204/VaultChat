# Implementation plan — 64-participant group calls

Three levels of done, and a task is not complete until it reaches the one it names:

- **written** — code in the repo, selftest passes, `tsc` clean.
- **deployed** — the file is on prod (deploys are FILE COPY, not git) and hash-verified.
- **device-verified** — proven on the two test phones, not inferred from a log.

**No migration.** This change adds no SQL; the participant count reads
`call_participants` from migration 066, already applied (prod ledger is at 122).

**Files that must be copied to prod** (Go side, phase 4):
- `vaultchat-backend-go/internal/routes/call_sessions.go`
- `vaultchat-backend-go/internal/realtime/handlers.go`
- the rebuilt Go binary
- `livekit/livekit.yaml` (step 4.7 only, and only after the binary is live)

**An Android rebuild is also required** (task 7.6): the group-ring routing fix touches
`android/app/src/main/java/com/vaultchat/app/calls/{VaultCallMessagingService,CallModule}.kt`.
Until an `assembleRelease` ships, a group ring answered from the lock screen behaves as it
does today.

## 0. Baseline — prove what exists before changing it

- [ ] 0.1 Confirm on prod that a group call reaches the SFU today: start a 3-person call and
      confirm the LiveKit room name matches `calls.id`, not a `golive_` room — **device-verified**
- [ ] 0.2 Record the current cost baseline on the Redmi for a 3-person video call (CPU, temp,
      subscribed track count from the SDK debug log) — this is what "flat in participant count"
      is measured against — **device-verified**
- [x] 0.3 Delete `lib/call/sfuRoom.ts` (dead copy; `lib/call/reconnectWiring.selftest.ts:90`
      already asserts nothing imports it) and confirm the selftest still passes — **written**

## 1. Visible set — the change that makes 64 possible (client)

- [x] 1.1 Add `setVisible(ids: string[])` to the `CallRoom` interface in `lib/call/room.ts`:
      diff against current state, `setSubscribed(true/false)` per **video** publication only — **written**
- [x] 1.2 Subscribe **audio for every participant, unconditionally** — the visible set must
      never touch audio (spec: "Nobody is silently muted by scale") — **written**
- [x] 1.3 Replace `wantAll()` and the unconditional `RoomEvent.TrackPublished` subscribe with
      the visible-set path, preserving the explicit `setSubscribed(true)` that fixed the
      first-joiner-receives-nothing bug (`room.ts:175-200`) — **written**
- [x] 1.4 ~~Turn `adaptiveStream: true` back on~~ — **REVERSED, and it stays `false`.**
      adaptiveStream infers visibility from LiveKit's own `<VideoTrack>` components
      attaching. This app renders remote video with `RTCView` over a stream URL, so the SDK
      would see *no* attached views and would be entitled to pause every tile — the
      frozen-tile bug it was originally switched off for, now at full call scale. The
      visible set already does this job from the side that knows. `singlePeerConnection:
      false` and `dynacast: true` untouched, as required — **written**
- [x] 1.5 Keep the previous page subscribed for a short trailing margin and request a keyframe
      on re-subscribe, so scrolling back does not show black — **written**
- [x] 1.6 `lib/call/visibleSet.selftest.ts` — assert-based, no framework, no `require('fs')`:
      with ≤ page-size participants the emitted subscribe calls are **identical to today's
      `wantAll`**; audio is never unsubscribed; a diff produces no redundant calls — **written**

## 2. Active speaker + paged grid (client)

- [x] 2.1 Track active speakers from `RoomEvent.ActiveSpeakersChanged` into the call store;
      expose an ordered speaker list through `hooks/useCall.ts` — **written**
- [x] 2.2 Visible-set ordering: active speakers first, then stable roster order, with a
      3-second dwell floor; never displace a currently-speaking participant (design D-2) — **written**
- [x] 2.3 Rewrite the grid in `app/group-call-active.tsx`: fixed page of tiles + page
      controls, replacing `peerIds.map` over the unbounded `ScrollView` (line 183-193) — **written**
- [x] 2.4 Drive `setVisible` from the rendered page + promoted speakers — **written**
- [x] 2.5 Show the true participant count in the top bar and keep `protectionFor(tiles)`
      feeding the encryption badge, so the claim still tracks live size — **written**
- [x] 2.6 Speaker-order checks — folded into `lib/call/visibleSet.selftest.ts` (checks 5-6)
      rather than a second file: same pure module, same run. Cross-talk does not thrash the
      set; a promoted speaker survives its dwell window; stale speech stops promoting — **written**

## 3. Publish policy (client)

- [x] 3.1 Device-tier helper (screen/pixel-ratio inputs already used by `screenCaptureSize`,
      plus core count) → `'capable' | 'low'` — **written**
- [x] 3.2 `publishDefaults` on the camera publish in `lib/call/room.ts`: 3 simulcast layers
      capable / 2 low-end — **written**
- [x] 3.3 Leave screen share exactly as it is (`simulcast: false`, VP8, bounded capture) —
      this is device-proven and out of scope; add a comment saying so — **written**

## 4. Server — ceiling and fan-out (Go)

- [x] 4.1 Participant ceiling — **moved from `sfu-token` to `POST /calls`, where the seat is
      actually taken.** `sfu-token` requires an existing live `call_participants` row
      (`myRole`), so refusing there would refuse someone already occupying the seat. The
      count now runs INSIDE the join transaction, excluding the caller so a reconnect can
      never be locked out of a call they are still on. 409 + `metrics.Inc("call_full")`;
      `CALL_MAX_PARTICIPANTS` overrides the 64. `go build` + `go test ./internal/routes`
      pass — **written**
- [x] 4.2 Client renders that refusal as "This call is full" (not a generic join failure) — **written**
- [x] 4.3 Group ring moved to `POST /calls/{id}/ring` (`call_sessions.go`) — **NOT the socket
      event first built.** The socket relay could never wake a dozing phone, and that alone
      made a 64-person call impossible to fill (see 7.1). The endpoint resolves members from
      `chat_members` server-side, emits `call_incoming` via `emitx.ToUids`, AND sends the FCM
      wake-up — one unit of ring budget whatever the size. `ring_group`/`ring_group_ok` were
      removed from `internal/realtime/handlers.go` so there is ONE ring path — **written**
- [x] 4.4 **In-call chat for groups — RESOLVED: it stays END-TO-END ENCRYPTED** (owner
      decision). The premise in the audit was wrong: this was never "63 emits per message",
      it was ZERO — `sendChat`/`sendReaction` both opened with `if (!s.peerUid) return`, and
      a group session's `peerUid` is empty by construction, so in-call chat and reactions
      were silently INERT in every group call (the UI echoed locally and sent nowhere). Nor
      was it a weak `CallCipher`: `sealForPeer` is the real pairwise ratchet. So the server
      fan-out is NOT built — it would mean plaintext. `sealAndFanOut` seals once per
      recipient and sends N addressed envelopes, `Promise.allSettled` so one peer without a
      session cannot silence the message for the other 62. 64 people costs 63 seals per
      message; volume is a handful of messages per call, which is why the "never ratchet per
      frame" rule that governs media does not apply. `chatRecipients` moved to the pure
      `lib/call/mode.ts` so the rule is executable, and `lib/call/callChat.selftest.ts`
      (14 checks) is what stops it going inert again — **written**
- [x] 4.4b **Group calls accepted in-call messages from ANY sender.** `accept` was
      `s.peerUid ? from === s.peerUid : true` — strict for 1:1, open for groups. Harmless
      while nothing group-shaped was received; with chat live it let any account that knows
      your uid type into your call. Now gated on the live participant roster — **written**

- [x] 4.5 Client calls `ringCallGroup` (`lib/callSession.ts`), falling back to the per-`to`
      socket loop (`signal.ringPeers`) on any failure EXCEPT 429 — a 429 must not fall back,
      or it would spend 63 more units of the very budget that just refused one — **written**
- [x] 4.6 **DEPLOYED 2026-08-31.** `call_sessions.go` copied (md5 `eb602bfd…`, hash-verified
      both ends), `docker compose build go-api` + `up -d --no-deps go-api`. `handlers.go` was
      NOT copied — it is net-zero (ring_group added then removed). Prod's old file was
      byte-identical to repo HEAD beforehand, so nothing was overwritten blind. Backup:
      `/home/srihari/call_sessions.go.predeploy.20260831-225221`. Verified through the full
      public chain: `POST /calls/{id}/ring` 404 → **401**, and `sfu-token`/`hand`/`leave`/
      `end`/`role`/`POST /calls`/`history` all still 401 — no regression — **deployed**
- [x] 4.7 **DEPLOYED 2026-08-31, strictly after 4.6 was confirmed live.** `livekit.yaml`
      `max_participants` 100 → **200**; `vaultchat-livekit-1` restarted with a plain
      `docker restart` (NOT compose — livekit sits behind the `sfu` profile, so a compose
      command would have prompted the orphan path). Container re-read the bind-mounted file
      and reports 200. All 17 vaultchat containers still up; both SFUs and both egress
      containers untouched — **deployed**

## 7. Making 64 actually reachable (found while applying)

The ceiling and the subscription model make 64 *affordable*. These are what make it
*happen* — without them the call cannot fill up, however well it scales.

- [x] 7.1 **A group call sent no wake-up push at all.** `nativeCall.ringPeer` → `/call/initiate`
      is on the 1:1 path only (`engine.ts:429`); the group path emitted `call_incoming` and
      nothing else. That is a socket event, so a group call rang ONLY phones already awake —
      for 63 people, close to none. `POST /calls/{id}/ring` now pushes as well as emits — **written**
- [x] 7.2 **Joining an in-progress call re-rang everyone.** The hub passes the roster on every
      start and cannot know a call is already running, so the 40th joiner re-rang all 63,
      waking phones already in the room and every one that had declined. The server answers
      `created`; the engine now rings only when it opened the call — **written**
- [x] 7.3 **A chat can be bigger than a call.** The ring is capped at the seat count
      (`ORDER BY joined_at LIMIT 63`) so a 500-member group does not wake 500 phones — with
      DND-bypassing pushes — for 64 seats. Ordered so the set is stable across redials — **written**
- [x] 7.4 **In-call invite.** A call rang once, at the start; anyone asleep or added to the
      group later was locked out for its duration, and the only way back was to hang up and
      re-ring everyone. `engine.inviteToCall` + a person-add control in
      `group-call-active.tsx` ring named people into the live call, with the seats-free count
      shown and the control hidden at capacity — **written**
- [x] 7.5 **A group ring answered from the lock screen would have opened a 1:1 call.** The
      launch intent carries only `callId`/`callerId`, and JS reads `callId` AS the chatId, so
      the answer routed to the 1:1 screen with the group's starter as the peer. `isGroup` now
      rides FCM → `VaultCallMessagingService` → `CallModule` → `app/_layout.tsx`, defaulting
      false so 1:1 and older native builds are untouched. The push also sends the CHAT id as
      `callId` (matching `/call/initiate`) and the GROUP name as the title — **written**
- [x] 7.6 Rebuild the Android app — 7.5 changes Kotlin (`VaultCallMessagingService.kt`,
      `CallModule.kt`), so it is inert until an `assembleRelease` ships it — **device-verified**
- [ ] 7.7 Answer a group ring from a LOCKED screen and confirm it opens the group call, not a
      1:1 with the caller — **device-verified**
- [ ] 7.8 Confirm a killed device rings for a group call at all (the 7.1 fix), and exactly
      once — **device-verified**

## 8. Post-deploy defect found by re-reading the live code

- [x] 8.1 **`ringTargets` applied the seat LIMIT BEFORE the named-invite filter.** The SQL
      took the 63 oldest members by `joined_at`, then Go dropped anyone not named — so in a
      chat larger than 64, inviting anyone who joined after those 63 matched nothing and rang
      **nobody**, while the endpoint still answered `ok`. That defeats the invite in exactly
      the groups big enough to need it. Fixed by filtering in SQL so the LIMIT applies to the
      set actually wanted. Latent rather than live: the biggest chat on prod has 6 members, so
      no invite has ever hit it — **written, and DEPLOYED 2026-08-31** (md5 `4ed5fd76…`)
- [x] 8.2 **The first fix introduced a worse bug, caught before deploying.** It used
      `$3::text[] IS NULL` to mean "no names given", which rests on the driver encoding a nil
      slice as SQL NULL rather than `{}`. Proved against the prod DB that the `{}` case
      selects **0 rows** — i.e. if pgx ever encoded it that way, *starting a call would ring
      nobody at all*. Replaced with an explicit boolean (`true OR …` is true even when the
      right side is NULL). Both branches proven against the real database, not reasoned
      about — **written and deployed**

## 9. APK content verification (A4 — no device needed)

- [x] 9.1 Release APK built: `REAL_EXIT=0`, 90.5 MB, md5 `a233cedc…`. Kotlin `isGroup` confirmed
      present in `classes.dex` and `classes2.dex` — **written**
- [x] 9.2 JS side confirmed in the shipped Hermes bundle: `Add people`, `Speaking`, `seats free`
      (paging + invite UI) and `room: remote published` / `reconciling` (the reworked
      subscription path). So the visible-set, paging and invite code is genuinely in the APK
      that would go on a device — **written**
- [x] 9.3 **Gotcha worth keeping:** `assets/index.android.bundle` is HERMES BYTECODE, and Hermes
      splits its string table in two — ASCII, and UTF-16 for any string containing a non-ASCII
      character. This codebase writes log messages with em-dashes, so a plain `grep` reports
      those strings MISSING and looks exactly like a stale bundle. Search UTF-16LE as well
      before concluding anything. Confirmed by two strings from files never touched this
      session showing the identical false negative — **written**

## 10. Load-test harness (A5) — built and proven

- [x] 10.1 `vaultchat-backend/loadtest/sfu-load.sh`. Orchestration only — `livekit-cli`
      already ships a purpose-built load tester and its image is already on the box, so
      writing a harness would have been reinventing it. Runs tiers, samples the SFU container
      with `docker stats` through steady state (not the connection ramp), and emits the exact
      table the brief asks for — **written and smoke-tested**
- [x] 10.2 **PROD GUARD, and the smoke test is why it is shaped this way.** The first run
      pointed a dev SFU at `--network host`, which could not bind because prod's
      `vaultchat-livekit-1` already owned 7880 — so the dev server died and the load
      generator silently connected to the LIVE SFU. Only a credential mismatch stopped it.
      The guard now treats loopback `:7880` / `:7890` as production, because on that box they
      are. Refuses with exit 2 unless `ALLOW_PROD=yes-i-accept-the-risk` — **verified**
- [x] 10.3 **PREFLIGHT.** That same run "completed" and printed a table of zeros scored
      MARGINAL, while every tester had been refused with `invalid API key`. A one-publisher
      3s probe now runs first and aborts with exit 3 if the target rejects us, so a run
      against the wrong server can no longer look like a result — **verified**
- [x] 10.4 Failure detection fixed: `could not connect` contains none of
      error/failed/timeout, so a total connection failure scored zero errors. Pattern
      widened; `ERRS` no longer emits two lines into the table — **verified**
- [x] 10.5 MEASURED 2026-09-01 against an isolated bench LiveKit (own config, ports
      7899/7883/7884, never prod's 7880/7890). Box: 12 cores, 62 GB, load 1.8, zero live
      calls. Prod healthy throughout; 17 containers untouched; bench torn down after.

      | N | CPU peak | RAM | lo net (20s) | errors | result |
      |---:|---:|---:|---:|---:|---|
      | 8 | 13% | 92 MiB | - | 0 | PASS |
      | 16 | 31% | 151 MiB | - | 0 | PASS |
      | 32 | 27% | 284 MiB | - | 0 | PASS |
      | 48 | 31% | 397 MiB | 25 MB | 0 | PASS |
      | **64** | **36%** | **537 MiB** | 31 MB | 0 | **PASS** |
      | 96 | 76% | 816 MiB | 39 MB | 0 | PASS (near threshold) |
      | 128 | 87% | 1.05 GiB | 47 MB | 0 | MARGINAL |

      Memory is linear at ~8.4 MiB/participant across every tier — the most trustworthy
      series. CPU is noisier, but the shape is clear — **written and measured**
- [x] 10.6 ~~superseded~~ Run the real tiers (8/16/32/48/64) against a bench or staging SFU and publish the
      table. **Blocked: there is no non-prod SFU.** `docker-compose.bench.yml` provides only
      `api` and `go-api`. Either stand up a bench LiveKit, or run against prod in a chosen
      window with `ALLOW_PROD` — an explicit owner decision, not mine

## 5. Verification

- [ ] 5.1 1:1 voice and video on both test phones: two-way audio at first join, no regression
      from the subscription rewrite — **device-verified**
- [ ] 5.2 3-person group call: the path with the thinnest history, and the one the archived
      change flagged — **device-verified**
- [ ] 5.3 Screen share inside a group call still swaps the track without dropping subscribers — **device-verified**
- [~] 5.4 SERVER SIDE DONE (task 10.5): 64 measured at 36% CPU on an isolated bench SFU.
      The HANDSET half remains — subscribed video tracks ≤ page size, CPU and temperature
      against the 0.2 baseline — and still needs a real device — **device-verified**
- [ ] 5.5 Refusal path: the 65th join shows "This call is full" and `call_full` increments — **device-verified**
- [ ] 5.6 Ring budget: two 64-member group calls started inside one rate-limit window both
      ring everyone — **device-verified**
- [ ] 5.7 Off-screen participant speaks → promoted into the grid and heard by everyone — **device-verified**
- [~] 5.8 OEM matrix from `CALLS_README.md` before the mesh fallback is considered removable.
      **Honor row, preconditions only, checked 2026-09-22 on ELI-NX9 (AWJDVB4702008616,
      Android 16, app 1.2.15):** the app is on the deviceidle whitelist
      (`user,com.vaultchat.app,10455`), `POST_NOTIFICATIONS` is `granted=true`, and
      `.calls.VaultCallMessagingService` is registered with an intent filter — so the
      cold-start FCM ring path is not blocked by this OEM's battery policy. That is the
      *precondition*, NOT the behaviour: whether a killed phone actually rings still needs a
      second handset to call from, and the Redmi row is untouched — **device-verified**

## 6. Close-out

- [ ] 6.1 Sync `specs/group-call-scale/` into `openspec/specs/` — only after 5.4 and 5.5 pass
      on prod, per the project's spec convention
- [x] 6.2 **OPENED: `openspec/changes/calls-drop-ring-fallback`.** The binary carrying
      `POST /calls/{id}/ring` is proven on prod (4.6, plus the 8.1 fix), so the fallback's
      original justification is spent. The change is written but GATED on 5.6 — until two
      64-member calls inside one rate-limit window are proven on hardware, the fallback is
      still earning its place. Landing it before then would trade a known safety net for an
      unproven one — **written**
- [x] 6.3 **MEASURED. RECOMMENDED LIMIT = 64 — keep it.**
      64 costs 36% CPU / 537 MiB on a 12-core box: roughly 2x headroom, which is the right
      margin for a number a product promises. 96 fits at 76% but leaves almost none. 128 is
      87% and MARGINAL. Critically, all of this was measured on an **idle** box — in
      production the SFU shares those 12 cores with Postgres, Kafka, Valhalla, two egress
      containers and a second LiveKit, so real headroom is smaller than the table shows.
      **Do NOT raise the audio ceiling to 128.** That question is now answered with data
      rather than intuition: 128 participants is not a config change this box supports
