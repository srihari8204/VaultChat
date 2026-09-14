# Rollout & rollback — Rust transport (§21)

**Status: nothing is rolled out. `transport.rust` is 0% everywhere and the
mechanism below is not wired to the socket yet.** This document is the
procedure, written before it is needed, because a rollback procedure written
during an incident is not a procedure, it is improvisation with an audience.

- **Old path (live today):** Socket.IO v4 over WebSocket, JSON payloads —
  `lib/socket.ts` (`transports: ['websocket']`).
- **New path (built, tested, unwired):** `services/transport/rust` — 10
  modules, 107 tests, zero dependencies, sans-IO. Framing is CC-Wire v1
  (`lib/ccwire/frame.ts`, `vaultchat-backend-go/internal/ccwire/frame.go`).
- **The switch:** `lib/featureFlags.ts`, flag name `transport.rust`.

---

## 1. How the switch works

Two levers, deliberately different shapes.

| | Lever | Where it lives | Can it turn the feature ON? | Latency to the fleet |
|---|---|---|---|---|
| **Roll forward** | `EXPO_PUBLIC_FLAG_TRANSPORT_RUST_PCT` | build env, inlined into the JS bundle | yes | EAS update + next app launch |
| **Roll back (primary)** | `VAULTCHAT_REMOTE_FLAGS` | Go backend env → `GET /app/flags` | **no, only OFF** | ~60s to the endpoint, then next app **cold start** per device |
| **Roll back (secondary)** | `EXPO_PUBLIC_FLAG_TRANSPORT_RUST_PCT=0` | EAS update | n/a | EAS update + next app launch |

The asymmetry is `lib/remoteFlagPolicy.ts`'s existing rule and it is not
negotiable: `/app/flags` is **unauthenticated**, so it may only ever disable.
An unauthenticated endpoint that could enable a code path is a remote-enable
primitive pointed at every installation of the app. Rollback is therefore the
fast lever and rollout is the slow one, which is the correct way round.

### Decision order (`evaluateFlag` in `lib/featureFlags.ts`)

1. remote kill → **OFF** (beats everything, including 100%)
2. percent ≤ 0, or unparseable, or missing → **OFF**
3. percent ≥ 100 → **ON**
4. no install id → **OFF** (cannot bucket ⇒ stay on the proven path)
5. `FNV-1a("transport.rust:" + installId) % 100 < percent`

The install id is the existing SecureStore device id
(`services/deviceService.getDeviceId`). Bucketing is a **stable hash, never a
random draw**: the same handset lands on the same side every launch, so "it is
broken for me" is reproducible and raising a stage never moves anyone *back*.
The flag name is in the hash, so two flags at 10% do not pick the same 10%.

### Honest limits of this kill switch — read before you trust it

1. **It lands on the next cold start, not mid-session.** A flag is evaluated
   once per app session and then frozen (so a transport cannot swap under a
   live conversation), and `/app/flags` is fetched once per launch by
   `app/_layout.tsx`. The fleet drains over **hours**, following people's
   natural app restarts — not seconds. If you need faster than that, the only
   real accelerant is a server-side refusal (§6, step 5).
2. **It needs the device to reach `/app/flags` at least once.** Offline devices
   keep their last cached answer (`lib/remoteFlags.ts` persists it to
   AsyncStorage, so a kill set yesterday survives a cold start with no
   network). A device that has *never* fetched has no cached kill — it has only
   whatever percentage its bundle shipped with. That is why stages are small
   and why stage 0 is internal-only.
3. **It only works if the shipped build contains the wiring.** A kill switch
   can only kill code that asks. A build that reads the flag before connecting
   is rollback-able; a build that hard-codes the new transport is not, and must
   never be shipped.
4. **It cannot un-send anything.** See §7.

---

## 2. Preconditions — ALL must hold before one user is moved

Do not treat these as a wish list. Each one, unmet, turns a rollout into an
incident with no lever.

- [ ] **P1 — The server terminates the new transport.** As of this writing it
      does **not**: the only Go files that know CC-Wire are the codec and its
      test, and no route serves it. Verify:
      ```bash
      grep -rln ccwire vaultchat-backend-go --include=*.go
      # today: internal/ccwire/frame.go, internal/ccwire/frame_test.go  ← codec only
      ```
      If that list still contains no file under `internal/routes/` or
      `internal/realtime/`, there is nothing to connect to. Stop here.
- [ ] **P2 — The wiring reads the flag, and reads it before the first connect.**
      `initFeatureFlags()` must be awaited (or at minimum started) in
      `app/_layout.tsx` before the first `getSocket()`. If the flag is read
      before the install id resolves, every user reads OFF — safe, but the
      rollout will silently do nothing and you will chase a ghost.
