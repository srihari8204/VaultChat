# delete-on-delivery: what is actually running

Measured on production 2026-09-13/14 against `65.21.229.167`, read-only. Nothing
was changed, restarted or deployed to produce this document.

---

## Verdict

**The server keeps every message's ciphertext forever, and the privacy policy
says it does not.** The delete-on-delivery job exists, is finished, is tested,
and is simply not switched on — `DELETE_ON_DELIVERY` has never been set on this
box, or in any compose file, or in any commit in this repository's history. It
is off by omission rather than by decision: every document that discussed it
left it for "later", and later has not happened. Separately, a *second*
retention feature (the ephemeral `message_bodies` store) **is** requested on the
box and is being **refused at boot**, because its own schema caps a body at 3
hours while the code's retention floor requires 30 days — those two numbers
genuinely cannot both hold, and that part of the design is internally
contradictory. The two facts are easy to confuse and are not the same problem:
the body store is a storage relocation that is correctly blocked; the
delete-on-delivery sweep is the thing the policy promises, is unblocked, and
nobody turned the key. Today production holds 8 messages, 7 of them with live
ciphertext, so **this is the cheapest moment this decision will ever be made** —
flipping the flag now costs 7 rows, flipping it after launch means the first
sweep meets a year of backlog.

---

## 1. What delete-on-delivery was meant to do

Three separate mechanisms, often spoken of as one. They are worth keeping apart,
because only one of them is what the privacy policy describes.

### a. The delivery sweep — `sweepDeliveredMessages`

`vaultchat-backend-go/internal/jobs/jobs.go:402`, registered at
`jobs.go:175` behind `DELETE_ON_DELIVERY == "true"`.

Every 5 minutes it runs one `UPDATE messages` that sets `content = NULL` and
strips `meta` down to the server-readable allow-list, for every message where
**all four** of these hold:

1. `created_at < NOW() - DELETE_ON_DELIVERY_GRACE_SEC` (default **3 hours**);
2. the chat has at least one member other than the sender (never reclaim a
   note-to-self);
3. no active member's `chat_members.last_delivered_message_id` is behind it;
4. no *active device* of any member is behind it — `chat_device_delivery`
   (migration 078) joined to `user_sync_devices.last_sync_at` inside
   `DELETE_ON_DELIVERY_DEVICE_STALE_DAYS` (default 30).

Clause 4 is the whole reason migration 078 exists. Its header says it plainly:

> With more than one device on an account that is data loss, not an
> optimisation: phone A acks the message, the pointer advances, the sweep nulls
> the body, and tablet B — which never received it — has nothing left to fetch.

And the other half of the same problem — a sold or wiped handset pinning an
account's history on the server forever — is why staleness bounds the wait
rather than requiring every device that ever existed to ack.

The `meta` strip (commit `1660ab9`) matters as much as the `content` null.
`meta` is plaintext JSONB and carries a base64 JPEG thumbnail of every photo and
video, filenames, MIME types, poll option text and mention display names.
Reclaiming the ciphertext and leaving a legible picture of it is not retention.
The allow-list is `jobs.MetaPublicKeys` (`internal/jobs/meta_public.go`), one
definition shared by the writer and the reclaimer, with `optionCount` and
`mentionUserIds` derived so polls and mention-push keep working after the body
is gone.

There is also an **unconditional age purge** in the same function
(`DELETE_ON_DELIVERY_MAX_AGE_DAYS`, default `0` = off). It consults delivery not
at all, so it is the one knob here that can destroy an undelivered message. It
is clamped up to `MinRetentionDaysEffective()` and should stay at 0.

### b. The retention floor — `MinRetentionDays`

`jobs.go:68`. Thirty days, raisable via `RETENTION_MIN_DAYS`, never lowerable.

It is a floor on the paths that **ignore** delivery, not on the delivery path.
The source is explicit about the distinction, and about an earlier revision that
got it wrong:

