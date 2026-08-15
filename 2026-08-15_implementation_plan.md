# VaultChat Implementation Plan — from the 2026-08-15 audit

Companion to [2026-08-15_audit.md](2026-08-15_audit.md). That file says *what is true*;
this one says *what to do, in what order, and what must not be done*.

---

## 0. The decision — RESOLVED (owner directive, 2026-08-15)

> **This section replaces an earlier recommendation.** The first draft proposed an
> 8.5-day "reconcile" redesign and told you never to set `DELETE_ON_DELIVERY`.
> Both were wrong. The owner's stated model — *delete once delivered, keep forever
> until delivered* — is **already implemented**, is **not** subject to the 30-day
> floor, and needs configuration rather than construction.

### The owner's model

- A message that has **reached the recipient's device** should leave the server within
  ~3 h. The device holds it locally, encrypted; that copy is authoritative.
- A message that has **not** reached anyone must be kept — for 30 days, 60, however
  long it takes — because the server is the only copy that can still deliver it.

### Why this dissolves the conflict instead of resolving it

The clash was never 3 h vs 30 days. It was **clock-bound vs delivery-bound** retention.
`MinRetentionDays` is a floor only on paths that **ignore delivery**. The delivery-driven
path is deliberately exempt — from [jobs.go:82](vaultchat-backend-go/internal/jobs/jobs.go#L82):

> "`retentionGraceSec` is the post-DELIVERY grace period, and it is **deliberately NOT
> clamped to the floor**… An earlier revision clamped this to 30 days as well. That was
> wrong… a body that every device has already received MAY be reclaimed after a short
> grace (**three hours, say**)."

The code's own author wrote "three hours, say" as the example. This is the intended design.

`sweepDeliveredMessages` ([jobs.go:241](vaultchat-backend-go/internal/jobs/jobs.go#L241))
nulls `messages.content` only when **no active member and no active device** is still
behind the message. An undelivered message is unreachable by it **at any age**.

### What the model actually needs: four env vars, ~0.5 d

| Variable | Set to | Effect |
|---|---|---|
| `DELETE_ON_DELIVERY` | `true` | Arms the delivery-driven sweep |
| `DELETE_ON_DELIVERY_GRACE_SEC` | `10800` | Purge 3 h **after delivery**. Not floored |
| `DELETE_ON_DELIVERY_MAX_AGE_DAYS` | `0` *(default)* | The unconditional age purge stays **OFF** — undelivered messages are kept **indefinitely** |
| `DELETE_ON_DELIVERY_DEVICE_STALE_DAYS` | `90`–`180` | How long to keep waiting for a silent device before ignoring it. Default 30 is too low for your "user absent 30+ days" case |

### Therefore: the body store should be **deleted**, not reconciled

`message_bodies` is **clock-bound by construction** — a hard `body_expires_at` set at
insert, with a schema CHECK forbidding anything beyond 3 h. Your requirement is that an
undelivered message survive indefinitely. Those are incompatible: the body store would
destroy at 3 h exactly the message you most need to keep.

The partitioning/scale argument I previously made for keeping it also collapses. Dropping
partitions by time only reclaims if lifetime is **time-bound**. Under delivery-bound
retention a partition may contain one undelivered message from a dormant user, so it can
never be dropped wholesale. Time-partitioning buys nothing here.

| Option | Verdict |
|---|---|
| ~~1. Reconcile (8.5 d)~~ | **Withdrawn.** Solves a conflict that delivery-driven reclaim dissolves |
| ~~2. Narrow (3 d)~~ | Withdrawn. Disappearing messages are already enforced client-side |
| **3. Delete the body store (~1 d)** | **Recommended.** Drop `message_bodies`, the `MESSAGE_BODIES` flag, `expire-bodies`, `drop-body-partitions`, `sweepDeliveredBodies`, `bodyStoreRefused`, and `900_drop_messages_content` |
| **4. Configure delivery-driven reclaim (~0.5 d)** | **Do this first.** It is the feature you actually wanted |

**Net effect: 8.5 d of redesign becomes ~1.5 d of configuration and deletion.**

### Why "delivered", not "read"

You framed it as *read*. Delivery is the better predicate, and strictly safer:

- **Read may never happen.** A recipient can receive a message and never open the chat.
  Keying on read would pin those on the server forever — the opposite of your goal.
- **Read receipts are user-disableable.** Retention would then depend on a privacy
  setting, so users who disable receipts get worse deletion.
- **Delivered already means "on their device, encrypted."** Which is your actual
  criterion. Read is a UI event that happens *after* the safety condition is met.

Delivery-driven is both more aggressive *and* safer. The code already uses it.

### The one trade-off to accept consciously

Once `content` is nulled, **server-side history is gone for good**. A reinstall or a new
phone starts empty — there is no cloud history restore. That is already this system's
design (`syncChatHistory` is a deliberate no-op; "a fresh device is supposed to start
empty"), and history restore belongs to the **backup** feature (migrations `046`/`047`),
not to server retention. Confirm you are happy with that, because it is the user-visible
consequence of the model.

Your user-facing claim also gets stronger and becomes *true*:
**"We delete your message from our servers within 3 hours of it reaching your device."**

---

## SERVER SIDE

### Phase S0 — Today. Safe, independent, no dependencies (0.6 d)

| # | Task | Detail |
|---|---|---|
| S0.1 | **Revert `MESSAGE_BODIES=1`** from `~/vaultchat/vaultchat-backend/.env` | Functionally a no-op today, but it makes the file assert a state the system is not in — and it silently activates the store the day someone relaxes the CHECK. Restart `go-api` after |
| S0.2 | **Document the orphan hazard** in `DEPLOY_OPERATIONS.md` | `docker compose … --remove-orphans` on this box **deletes `vaultchat-livekit-egress-1`**, which is live and required for broadcast/Go-Live but absent from the two active compose files. This is a footgun with no warning attached |
| S0.3 | Fix the `main.go:196` em-dash | Removes a permanent false positive from every future prod-vs-repo diff |

`.env` backup already exists at `~/.env.backup-20260815-retention`.

### Phase S1 — This week. Cleanup, still no dependencies (1.25 d)

| # | Task | Detail |
|---|---|---|
| S1.1 | **Apply `098_drop_vaultlens`** | Back up first (`scripts/backup-postgres.sh`) — `DROP TABLE` is irreversible and `vaultlens_face` has 1 row. Use the gated pattern from `apply103-104.sh` |
| S1.2 | **Remove the vaultlens worker** | Stop + `docker rm` `vaultchat-vaultlens-worker-1`, delete its compose service and image. Do this **explicitly, by name** — never via `--remove-orphans` (S0.2) |
| S1.3 | Orphan the MinIO objects deliberately | `vaultlens/faces/*` and `vaultlens/<user>/*` are untouched by `098` by design. Separate, separately-reviewed cleanup. Do not put object deletion on the deploy path |
| S1.4 | **LiveKit Go-Live verification pass** | Prod runs v1.13.5, above the ≥1.11 requirement. The old blocker is gone — this is now a *verify*, not a *build* |

### Phase S2 — Turn on delivery-driven reclaim (1 d) — the actual feature

Server-only; the wire format does not change, so **no client release is coupled to this**.
Nothing here is a redesign. Every mechanism already exists and is unit-tested
(`retention_floor_test.go`).

> #### GATE — verified local-first, with ONE hole to close first
>
> The model is only safe if the ack means *"the message is on disk"*, never *"the device
> was told about a message"*. Traced all three ack paths:
>
> | Path | When | Ordering | Verdict |
> |---|---|---|---|
> | `lib/syncBackground.ts` | Push while app killed/backgrounded | Acks **only after** `catchUp()` returns, and reads the acked id **back from the local DB** rather than from the push. Returns `sync-failed` without acking on any error | **Correct** — its header says "ORDERING IS THE WHOLE CONTRACT" |
> | `lib/syncEngine.ts` `catchUp()` | Reconnect catch-up | `await cacheMessages(chatId, hydrated)` completes, **then** `markDeliveredDurable` | **Correct** (write-ahead) |
> | **`app/chat.tsx:688`** | Live socket, chat screen open | **Acks BEFORE persisting** — `markDeliveredDurable` fires at line 688, `applyMessage` persists at line 699, in a separate un-awaited async IIFE | **THE HOLE** |
>
> **C-GATE (0.25 d) — required before S2.3 touches prod.** In `app/chat.tsx`, move
> `markDeliveredDurable(chatId, m.id)` out of the synchronous `onNew` body and into the
> async IIFE, **after** `await applyMessage(chatId, fin)` resolves. Keep `playReceived()`
> where it is — the tone should stay instant; only the ack must wait for disk.
>
> Failure it closes: message arrives → device acks → app is killed in the millisecond
> before `applyMessage` writes → server purges after grace → the message exists nowhere.
> Today the sync cursor has not advanced, so a reconnect **within the grace window**
> re-fetches it; with `GRACE_SEC=10800` that is a 3-hour recovery window. Beyond it, the
> message is gone. The window is narrow, but it is unbounded loss for a one-line fix.
>
> **Three layers already protect this** — the gap above is the only unguarded one:
> 1. **Recipient local DB** is the read path. `app/chat.tsx:539` paints from
>    `getCachedMessages` instantly; decrypt-once-then-cache-plaintext means re-opens never
>    re-decrypt. A failed cache read returns `null`, not `[]`, precisely so "locked DB" is
>    never mistaken for "this device holds nothing".
> 2. **Sender-side recovery copy.** The outbox retains the ciphertext of an accepted
>    message until the recipient's `message_delivered` event, and can **re-upload the
>    body** if delivery never happens (`messageQueue.ts:282` `noteDelivered`, and the
>    re-upload path below it). The sender is a second source of truth.
> 3. **Server copy** until delivered + grace.
>
> **Your exact scenario is already safe:** recipient offline for weeks → no socket, no
> ack → `sweepDeliveredMessages`'s predicate never matches → with `MAX_AGE_DAYS=0` the
> server holds it indefinitely and delivers on their return.

| # | Task | Effort | Notes |
|---|---|---|---|
| S2.0 | **C-GATE: fix the `chat.tsx` ack ordering** (see gate above) and ship it in a client build | 0.25 d | **Hard prerequisite.** Do not enable delivery-driven purging on prod until the build carrying this is out |
| S2.1 | **Bench first.** Set the four vars on the local bench, send messages from two accounts, confirm `content` nulls ~3 h after the second device acks — and stays put while one device is held offline | 0.5 d | The bench exists and its contract suite is green. Do **not** first-run this on prod |
| S2.2 | **Align media retention.** See the mismatch below — this is the one real gap | 0.25 d | |
| S2.3 | Apply the four vars to prod, restart `go-api`, watch `[delete-on-delivery]` purge counts for one cycle | 0.25 d | Reversible: unset and restart. Nothing is destroyed that was not already delivered |

#### The media mismatch — catch this before shipping S2

Text and media are governed by **different clocks**, and under your model they disagree:

| Content | Undelivered lifetime | Source |
|---|---|---|
| Message text | **Indefinite** (`MAX_AGE_DAYS=0`) | `sweepDeliveredMessages` |
| Chat media | **14 days** (`MEDIA_TTL_DAYS`, default 14) | `sweepDeliveredAttachments` |

So your user who returns after 30 days gets **the text but a broken image**. Raise
`MEDIA_TTL_DAYS` to match your intended hold (e.g. `90`), or accept the degradation
deliberately and say so in the UI.

Two things NOT to touch while doing it, both already correct:
- Media retention is **purpose-aware** (`chat` / `story` / `profile` / `group` /
  `mini_app` / `unknown`). Profile avatars and group photos are absent from the delete
  statement entirely, so forgetting a class fails toward *retention*, not loss.
- **Orphan cleanup** (uploads never sent) keeps the long legacy window. Narrowing it
  would trade a data-loss bug for a storage leak.

### Phase S3 — Delete the body store (1 d) — after S2 has soaked a week

Only once delivery-driven reclaim is demonstrably purging on prod.

| # | Task | Detail |
|---|---|---|
| S3.1 | Delete `MESSAGE_BODIES`, `bodyStoreRefused`, `BodyStoreEnabled`, `bodyTTL`, `BodyExpiresAt`, `sweepDeliveredBodies`, `sweepExpiredBodies`, `expire-bodies`, `drop-body-partitions`, partition maintenance | Also collapse `chatsMsgSelBody`'s `COALESCE(b.content, m.content)` to `m.content` |
| S3.2 | New migration dropping `message_bodies` and its partitions | Do **not** edit `099` — migration history is immutable, as `098`'s own header argues. Add a new one |
| S3.3 | **Delete `contract-pending/900_drop_messages_content.sql`** | Its premise is gone. `messages.content` is now the permanent home, emptied by delivery rather than by clock |
| S3.4 | Update `DEPLOY_OPERATIONS.md` and the retention docs to describe the delivery model | The 3-hour claim becomes "3 h after delivery", which is true |

**Keep `MinRetentionDays`.** It still guards the age-based paths that ignore delivery.
It stops a future `MAX_AGE_DAYS=7` from quietly undercutting the promise. Deleting the
body store does not make the floor unnecessary.

### Phase S4 — SFU platform (30 d) + groups-circles 7.1–7.3 (8 d)

`groups-circles` 7.1 ("provision SFU + TURN") is the hard dependency for 7.2/7.3 **and**
for most of `calls-sfu-platform`. Sequence: provision → N-way A/V → the rest. Nothing in
either change starts until the SFU exists.

Capacity + cost model (`calls-sfu-platform` task, currently open) belongs **before**
building, not after. It is listed as such in `tasks.md` — honour that ordering.

---

## CLIENT SIDE

Independent of S2/S3 — the body-store work never changes the wire format, and the client
already assumes the backend purges bodies (`lib/messageQueue.ts:97`, `lib/historySync.ts:26`).

### Phase C0 — Cheap wins, this week (2 d)

| # | Task | Detail |
|---|---|---|
| C0.1 | **Viewer read-path: wire `/locations/latest` into the family board** | 2 d. Highest value on this list. The server side is already deployed and verified live (401, not 404). This **sidesteps the E2EE pair-deadlock entirely** rather than fighting it |
| C0.2 | Caller name "VaultChat user" on active call screens | 0.5 d. `voicecall.tsx:127` + same pattern in `videocall.tsx` — resolve via `getChat(chatId)` when `peerName` is blank. **Display-only; do not disturb the working call path** |
| C0.3 | Delete `lib/historySync.ts` | 0.25 d. It has been a hard no-op in both directions since the ghash fix. The soak it was waiting for has happened |

### Phase C1 — Family location follow-ups (3.5 d)

| # | Task | Detail |
|---|---|---|
| C1.1 | Retype UI for a mistyped space | 1 d. Today a stored identity beats the family default **forever**, with no way back. That is a permanent wrong state reachable by one typo |
| C1.2 | `family-add.tsx` permanent invite link | 0.5 d. Violates membership-v2 doctrine. Move to the membership-v2 invite path |
| C1.3 | **Two-device testing** — invitation flow, geofence arrivals, trip content, speed-alert firing | 2 d, **needs the Redmi**. Cannot be parallelised away |
| C1.4 | Keep `scripts/check-space-identity.ts` in CI | 0.1 d. It is the Family≠Business regression gate |

### Phase C2 — Location Lock release gate (3 d + device time)

| # | Task | Detail |
|---|---|---|
| C2.1 | 6.2 Battery pass — measure drain at 30 m and 500 m locks, tune toward <5%/h | Physical device |
| C2.2 | 6.3 Two-device field test: arm → walk out → grace → alarm (background + screen locked) → navigate back → auto-stop → history | Physical devices. **This is the release gate** for keeping `LOCATION_LOCK` on |

3 further items (13.10, 13.11, 14.6) are explicitly deferred — 14.6 belongs to
`family-circle` F4, do not duplicate it here.

### Phase C3 — VaultBeam seamless resume (15 d)

16 open tasks, mostly stage 6. Note **task 8.2 is a stated merge blocker** and is
**not CI-testable** (NAT traversal) — budget real device/network time for the
transport-switching matrix, and instrument it (8.2a) so the switch is observable
rather than asserted.

`VB_SEAMLESS_RESUME` stays `false` until 8.4; it is the rollback switch for one release.

### Phase C4 — Family Circle (25 d) — not started

23/23 open. Two things make this longer than it looks and both are external:

- **3.1 renderer spike** (MapLibre GL + PMTiles vs `react-native-maps`) gates 3.2/3.3, and
  3.2 requires `expo prebuild` + updated store listings for a new native SDK.
- **7.4 compliance**: Play background-location declaration, `USE_FULL_SCREEN_INTENT`,
  iOS Critical Alerts entitlement. Entitlement requests have **review latency you do not
  control** — file them at the *start* of C4, not when the feature is ready.

Flag stays off until 7.5 two-device verification.

---

## Sequencing

```
NOW ─┬─ S0 (0.6d) ──┬─ S1 (1.25d) ─────────────┐
     │              └─ S1.4 LiveKit verify     │
     │                                          ├─ S4 SFU (30d) ─ groups 7.1-7.3 (8d)
     ├─ §0 DECISION ─── S2 (8.5d) ─ soak ─ S3 (1.5d)
     │
     └─ C0 (2d) ─ C1 (3.5d) ─ C2 (3d) ─ C3 (15d) ─ C4 (25d)
```

Server and client tracks are **genuinely independent** through S3/C2 — one engineer on
each loses nothing to coordination. They converge only at S4/C3, where SFU work needs
both halves.

**Critical path is C4 (25 d) and S4 (30 d)**, not the retention redesign. S2 looks urgent
because it is labelled P0, but it blocks only `900` — which reclaims disk, not
functionality. Do not let it displace the feature work; it is 8.5 d that can run beside
anything.

| Window | Server | Client |
|---|---|---|
| Today | S0 | C0.3 |
| Week 1 | S1, **S2 on the bench** | C0.1, C0.2 |
| Week 2 | S2 to prod + media alignment | C1 (+ Redmi time) |
| Week 3 | S2 soak | C2 device tests |
| Week 4 | S3 delete the body store | C3 VaultBeam starts |
| Weeks 5–10 | S4 SFU provisioning | C3 VaultBeam |
| Weeks 6–16 | groups 7.1–7.3 | C4 Family Circle |

**~91 developer-days** (down from ~98 — the retention redesign collapsed from 8.5 d to
2 d once the model became delivery-bound), ~5 device-bound.

---

## Do NOT do

| # | Never | Why |
|---|---|---|
| 1 | ~~`DELETE_ON_DELIVERY=true`~~ — **this warning was wrong and is withdrawn.** It is the feature you want (§0). The real rule: **never set `DELETE_ON_DELIVERY_MAX_AGE_DAYS`** to a non-zero value — that is the *unconditional* age purge which ignores delivery entirely, and it is the only knob here that can destroy an undelivered message | The delivery predicate protects undelivered messages at any age; the age purge does not consult it |
| 2 | `docker compose … --remove-orphans` on prod | Deletes the live `livekit-egress` container. Remove vaultlens **by name** |
| 3 | Edit `099` to change the CHECK | Migration history is immutable. Add a new migration |
| 4 | Apply `900` in the same deploy as the COALESCE removal | A code rollback would land on a schema that cannot serve it |
| 5 | Lower `MinRetentionDays` to make the body store fit | Inverts the conflict — it would resolve a contradiction by breaking offline delivery, the one promise with data-loss consequences |
| 6 | Trust `printenv` as proof a feature is on | `MESSAGE_BODIES=1` reads back fine on prod right now and does nothing. Check `BodyStoreEnabled()`'s boot log |
| 7 | `echo PASS \| sudo -S tee file` | sudo eats stdin; tee writes 0 bytes. It emptied `chats.go` once already |
| 8 | Compare prod against your working branch | Compare against `hetzner-deploy`, LF-normalised |
