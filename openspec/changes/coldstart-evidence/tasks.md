# Tasks — coldstart-evidence

## Phase A — establish what is actually true (source evidence only)

- [x] A1. Record the starting state: branch `hetzner-deploy`, HEAD `0965e71`, 312 dirty
      files. Do not reset, clean or stash anything not owned by this change.
- [x] A2. Establish measurement validity. The installed APK is dated 2026-09-18 00:02 and
      predates the 312 changed files, so it cannot be evidence for this tree. No device is
      attached. Device measurement is therefore **NOT RUN**, not "pending".
- [x] A3. Trace the real startup dependency graph with file:line evidence — what blocks the
      first usable chat list, what runs in parallel, what waits for unlock by design, what
      defines "authenticated messaging ready", and where a timeout can stall a usable path.
- [x] A4. Establish the actual serialization format at every layer: HTTP bodies, CC-Wire
      frame envelope, the payload nested inside that envelope, local persistence, and the Go
      backend's own view of the same contract.
- [x] A5. Establish exactly what the `submits` / `acks` / `fallbacks` counters increment on,
      and what they exclude.
- [x] A6. Adjudicate every prior claim CONFIRMED / DISPROVED / STILL UNVERIFIED. Results:
      - `db_ready +66ms` bounds startup — **DISPROVED as stated**. Offsets are relative to
        `boot_effect_start`, not process start, and the mark sat at a caller of a memoized
        promise.
      - `0 / 0` proves no protobuf traffic — **DISPROVED**. Those counters cover only
        eligible outbound plain-text chat submissions.
      - Startup HTTP uses JSON — **CONFIRMED present**; "JSON dominates cold start" remains
        **STILL UNVERIFIED** and is not answerable from source.
      - Chat list renders from cache first — **CONFIRMED CONDITIONALLY**: it is a race, not a
        sequence, and it does not happen at all when the cache is empty.
      - Protobuf envelope implies protobuf payloads — **DISPROVED**. `AppEvent.payload_json`
        carries UTF-8 JSON; every realtime event is JSON inside protobuf.
      - `859ms` vs `13.4s` — **INVALID COMPARISON**, retracted: first draw vs readiness.

## Phase B — instrument, without building a second timing framework

- [x] B1. Extend `lib/perf.ts` rather than adding a framework: widen `BOOT_MARK` so the
      db, chats and transport marks survive into release logs.
- [x] B2. Move `db_open_start` / `db_ready` **inside** `getLocalDb()`. A mark at a caller of
      a memoized promise measures when that caller observed it, not the open.
- [x] B3. Remove the caller-side `db_ready` from `app/_layout.tsx`, keeping the deferred
      dynamic import intact so the existing cold-path guard still holds.
- [x] B4. Mark which paint actually wins in `app/(tabs)/chats.tsx`:
      `chats_paint_cache` (with row count), `chats_cache_empty`, `chats_paint_net`.
- [x] B5. Add connection-scoped wire totals at the two funnels in `lib/ccwire/client.ts`
      (`framesIn/framesOut/bytesIn/bytesOut/decodeFailures/encodeRefusals`) and expose them
      via `metrics()`. Counts and byte lengths only — no frame body, id, token or payload.
- [x] B6. Spread those totals plus `preHandshakeCloses` into `ccwireDiagnostics()`.
- [x] B7. Relabel the misleading rows in `app/perf-debug.tsx`
      ("Protobuf submits / acks" → "Text submits / acks (ccwire)", "HTTP fallbacks" →
      "Text sends that fell back") and render the new frame rows.
- [x] B8. Correct the stale `STATUS: NOT WIRED` headers in `lib/ccwire/codec.ts` and
      `lib/ccwire/frame.ts`. Both are live on the app path and the banners were leading
      readers to the opposite conclusion.
- [x] B9. Leave runnable guards behind in `lib/startupColdPath.selftest.ts` and prove each
      one fails when its fix is reverted (all three verified failing on revert).
- [x] B10. `tsc --noEmit` clean; cold-path selftest passes.

## Phase C — measure on a device (BLOCKED, NOT RUN)