- [ ] **P3 — Both paths coexist in one build.** The Socket.IO code stays in the
      tree and stays reachable. The rollback is a branch taken at runtime, not
      a build to ship.
- [ ] **P4 — Per-cohort metrics exist and are being collected** (§4). A rollout
      you cannot measure per cohort cannot be aborted on evidence, only on
      vibes. `lib/perf.ts`'s `SendTiming` already carries a `transport` field —
      it must be populated with `"socketio"` / `"ccwire"` and exported.
- [ ] **P5 — Green locally:**
      ```bash
      npx tsx lib/featureFlags.selftest.ts     # expect: All feature-flag checks passed.
      npm test                                 # includes ccwire parity + this file
      cd services/transport/rust && cargo test # expect: 107 passed
      npx tsc --noEmit && npm run lint         # expect: no output / 0 errors
      ```
- [ ] **P6 — CC-Wire Go↔TS parity vectors are current**, i.e.
      `lib/ccwire/parity.selftest.ts` passes against the committed
      `__vectors__/frame.json`. A wire-format divergence must fail a test, not
      a user's message.
- [ ] **P7 — The kill switch has been rehearsed on staging.** Set the env var,
      confirm the endpoint, cold-start a device, confirm it moved back. An
      un-rehearsed rollback is a hypothesis.