> An earlier revision clamped this to 30 days as well. That was wrong: it made
> post-delivery reclaim impossible, which contradicts the contract — a body that
> every device has already received MAY be reclaimed after a short grace (three
> hours, say).

So: a message nobody has received is protected at **any** age, by the predicate,
not the clock. A message everyone has received is reclaimable after the grace.
This is coherent, and it is exactly what the policy describes.

### c. The ephemeral body store — `message_bodies` (migration 099)

A *storage relocation*, not a retention policy. Migration 099's header explains
why it is a second table rather than partitioning `messages`: the spine carries
six inbound foreign keys and a partial unique index (`ux_messages_client_dedup`,
the send-idempotency guarantee) that partitioning would delete outright. So the
ciphertext moves out to a table with **no** inbound FKs, partitioned hourly, so
expiry becomes `DROP PARTITION` — a catalog operation that removes the bytes,
rather than `UPDATE … SET content = NULL`, which leaves the old heap tuple
holding ciphertext until autovacuum arrives.

Gated on `MESSAGE_BODIES=1`, writer-only — reads always `COALESCE(b.content,
m.content)` (`internal/routes/chats.go:721`) so that turning the writer back off
does not orphan bodies already written. That asymmetry is good rollback design.

`sweepDeliveredBodies` (`jobs.go:475`) is the same delivery predicate applied to
this table, under the same flag. `sweepExpiredBodies` (`jobs.go:568`) and
`DropExpiredPartitions` run **unconditionally**, because they enforce the
ceiling rather than the optimisation.

---

## 2. Why it is off

### The flag was never set. Anywhere. Ever.

| Where | Evidence |
|---|---|
| Production container | `DELETE_ON_DELIVERY` absent from `vaultchat-go-api-1` env entirely |
| Live compose | `/home/srihari/vaultchat-clean/docker-compose.box.yml` — no mention |
| Live `.env` | no mention |
| Repo (deployed stack) | `deploy/env.example:240` — `DELETE_ON_DELIVERY=   # optional. \`true\` enables the delete-on-delivery sweep. Empty = off.` |
| Repo (legacy Node stack) | `vaultchat-backend/.env.example:99` — `DELETE_ON_DELIVERY=false`, explicitly set, above an authored three-step rollout recipe |
| Git history | `git log --all -S'DELETE_ON_DELIVERY=true'` and `-S'DELETE_ON_DELIVERY: "true"'` return **no commit that ever set it** in a config file |
| Boot log | `[jobs]` registers 12 jobs; there is no `[delete-on-delivery] ENABLED` line |