- [ ] C1. Reconnect a handset (`adb devices` is currently empty; the Honor needs its
      "Allow USB debugging" prompt accepted).
- [ ] C2. Build and install a debug/dev build of **this** tree. Blocked by the standing
      "don't build apk" instruction — needs an explicit go-ahead.
- [ ] C3. Capture 5 cold starts per device: `adb shell am start -W -S` for first frame, and
      `adb logcat -s ReactNativeJS` filtered to `[perf]` for the mark timeline.
- [ ] C4. Record the CC-Wire rows from perf-debug after each launch: state, carrier, frames
      in/out, bytes in/out, decode fails, pre-handshake closes.
- [ ] C5. Report medians with the sample count and the device, never a single run.

### First measurement, 2026-10-01 — EMULATOR ONLY, C1-C5 remain open for handsets

The emulator was stood up (`emulator-5554`, x86_64, Android 16 / API 36, 2048 MB,
GMS 25.26.35), an x86_64 release APK installed, and the C3 procedure run as written.

| Boundary | Device | Samples | Median | Range |
|---|---|---|---|---|
| `am start -W` TotalTime (first frame) | emulator x86_64 / API 36 | 5 | **2615 ms** | 2288-2813 |
| same, after the socket-ladder fix | emulator x86_64 / API 36 | 5 | **2436 ms** | 2082-2853 |

**The 2615 -> 2436 difference is NOT a claim.** The ranges overlap substantially and
n=5; per this change’s own standard that is noise, not an improvement. Recorded so the
next person does not re-derive it as a win.

First launch measured 8095 ms and is **discarded, not averaged in** — it included
first-run dexopt/ART profile work. That outlier is the reason this change insists on a
sample count.

**This does NOT close C1-C5.** The tasks say "per device" and an emulator is not a
handset: no hardware-backed Keystore, no Doze/OEM battery behaviour, different CPU and
I/O. Treat 2615 ms as an emulator floor, and do not compare it to any number in this
repo measured to a different boundary (per this change's own founding complaint).

What the `[perf]` timeline showed, which is a finding in its own right: **74 of the 77
marks in a signed-out cold start were `socket_connect_start` /
`socket_connect_no_token` / `transport_ccwire_unavailable`**, because
`addPersistentListener` ran a private 30-attempt connect ladder per listener and seven
are armed at boot. The boot marks this change exists to read were unreadable underneath
it. Fixed by sharing one ladder (`lib/socket.ts`, `ensureConnectAttempt`). **Re-measured
after the fix: 74 -> 13** attempts in the same 14s window, which is exactly what a single
ramping ladder predicts (200+400+...+1400 then 1500s reaches ~14s at attempt ~13). The
boot marks are now legible: 6 real marks against 13 noise rather than against 74.

## Phase D — act only on what C measured

- [ ] D1. `shouldCheckRestore()` opens SQLite on the critical path to the chat list, on every
      cold start for any user who has never opened the restore screen
      (`markRestorePromptSeen` is only ever called from `app/restore-backup.tsx`). Confirmed
      in source; the **cost** is unmeasured. Do not "fix" it before C1–C5 price it.
- [ ] D2. Re-examine the 18s / 15s / 15s CC-Wire timeout ladder only with measured evidence.
      Do not shorten timeouts at the expense of legitimate slow connections.
- [ ] D3. Re-check whether the server ships `CCWIRE_APP_EVENTS=1`. The client requires app
      events, so without it there is no realtime transport at all. Server-side question; not
      answerable from this tree.

## Phase E — write up

- [ ] E1. Report measured numbers with their boundary named (first frame / first paint /
      authenticated-ready), the device, and the sample size. Never compare two different
      boundaries as if they were the same metric.
- [ ] E2. Keep every unmeasured item labelled unmeasured.

## Non-negotiables honoured

- No new database, schema migration, dependency, profiling package or workflow.
- No change to authentication, E2EE, key handling, message ordering, receipts or catch-up.
- No APK build, deploy, upload or production config change.
- No token, key, PIN, phone number, message content or payload logged — the new counters
  are integers and byte lengths only.
- No test message sent to a real contact.