- [ ] **P8 — A named owner is awake for the bake window of each stage,** with
      this document open and backend env access already tested (not "I think I
      have access").

---

## 3. Stages

Each stage: set the percentage, ship it, **bake for the stated minimum**, then
evaluate against the abort condition before raising. Never raise two stages in
one day. Never raise on a Friday.

Raising a stage:

```bash
# 1. set the percentage for the build/update
export EXPO_PUBLIC_FLAG_TRANSPORT_RUST_PCT=5

# 2. ship it as a JS update on the production channel (eas.json)
npx eas update --branch production --message "transport.rust 1% -> 5%"

# 3. confirm what actually shipped
npx eas update:list --branch production --limit 3
```

| Stage | % | Minimum bake | Abort if — any one of these |
|---|---|---|---|
| **0. Internal** | forced on in a `preview`-channel build only (`EXPO_PUBLIC_FLAG_TRANSPORT_RUST_PCT=100`, never on `production`) | 5 working days, ≥ 5 handsets incl. one MIUI/ColorOS device and one on a 3G/poor link | **Any** message loss. **Any** crash on the transport path. Send p50 worse than the Socket.IO baseline by > 20%. Any message delivered out of order or duplicated. |
| **1. 1%** | 1 | 48 h, spanning two full daily peaks | New-cohort send-failure rate > **1.5×** control **sustained 30 min**, or > **0.5% absolute**. Crash-free sessions in cohort < control − **0.2 pp**. **One** confirmed lost message (acked in UI, absent server-side) — abort on the first, not the third. |
| **2. 5%** | 5 | 72 h | All of stage 1, plus: reconnects per session-hour > **1.3×** control over 2 h. Send p95 > **1.5×** control. `cantConnect` rate (5 consecutive failures, `lib/socket.ts`) > **1.25×** control over 6 h. |
| **3. 25%** | 25 | 5 days incl. one weekend | All of the above, plus: backend memory or CPU **per connection** > **1.5×** the Socket.IO baseline. Frame-level rejects (`LENGTH_OVER_MAX`, `BAD_VERSION`, `TRAILING_BYTES`) > **0.01%** of frames. Resume failures (`ServerHello.resumed = false`) > **2%** of reconnects. |
| **4. 50%** | 50 | 7 days | All of the above, plus: support contacts matching "not sending" / "not connecting" / "stuck" > **2×** the trailing-7-day rate. Any cohort-correlated regression in delivery *latency* p99, even if p50 is fine. |
| **5. 100%** | 100 | 14 days with **the flag still in place** | All of the above measured against the pre-100% baseline (there is no control cohort any more — this is the stage where you are flying on absolutes, which is why it is last). |

**Every abort condition is "roll back first, diagnose after."** None of them is
a discussion. The cost of an unnecessary rollback is one EAS update; the cost
of a late one is other people's messages.

Only after stage 5 has held 14 days may the Socket.IO path and this flag be
deleted, and that deletion is its own change with its own review.

---

## 4. Metrics — what "control" means here

Because bucketing is a stable, name-salted hash, at every stage from 1% to 50%
you have a **control cohort on the same day, the same networks, the same app
version, the same server build.** That is the only comparison that means
anything. Do not compare to yesterday.

Minimum per-cohort series, tagged `transport=socketio|ccwire`:

| Metric | Source |
|---|---|
| send success rate, p50/p95/p99 send latency | `lib/perf.ts` `recordSend` / `SendTiming.transport` |
| reconnects per session-hour | `lib/socket.ts` connection lifecycle |
| `cantConnect` rate | `lib/socket.ts` (5 consecutive failures) |
| crash-free sessions | crash reporter, split by flag |
| frame rejects by reason | `FrameError` from `lib/ccwire/frame.ts` / the Rust `conn` module |
| resume success rate | `ServerHello.resumed` |

---

## 5. Is the new transport broken, or is the network just bad today?

This question is the reason the control cohort exists. Work down the list; the
first three usually settle it in under ten minutes.

1. **Does it move both cohorts?** A bad network day lifts the failure rate of
   *both* the Socket.IO and CC-Wire cohorts together. Plot the **ratio**
   new/control, not the absolute. Ratio flat while both rise ⇒ **network**.
   Ratio rising ⇒ **transport**. This single check is worth the other five.
2. **What is the shape in time?** A network or carrier event is a step function
   that recovers on its own and does not care what you ship. A transport bug
   steps up **exactly when you raised the stage** and tracks the rollout curve.
   Overlay the stage-change timestamps on the graph; if the step is on one of
   them, it is yours.
3. **How does it cluster?** A network event clusters by **region / ASN /
   carrier** and hits both cohorts inside that region. A transport bug clusters
   by **app version and cohort**, spread evenly across regions. If Mumbai is
   bad on both transports and Berlin is fine on both, it is not your code.
4. **Are there signatures with no network analogue?** A bad link gives you
   timeouts and disconnects. It does **not** give you `BAD_VERSION`,
   `TRAILING_BYTES`, `LENGTH_OVER_MAX`, `MAX_BUFFERED_BYTES` connection drops,
   or `resumed=false` on a healthy socket. Any of those above baseline is the
   code, full stop.
5. **Is the server unhappy too?** Backend error rate, CPU and memory per
   connection are blind to the client's network quality. A rise there that
   correlates with the stage is yours.
6. **The decisive experiment (cheap, ~1 hour):** kill the flag (§6) and watch.
   If the affected users recover while the control cohort stays exactly where
   it was, it was the transport. If both stay bad, it was never the transport
   and you have rolled back for free. **When in doubt, run this experiment.**
   It costs an env var; the alternative costs messages.

Trap to avoid: "the new transport is only bad on poor connections" is not a
reassurance, it is a finding. Poor connections are where a transport earns its
keep, and it is the condition the old one already survives.

---

## 6. ROLLBACK — for someone who did not build this, at 3am

**You do not need to understand the transport to do this. Do steps 1–4 now,
read the rest afterwards.**

### Step 1 — Kill it (server env var, no app release)

Set on the Go backend (`vaultchat-backend-go`) and restart the service:

```
VAULTCHAT_REMOTE_FLAGS={"transport.rust": false}
```

If the variable already has other flags in it, **keep them** — it is one JSON
object, and wiping a colleague's kill switch while fixing yours is how one
incident becomes two:

```
VAULTCHAT_REMOTE_FLAGS={"mini.games": false, "transport.rust": false}
```

It must be valid JSON of booleans. A malformed value is **ignored entirely**
(the server logs `[app/flags] VAULTCHAT_REMOTE_FLAGS is not a JSON object of
booleans`) and **kills nothing** — which is exactly the failure you must not
discover by assuming. That is what step 2 is for.

### Step 2 — Prove it is live (do not skip this)

```bash
curl -s https://api.corefinite.com/app/flags
```

**Expected, exactly:**

```json
{"flags":{"transport.rust":false},"note":"false disables a feature; true is ignored. This endpoint cannot enable anything."}
```

- `"transport.rust":false` present → the kill is live. Continue.
- Flag **absent** → it has not taken. The server caches for **60 seconds**
  (`flagsTTL`); wait 60s and re-run. Still absent → the env var did not reach
  the process. Re-check the deploy, then re-run. **Do not proceed on hope.**
- `"transport.rust":true` → impossible by design (the server strips every
  `true` before answering). If you see it, you are not talking to this backend
  — check the URL and any proxy in front of it.
- Connection error / 5xx → the backend is down, which is a bigger incident.
  Go to step 3 in parallel; it does not depend on the backend.

Check every replica behind the load balancer, not just whichever one answered:

```bash
for i in 1 2 3 4 5; do curl -s https://api.corefinite.com/app/flags; echo; done
```

All five must show the flag. A mixed answer means one replica did not restart.

### Step 3 — Belt and braces: take the percentage to zero

Independent of the server, and it protects devices that cannot reach
`/app/flags`:

```bash
export EXPO_PUBLIC_FLAG_TRANSPORT_RUST_PCT=0
npx eas update --branch production --message "ROLLBACK transport.rust -> 0%"
npx eas update:list --branch production --limit 3   # confirm your update is at the top
```

Do **both** steps 1 and 3. They fail in different ways and neither is complete
alone.

### Step 4 — Watch it drain

The fleet does **not** flip instantly. Each device returns to Socket.IO on its
**next cold start**, because a flag is frozen for the life of a session. Expect
the cohort to shrink over hours, fastest during waking hours in your largest
region. Watch the `transport=ccwire` session count fall and the failure metric
fall with it.

**If the cohort is not shrinking at all after 30 minutes**, the kill is not
reaching clients: go back to step 2, and check that the shipped build actually
reads the flag (precondition P2) — a build that hard-coded the transport cannot
be recalled by any flag.

### Step 5 — Only if steps 1–4 are not enough

If users are actively losing messages and the drain is too slow, the server can
refuse the new transport outright — reject the CC-Wire upgrade/handshake so
every client falls back to Socket.IO on its next reconnect, in minutes rather
than hours. This is a backend change, not a flag, and it is the reason the
client must always retain a working Socket.IO path (P3). Treat it as the
emergency brake: faster, blunter, and it forces a reconnect storm you should be
ready for.

### Step 6 — Afterwards

- Post the timestamp of the kill, the metric that triggered it, and the
  `curl` output in the incident channel. Somebody will ask; have it ready.
- **Leave the kill in place** until the cause is understood and fixed. A
  transport that failed once at 5% will fail again at 5%.
- Re-entry starts at **stage 0 (internal)**, not at the stage you aborted from.

---

## 7. What CANNOT be rolled back

A client flag flip changes what the app *does next*. It does not reach into the
past.

**The format question — the honest answer for today.** Nothing is currently
persisted in a new format, so a client-side rollback *is* format-complete —
but only because the server half has not shipped. As of this writing the only
Go code that understands CC-Wire is the codec (`internal/ccwire/frame.go`) and
its test; no route stores anything derived from a CC-Wire frame. Message bodies
are E2EE ciphertext blobs and land in the same columns whichever transport
carried them, so the database cannot tell the two apart. **Verify, do not
assume** — this changes the moment the server half lands:

```bash
grep -rln ccwire vaultchat-backend-go --include=*.go
```

If that list grows to include anything under `internal/routes/`,
`internal/realtime/` or a migration, **this section is stale and must be
rewritten before the next stage**, because at that point something is being
written in a new shape and a client flag no longer undoes it.

Regardless of format, these are not recoverable by any flag:

1. **Messages already delivered.** Delivered is delivered. Rolling back does
   not un-deliver, un-notify, or un-read them.
2. **Messages lost in the window.** If the new path acked a send to the UI that
   never reached the server, rolling back does not resend it. Only messages
   still marked pending in the outbox retry. Assume anything a user was told
   was sent, but was not, is **gone** — and that is why "one confirmed lost
   message" is an abort condition at 1%, not a data point.
3. **User trust and support load.** People who saw "failed to send" and gave up
   have already closed the app. The tickets arrive after the rollback.
4. **A shipped binary.** You cannot recall an APK/IPA, only neuter it with the
   flag. This is the entire argument for P3 — the Socket.IO path must stay in
   every build that can ever be flagged on.
5. **Resume tokens and negotiated session state** issued by the new transport.
   If the server ever stores them they become inert orphans after rollback
   (harmless), but a client must never present a CC-Wire resume token to the
   Socket.IO path. Session stickiness means a rolled-back install opens a fresh
   Socket.IO session on its next cold start, which is the behaviour you want —
   do not "optimise" that away.

---

## 8. Quick reference

```bash
# Is anything rolled out right now?
curl -s https://api.corefinite.com/app/flags
npx eas update:list --branch production --limit 5

# KILL IT (backend env, then restart)
VAULTCHAT_REMOTE_FLAGS={"transport.rust": false}

# Take the percentage to zero as well
EXPO_PUBLIC_FLAG_TRANSPORT_RUST_PCT=0 npx eas update --branch production --message "ROLLBACK"

# Prove the flag logic still holds
npx tsx lib/featureFlags.selftest.ts
```

Flag name: `transport.rust` · Env var: `EXPO_PUBLIC_FLAG_TRANSPORT_RUST_PCT` ·
Server var: `VAULTCHAT_REMOTE_FLAGS` · Code: `lib/featureFlags.ts`