`deploy/env.example` was written at commit `6b9bcb1` (2026-09-13, *"make the
repository able to rebuild this deployment"*) — it documents the box as it is,
so its `Empty = off` is a record of the state, not a decision to be in it.

**Deliberate or accidental?** Neither, cleanly — it is *deferred*, and the
deferral has outlived its reason. The repository contains four documents that
discuss turning it on and disagree with each other:

- `SECURITY_PERSISTENCE_REMEDIATION_PLAN.md:19` — "Scaffolded but OFF … you flip
  it when ready".
- `2026-08-15_audit.md:103` — "**UNSET** — and must stay unset … Floored at 30
  days anyway".
- `2026-08-15_implementation_plan.md:309` — "**this warning was wrong and is
  withdrawn.** It is the feature you want."
- `docs/ENV_INVENTORY.md:224` — "Intentional today; **re-verify against the
  intended retention policy after rebuild**, because 'off' looks identical to
  'configured'."

The audit's stated reason is **stale**. It claimed the sweep was floored at 30
days and therefore pointless; commit `46de8e0` (2026-08-14) removed that clamp
from the post-delivery grace, and `retention_floor_test.go:74`
(`TestPostDeliveryGraceIsNotClampedToTheFloor`) now pins the behaviour. The
implementation plan withdrew the warning. Nothing re-verified the box afterwards
— which is precisely the failure `ENV_INVENTORY.md` predicted in writing, and
`docs/SECOND_REPLICA_READINESS.md:324` had already recorded the absence.

### The `MESSAGE_BODIES` refusal is a *different* problem — and it is real

`MESSAGE_BODIES=1` **is** set, hardcoded at
`/home/srihari/vaultchat-clean/docker-compose.box.yml:24`. It is refused at
boot, once per process (`partitions.go:87`, `BodyStoreEnabled` at
`partitions.go:107`):

```
2026/09/13 18:56:38 [retention] MESSAGE_BODIES=1 REFUSED: the body store caps
retention at 3h0m0s (schema CHECK message_bodies_ttl_cap), but normal messages
must be retained for at least 30 days.
```

**The conflict is genuine, and the two requirements cannot both be satisfied as
written.** Migration 099 carries

```sql
CHECK (body_expires_at <= created_at + INTERVAL '3 hours')
```

and `body_expires_at` is computed from `created_at` (`jobs.BodyExpiresAt`). So
every body written under this flag dies three hours after the message was
*created*, regardless of whether anyone received it — which is the one outcome
`MinRetentionDays` exists to forbid. A recipient offline for an afternoon would
lose a message the server was supposed to be holding.

The code refuses rather than obeys, and degrades rather than fails, which is the
right call: with the store off, bodies stay on `messages.content`, which
over-satisfies the floor. Refusing to boot would turn an operator's typo into an
outage.

The contradiction is fixable but is a redesign, not a knob. `bodyStoreRefused()`
already names the three pieces: relax the CHECK to the floor, add a per-message
TTL so explicitly-ephemeral messages keep their short life, and size the
partition window for the floor (720 hourly partitions at 30 days, against the 48
the maintenance job keeps — or switch to daily partitions and keep 30). **None
of that is needed for the privacy claim**, because the claim is delivery-based
and the spine sweep already implements it. The body store is a bytes-actually-
gone improvement on top.

One live side effect worth knowing: `MESSAGE_BODIES` also gates the media
retention window (`jobs.go:713`). Because it is refused, chat attachment bytes
run on the legacy `MEDIA_TTL_DAYS` (14 days) rather than the 3-hour ceiling.

---

## 3. What would happen if it were switched on right now

Traced against the live database, 2026-09-14.

**The current state of production:**

| | |
|---|---|
| messages | **8** (oldest `2026-09-13`) |
| with live ciphertext | **7** |
| `message_bodies` rows | **0**, across **53** empty hourly partitions |
| `chat_device_delivery` rows | 1 |
| `user_sync_devices` (fresh, <30d) | 1 |
| users | 2 |
| `user_backups` rows | **0** |

**Dry-running the sweep's exact predicate right now: 0 rows.** Not because
anything blocks it — because of the grace period. Per-message decomposition:

| id | has content | other member | account behind | device behind |
|---|---|---|---|---|
| 1–7 | yes (6 of 7) | yes | **no** | **no** |
| 8 | yes | yes | **yes** | no |

Messages 1–7 are fully delivered and are simply younger than 3 hours. So the
honest answer is: **set the flag and within roughly two hours, 6 message bodies
are nulled and their thumbnails stripped.** Message 8 is protected until its
recipient acks. That is the entire blast radius today.

**Would the 30-day floor block it? No.** The floor lives on the age purge
(`DELETE_ON_DELIVERY_MAX_AGE_DAYS`, which stays 0) and on device staleness. The
post-delivery grace is deliberately not clamped. This is tested:
`TestPostDeliveryGraceIsNotClampedToTheFloor`,
`TestAgePurgeCannotUndercutTheFloor`,
`TestDeviceStalenessCannotUndercutTheFloor`.

**Would anything be lost that should not be?** Four things to name honestly:

1. **The server stops being a recovery path.** A user who reinstalls with no
   local cache and no backup gets an empty history for anything already
   reclaimed. This is the stated design — the policy says "your device keeps the
   message locally; that copy is the real one" — but note `user_backups` is
   currently **0 rows**, so the backup safety net has never actually run in
   production. It should be verified working before there is real history to
   lose. It is not a blocker today (there are 7 messages).

2. **Multi-device protection is currently inert, and fails safe.** There is one
   `user_sync_devices` row on the entire service. The device clause only blocks
   when a *fresh* device row exists with no matching ack — with no device rows,
   the account pointer is doing all the work. The `X-Device-Id` header write
   (`chats_helpers.go:1249`) is best-effort by design so older clients degrade to
   the account pointer. For single-device accounts this is exactly equivalent;
   when linked devices ship, coverage must exist before the flag is trusted
   (`docs/LINKED_DEVICES_PLAN.md:175`).

3. **Exports and history reads are already built for this, and a later null
   cannot erase a cached body.** `lib/messageHistory.ts` exists solely to name
   this rule ("read local first, treat the network as a TOP-UP, never a
   replacement") and lists the four screens that shipped the bug before it —
   media gallery, chat export, notes/tasks. `app/chat-export.tsx:45` unions the
   server pages with the device cache. Critically, `lib/localDb.ts:350` upserts
   with `content = COALESCE(excluded.content, messages.content)`, so a message
   arriving from the server with `content = NULL` after a sweep **never**
   overwrites the copy the device already holds. The client side of this feature
   is done.

4. **Attachments are not affected, and already behave better than the text.**
   `media-retention` runs **unconditionally**, is purpose-scoped, and already
   reclaims chat attachment bytes on delivery-to-everyone, else at 14 days. With
   the body store off, that 14-day window stays — so a recipient who acked (and
   therefore already holds the per-file key inside the message content) can still
   tap-to-download for 14 days. Turning `MESSAGE_BODIES` on would snap that to 3
   hours; leaving it off is the friendlier combination.

The sweep itself is batched (5000 rows × 10 iterations per tick), idempotent,
and covered by a Postgres-backed test (`TestDeliveredSweepAgainstPostgres`) plus
`TestDeliveredSweepKeepsItsThreeSafetyClauses`, which fails if any of the four
safety clauses is deleted. Enabling requires an env change and a container
restart — not done here, per the read-only constraint.

---

## 4. The privacy claim, honestly

`caddy/public/privacy.html`, section 4, promises:

> Message retention is tied to *delivery*, not to a clock:
> - Once every device in a conversation has received a message, our copy of its
>   ciphertext is erased after a short grace period. Your device keeps the
>   message locally; that copy is the real one.
> - An **undelivered** message is kept until it can be delivered. …
> - Encrypted attachments follow the same delivery-based rule.

and the data table (line 96) says of message ciphertext and encrypted
attachments:

> Unreadable to us; deleted on the schedule in section 4

Against the running server:

| Promise | Reality |
|---|---|
| "Once every device has received a message, our copy of its ciphertext is erased after a short grace period" | **False.** The job that does this is not registered. `messages.content` is retained indefinitely. 7 of 8 messages in production carry live ciphertext, 6 of them fully delivered and past nothing. |
| "An undelivered message is kept until it can be delivered" | **True**, trivially — everything is kept. |
| "Encrypted attachments follow the same delivery-based rule" | **True.** `media-retention` runs unconditionally with a delivery predicate, plus a 14-day backstop. |
| "Unreadable to us" | **True** for `content`. **Overstated for the thumbnail**: `meta` is plaintext JSONB and carries a base64 JPEG preview of photos and videos, filenames, MIME types and poll text. The strip that removes it is inside the sweep that is not running. |

So the policy overstates reality on the single point the product is *about*.
Not by a shade of emphasis — the mechanism named in the sentence does not
execute. And the accompanying claim that the server holds nothing readable is
weaker than stated, because a legible preview of every image sits beside the
ciphertext it describes.

The uncomfortable framing, said once: the policy describes code that was
written, reviewed, tested and then never switched on, and no one noticed because
— as `docs/ENV_INVENTORY.md` wrote down in advance — *off looks identical to
configured*.

---

## 5. The smallest correct fix

**Set `DELETE_ON_DELIVERY=true`. Leave `DELETE_ON_DELIVERY_MAX_AGE_DAYS` unset.
Change nothing else.**

One line in `docker-compose.box.yml` (and `deploy/env.example`), one container
restart.

This is not a new plan — it is step 2 of a rollout already written down in
`vaultchat-backend/.env.example:90`, which also corrects an earlier, backwards
version of the same advice:

> ⚠️ THE PREVIOUS ROLLOUT ADVICE HERE WAS BACKWARDS AND HAS BEEN REMOVED. It
> said to "set a long MAX_AGE_DAYS first, then enable delete-on-delivery". That
> is the most dangerous possible order. […] Correct rollout: 1. confirm client
> backups are working […] 2. DELETE_ON_DELIVERY=true, leave MAX_AGE_DAYS at 0
> 3. watch the "[delete-on-delivery] purged N" log line and the DB size

Step 1 of that recipe is the `user_backups` check below — currently 0 rows.
Step 3 is free: the sweep logs `[delete-on-delivery] purged N delivered message
bodies` on every tick that reclaims anything.

Why this and not the alternatives:

- **Not "fix the retention conflict first."** The body store's 3h/30d
  contradiction is real, but it blocks a *storage relocation*, not the privacy
  promise. The spine sweep implements the promise today, on the table the data
  is actually in. Fixing the CHECK, adding per-message TTLs and resizing the
  partition window is days of work to make an already-satisfied guarantee
  cheaper to enforce. That is the right project and the wrong week.
- **Not "change the policy text."** It is the smaller diff, but it ships the
  weaker posture for a product whose central claim this is, and it discards
  finished, tested code to do it. Rewrite the policy only if the decision below
  goes the other way.
- **Not "the feature is not for this release."** The feature is done. The client
  already unions local history for exports, gallery and contact info. The only
  thing missing is the environment variable.

**And the timing argument is the strongest one.** Production holds 8 messages.
Flipping now costs 6 rows and turns a false sentence true before anyone reads
it. Flipping after launch means the first tick meets the whole backlog at once —
and if any client-side history path is wrong, that discovery arrives as mass
data loss rather than as six test messages.

Two small follow-ups, neither blocking:

- **Set `MESSAGE_BODIES=0`** on the box (or delete the line). It is refused
  anyway, so this changes no behaviour — it just stops the deployment claiming a
  feature that does not run, and stops the refusal log line reading like an
  error. Keeping it at `1` also means that whoever eventually relaxes the CHECK
  will silently snap media retention from 14 days to 3 hours at the same moment.
- **Verify the `.vcbak` backup path end to end** before real history exists.
  `user_backups` is empty. Once the server stops being a recovery path, that
  backup *is* the recovery path.

Pre-existing and out of scope here: the `meta` thumbnail sits in plaintext on
the spine for as long as a message is undelivered. The sweep strips it on
reclaim; nothing strips it before. Moving it into `meta_private` at write time
is part of the body-store work above.

---

### Provenance

Source: `vaultchat-backend-go/internal/jobs/{jobs.go,partitions.go,meta_public.go}`,
`vaultchat-backend-go/internal/routes/{chats.go,chats_bodies.go,chats_helpers.go}`,
`vaultchat-backend/migrations/{078_device_delivery.sql,099_message_bodies.sql}`,
`caddy/public/privacy.html`, `app/chat-export.tsx`, `lib/messageHistory.ts`,
`lib/localDb.ts`, `deploy/env.example`, `vaultchat-backend/.env.example`.
Live system: `vaultchat-go-api-1` container env and logs (boot
`2026-09-13T18:56:38Z`, 0 restarts), `vaultchat-postgres-1` read-only queries,
`/home/srihari/vaultchat-clean/docker-compose.box.yml`. No writes, no restarts,
no config changes.
