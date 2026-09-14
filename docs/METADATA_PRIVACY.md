# §15 Metadata privacy — what the server sees, and what it keeps

**Status:** audit complete. Two safe additive fixes landed (below). Three findings
require a wire-breaking change and are **written up, not made** — this app is live
and a deployed client that still sends a field cannot be met with a server that
rejects it.

**What this audit could and could not verify.** Everything below is read from
SOURCE in this repository: schema migrations, Go route and job code, and the
client split. Nothing here was measured against a running server or a production
database. Where a claim depends on what a deployed instance actually holds, it is
labelled **SOURCE-ONLY** and says so in those words. The one production
measurement quoted ("22 of 24 image/video messages had a server-readable
preview") is not this audit's — it is quoted from
`lib/msgEnvelope.ts:8-9` and `internal/jobs/meta_public.go:18-19`, which
describe a leak that has since been closed.

---

## The governing rule

`lib/msgEnvelope.ts:67` `META_PUBLIC_KEYS` is an **allow-list**: message metadata
is private by default, and a key becomes server-visible only when server code
provably reads it. `internal/jobs/meta_public.go:30-47` carries the per-key
justification. `proto/ccwire/v1/envelope.proto:181` restates the same list as
`PublicMeta` and adds the negative half — five fields deliberately absent from
`Envelope`, each with a reason.

That rule is honoured for **`messages.meta`**. It is not, and was never,
applied to the **columns of the `messages` row itself**. That gap is the whole
of this audit's serious findings.

---

## Findings, ranked by severity

Categories, as asked:
**(a)** the server necessarily sees it to route ·
**(b)** the server sees it unnecessarily (a leak) ·
**(c)** the server *stores* it beyond need (a retention problem).

### 1. `messages.reply_to_id` — (c), and (b) on the way in. **Most serious.**

`vaultchat-backend/migrations/002_chats.sql:64`
```
reply_to_id   BIGINT REFERENCES messages(id) ON DELETE SET NULL,
```
Written from the client body at `internal/routes/chats_helpers.go:760,771`;
selected into every message read at `internal/routes/chats.go:217`
(`chatsMsgCols`); also on the scheduled-message path
(`internal/jobs/jobs.go:957`, `internal/routes/user.go:2313`).

- **Justified by an allow-list entry?** No. It is not `meta`, so the allow-list
  never sees it. `envelope.proto:153-154` names `reply_to` explicitly as
  *deliberately absent* — "a conversation graph the server has no need to build.
  It lives inside the ciphertext." The live schema builds exactly that graph.
- **Read by server code for any purpose?** No. Grepped every occurrence
  (`internal/routes/chats_helpers.go`, `chats.go`, `user.go`, `admin.go`,
  `internal/jobs/jobs.go`): it is written, selected, echoed to clients, and
  exposed to the admin listing. No routing, authorisation, push or validation
  decision reads it. This is what makes it **(b)** and not (a).
- **Retained beyond delivery?** **Yes, permanently.** The delete-on-delivery
  sweep (`internal/jobs/jobs.go:351-358`) nulls `content` and rewrites `meta`.
  It does not touch `reply_to_id`. So after the ciphertext has been reclaimed
  and the thumbnail stripped, what remains on the spine is a complete,
  queryable **reply graph**: which message answered which, across every chat,
  forever. That is the conversation structure the E2EE is supposed to hide, and
  it survives precisely the sweep that is supposed to be the backstop.
- **SOURCE-ONLY:** the retention claim is read from the sweep's SQL and the
  schema. This audit did not query a production database to count how many rows
  currently carry a non-null `reply_to_id`.

**Fix requires a breaking change — NOT MADE.** `reply_to_id` is a real FK that
deployed clients populate and read back to render a quoted reply. Dropping the
column, refusing to persist it, or nulling it in the sweep would break reply
rendering on every shipped client. The correct fix is the one the .proto already
specifies — carry the reply target inside the `\0vc1:` envelope's private half
(`priv.replyTo`) and let the column decay — and it needs a client release first,
then a grace period, then a server-side stop-write, then a backfill-null. That is
a migration plan, not a patch.

### 2. `messages.type` — (a) at send, (c) afterwards.

`vaultchat-backend/migrations/002_chats.sql:62`, extended by
`018_sticker_type.sql`, `022_polls.sql`, `058_vaultbeam_message_type.sql`,
`075_group_ref_message.sql`, `124_game_invite_message.sql` to
`text | image | video | audio | file | location | system | sticker | poll |
reaction | vaultbeam | group_ref | game_invite`.

- **Justified?** Partly, and only at write time. `chats_helpers.go:583-687`
  branches on it to validate the send (media requires `meta.attachmentId`,
  `group_ref` is validated, `game_invite` is validated, `poll` bounds-checks
  options). `chats_helpers.go:1396` uses `m.type <> 'reaction'` for unread
  counts and `chats_helpers.go:1278` rewrites type to `'system'` on
  delete-for-everyone. So the server genuinely needs *a* class at send time.
- **The problem is granularity plus retention.** `envelope.proto:159-163` is
  explicit that the server-visible class "MUST NOT be fine-grained enough to
  reconstruct behaviour: there is no distinction between a photo and a video, or
  between a poll and a text", and adds "Retention: not persisted beyond
  delivery." The live column is the exact opposite on both counts: it
  distinguishes photo from video from voice note from document from location,
  and it is never reclaimed. After delete-on-delivery has run, the server still
  holds, per message, forever: *who* sent *what kind of thing* to *which chat*
  at *what time*. That is a behavioural profile without any content.
- **SOURCE-ONLY** for the retention claim, same basis as finding 1.

**Fix requires a breaking change — NOT MADE.** The column is in a `CHECK`
constraint, in client render paths, and in six migrations' worth of history.
Coarsening it (collapse media kinds to one class after delivery) is possible as a
*sweep-side* rewrite in principle, but it would change what existing clients read
back for historical messages — a photo would re-render as a generic attachment —
and the sweep is the one job that must never be the thing that broke history.
Route: add the coarse class to CC-Wire's `MessageClass` (already designed for it),
move clients to it, then stop writing the fine-grained column.

### 3. `GET /api/admin/messages` — (b), bounded but real.

`internal/routes/admin.go:209-212`
```go
`SELECT id, chat_id, sender_id, type, reply_to_id, edited_at, deleted_at, created_at
 FROM messages ORDER BY id DESC LIMIT $1`
```
- The header comment calls it "METADATA ONLY (no content)", and that is
  accurate: it selects neither `content` nor `meta`. Credit where due — this is
  the one place that could trivially have selected the thumbnail and does not.
- But it is the finding-1 and finding-2 data **assembled into an operator-facing
  feed**: a live tail of who is messaging whom, in what chat, with what kind of
  message, replying to what, right now. The product claim is that the operator
  *cannot* see user activity. This endpoint is the operator seeing user activity.
  It is not a bug in the endpoint — it is findings 1 and 2 becoming visible.
- **SOURCE-ONLY:** admin auth is out of this audit's scope; I did not verify who
  holds the admin key in production or whether this route is reachable there.

**Not changed.** Removing or narrowing an admin route is a behaviour change to a
live operator surface, and the underlying leak is the retained columns, not the
SELECT. Fix findings 1 and 2 and this endpoint becomes uninteresting by itself.

### 4. `message_reactions.emoji` — (b)/(c). Plaintext content, retained.

`vaultchat-backend/migrations/008_reactions.sql:13-19` — one row per
`(message_id, user_id, emoji)`, with `emoji TEXT NOT NULL` in the clear and a
`created_at`. RLS restricts *other users*; it does not restrict the operator.

The emoji **is** the message. A 👍 on a message is a communication, stored
plaintext, attributed, timestamped, and never reclaimed by any sweep. It is
excluded from delete-on-delivery entirely (that job only touches `messages`).
**Not fixable additively** — reactions are fanned out server-side and rendered
from this table by every deployed client.

### 5. `poll_votes` — (c). Attributed votes, retained.

`vaultchat-backend/migrations/022_polls.sql:48-53` — `(message_id, user_id,
option_index, voted_at)`. The allow-list is scrupulous about option *text*
(`optionCount` is derived so the server never holds the choices —
`meta_public.go:106-108`), and then the votes table stores, permanently and
attributably, *which index each user picked*. With two people and a two-option
poll, "who voted for option 0" is the entire content. The privacy win on
`optionCount` is largely undone one table over. **Not fixable additively.**

### 6. `story_views` — (c). A viewer log.

`vaultchat-backend/migrations/020_stories.sql:41-47` — `(story_id, viewer_id,
viewed_at)`, plus an index on `viewer_id` that makes "everything this person
viewed" a cheap query. `sweepExpiredStories` (`internal/jobs/jobs.go:803-806`)
deletes stories; the views cascade with them, so this one **is** bounded by story
expiry. Lower severity for that reason. It is a product feature (the author sees
who viewed) that necessarily makes the server see it too — genuine (a)-with-(c),
not a mistake.

### 7. `users.online` / `users.last_seen_at` — (a) with bounded retention.

Written at `internal/realtime/presence.go:92,102`. Single overwritten values, not
a log — the server knows *last* seen, not a session history. `ghost_mode`
(`migrations/015_ghost_mode.sql`, `presence.go:15-20`) governs what *peers* see,
not what the server stores. Surfaced to the operator at `admin.go:163`.
Acceptable as-is: it is the minimum state a last-seen feature can have.

### 8. Logs that name a user and a chat — (b), small, and worth knowing about.

- `internal/realtime/handlers.go:194` — `[join_chat] refused uid=%s chat=%s`
- `internal/realtime/handlers.go:562` — `[relay] refused uid=%s → %s`
- `internal/routes/chats.go:580-584` — `cold sync ... user=%s device=%s`

These are security/diagnostic logs on *refusal* paths, not per-message logging,
so the volume is low and the trigger is anomalous. They still put a
`(user, chat)` pair into stdout, whose retention is the log aggregator's policy
and not this codebase's. **SOURCE-ONLY:** I cannot tell from the repo how long
deployed logs are kept or who reads them. Flagged, not fixed — deleting a
refusal log to improve a privacy metric would be trading a real security signal
for a cosmetic one.

Separately, `internal/routes/auth.go:555` logs an OTP alongside the phone number
when Twilio is unconfigured. It is guarded to that case and announces itself
("visible only here"), but it is an authentication secret reaching the log
stream. Out of §15's scope; noted so it is not lost.

---

## What is already right (and should not be "improved")

These were checked and are correct. Listing them so a later pass does not
re-litigate them:

| Surface | Verdict |
|---|---|
| `messages.meta` | **(a), correctly minimised.** The split is now unconditional (`chats_helpers.go:747-755`, `chats_bodies.go` `chatsSpineMeta`) — it used to sit inside a `bodiesEnabled()` branch that is refused at boot, which was the original leak. All three writers of `meta` (live send, scheduled deliverer `jobs.go:969`, delete-on-delivery sweep `jobs.go:351`) go through `jobs.SplitMeta`. |
| `optionCount`, `mentionUserIds` | **Derived, not copied.** The server keeps a count and bare ids, never the option text or display names (`meta_public.go:106-121`, mirrored in SQL at `jobs.go:359-370`). This is the right shape for every future field. |
| Push notifications | **Clean.** Native FCM is data-only — `{type, chatId, channelId, messageId}` (`chats_helpers.go:990-992`); legacy Expo gets a fixed "New message" body (`chats_helpers.go:1006-1009`). No content, no sender name transits Google or Expo. |
| `chat_members.last_read_message_id` / `last_delivered_message_id`, `chat_device_delivery` | **(a).** High-water-mark pointers, not per-message receipt logs. They are also what protects an undelivered message from the sweep (`jobs.go:306-330`), so they are load-bearing for privacy, not against it. |
| `messages.client_id` | **(a).** Idempotency key, scoped to `(chat_id, sender_id)`. Matches `Envelope.client_msg_id`. |
| Typing / presence fan-out | **Ephemeral.** Socket relay only (`handlers.go:324-334`); the authenticated uid is stamped server-side and the client-supplied one is ignored. Nothing persisted. |
| `security_events` | **Zero-knowledge by construction** (`migrations/036_security_events.sql`): client AES-256-GCM blob plus opaque chain hashes. |
| `POST /app/usage` | **The model to copy** (`internal/routes/usage.go:9-26`): authenticated so it measures something, identity used only to rate-limit and never written, row is `(screen, day, views)`. Answers "does anybody open the Shelf", cannot answer "does *this person*". |
| `content_type` / MIME | **Correctly private** in `meta` — but see finding 2: `messages.type` recreates a coarser version of the same signal in a column. |

---

## What was fixed (additive only — no behaviour changed)

Both are assertions. Neither reads runtime state, changes a query, or touches a
code path a request can reach.

`envelope.proto:177-180` asks, in its own words, for the cross-language
assertion to "be extended to read this .proto as a third source of truth —
otherwise CC-Wire becomes the drift path the selftest exists to prevent."

**Concurrent work already did part of this.** `scripts/acceptance.selftest.ts`
§A4, written by another agent while this audit was in progress, pins
`META_PUBLIC_KEYS` against the .proto and against `lib/ccwire/codec.ts`'s
`PublicMeta` *interface*, including field-number contiguity. That is not
repeated below — overlap is a second place to update, not coverage.

The allow-list now has **four** definitions; the loop is closed by three
assertions in three different files:

| Leg | Asserted by |
|---|---|
| `META_PUBLIC_KEYS` = `jobs.MetaPublicKeys` | `lib/msgEnvelope.selftest.ts` (pre-existing) |
| `jobs.MetaPublicKeys` = `envelope.proto` | `internal/jobs/meta_public_proto_test.go` (**new**) |
| `envelope.proto` = `codec.ts` interface | `scripts/acceptance.selftest.ts` §A4 (concurrent) |

### `vaultchat-backend-go/internal/jobs/meta_public_proto_test.go` (new)

The Go↔.proto leg — the one neither TypeScript suite can reach. `go test ./...`
does not run tsx, and a Go developer editing `MetaPublicKeys` is exactly the
person who will not notice a TypeScript suite. Also pins `MessageClass` to
exactly its five values, so the coarse class CC-Wire was designed around cannot
quietly grow the per-media granularity that finding 2 is about.

### `lib/metadataPrivacy.selftest.ts` (new)

Only what nothing else asserts:

- **The codec's PublicMeta *implementation*, not just its type.** Acceptance §A4
  compares the TypeScript interface; a field can be declared there and missing
  from `readPublicMeta`/`writePublicMeta`, in which case it passes every
  allow-list check and still vanishes on the wire.
- **The negative half of the Envelope contract** — that neither the .proto nor
  codec.ts declares `sender_uid`, `client_ts`, `content_length`, `reply_to` or
  `content_type`. Nothing asserted this. It matters most for `reply_to`, which
  finding 1 shows the live schema *does* persist: the .proto is currently the
  only place that records the intent.
- **That both splits are still allow-lists, not deny-lists** — a rewrite to a
  deny-list fails open, and the resulting leak looks like working code.
- **That the delete-on-delivery sweep still filters `meta` by the allow-list
  parameter** and still re-derives `optionCount` and `mentionUserIds`. This is
  the one of the three `meta` writers that runs against rows written *before* the
  split existed.
- **The measured leak by name** — `thumb`, `filename`, `mime`, `waveform`,
  `options`, `mentions`, `linkPreview` cannot re-enter through any of the four
  doors.

Those five absent fields are named **only in a comment**. A substring search on
the raw file matches the sentence forbidding the field and passes on a file that
has since declared it — the trap `stripLineComments` in
`internal/realtime/payload_bounds_test.go` exists to avoid. Every source is
comment-stripped before it is searched, in both new files, and the raw text is
then checked *separately* to confirm the reasoning itself has not been deleted.

Both were negative-controlled on a scratch copy: injecting `reply_to` into
`Envelope` and `filename` into `PublicMeta` fails them as intended.

Auto-discovered by `node scripts/test-all.js`. (Note: `scripts/` is **not** in
that runner's `SEARCH_DIRS`, so `scripts/acceptance.selftest.ts` is not picked up
by it today — which is why the Go↔.proto leg living in `go test ./...` matters
rather than being belt-and-braces.)

### What was *not* fixed, on purpose

- **No allow-list tightening.** Every one of the 14 keys was re-checked against
  the server code that reads it (`meta_public.go:32-43` and the call sites);
  none is stale. There is nothing to remove. `game`/`room` deserve a second look
  someday — they are server-visible because the server validates them and builds
  a URL from them, which is a design choice rather than a necessity — but
  removing them would break game invites, which is a behaviour change.
- **No change to `reply_to_id`, `messages.type`, reactions, or poll votes.**
  Each needs a client release first. Written up above; that is the correct
  outcome, not a deferral.

---

## The one-line summary

The *content* boundary is in good shape: the thumbnail leak is closed, the split
is unconditional, all three writers apply it, and push carries nothing readable.
The *structural* boundary is not: `reply_to_id` and `type` sit outside the
allow-list entirely, survive the sweep that reclaims everything else, and
together let the operator reconstruct who replied to whom with what kind of
message, forever — which is the claim §15 is about. Both need a wire change, and
both are now at least guarded against getting worse.

---

# Fixes applied — retention (a later pass)

This section supersedes the "Fix requires a breaking change — NOT MADE" verdict
on **finding 1**, and corrects **finding 4**. Findings 2, 3, 5, 6, 7 and 8 stand
as written above.

## Finding 1 — `messages.reply_to_id`: FIXED, additively.

The earlier verdict was too strong. It is correct that `reply_to_id` cannot be
dropped, refused at write, or stopped being echoed back — deployed clients
populate it and render a quoted reply from it, and all three of those are wire
changes needing a client release. But none of that is what was asked. The
question is narrower: **is there a moment at which the server can reclaim it
without removing anything a client can still display?**

There is, and the sweep was already standing on it.

`internal/jobs/jobs.go` `deliveredMessagesSQL` nulls `content`. Once the
ciphertext is gone, the reply *pointer* is a pointer to nothing: there is no
quoted body to render and no message to scroll back to. The only client that
can still show that reply is showing it from its own local copy, which this
sweep does not and cannot touch — that is the entire premise of
delete-on-delivery, and the three `NOT EXISTS` clauses are what guarantee every
device already has it.

So `reply_to_id = NULL` was added to the **SET clause** of the delivery sweep,
next to `content = NULL`. Nothing else changed:

- **The send path is untouched.** Clients still send `reply_to_id`, it is still
  persisted, still selected into `chatsMsgCols`, still rendered. A live reply
  behaves exactly as before.
- **The row set is unchanged.** `reply_to_id` is in the verb, never the
  predicate. Which rows the sweep touches is still decided by the three delivery
  clauses alone, so an undelivered message keeps its reply pointer for exactly as
  long as it keeps its body.
- **The schedule is unchanged.** Same job, same tick, same batch, same grace.
- **No migration.** The column stays; it is reclaimed, not removed. (Checked:
  last migration is 132. Nothing needed one.)

The unconditional age purge in the same function (`DELETE_ON_DELIVERY_MAX_AGE_DAYS`,
off by default) also nulls `content`, and got the same one-word addition for the
same reason — otherwise an operator who enables it reclaims the ciphertext and
keeps the graph, which is finding 1 through a back door.

**What this does and does not achieve.** It bounds the reply graph to the
delivery window instead of forever. It does **not** stop the graph existing
between send and sweep — that is the wire change the section above describes,
and it is still the right end state. This is the backstop doing its job in the
meantime.

**SOURCE-ONLY caveat, unchanged:** no production database was queried. Rows
written before this change keep their `reply_to_id` until the sweep next touches
them, and the sweep only touches rows whose `content IS NOT NULL` — so a message
already reclaimed under the old statement keeps its reply pointer permanently. A
one-shot backfill (`UPDATE messages SET reply_to_id = NULL WHERE content IS NULL
AND deleted_at IS NULL`) would clear that residue. It is not written here: it is
an operational action against live data, not a code change, and it should be run
deliberately rather than arrive inside a migration.

### Tests

`internal/jobs/reply_graph_test.go` (new) — pure, runs on every `go test ./...`:

- the sweep still nulls `reply_to_id`;
- `reply_to_id` appears in the SET clause and **nowhere in the row-selection
  predicate** — this is the half that matters, because a statement that nulled
  the column unconditionally would satisfy the first assertion while destroying
  the reply pointer of a message nobody has received yet;
- the age purge nulls it too (asserted against comment-stripped `jobs.go`, since
  that statement is inline rather than a const — a needle that matches the prose
  *about* a rule on a file where the rule was deleted is the trap
  `internal/realtime/payload_bounds_test.go` exists to avoid).

`internal/jobs/delete_on_delivery_db_test.go` (extended) — the real statement
against a real Postgres. The fixture gained a `reply_to_id` column and seeds a
complete reply graph over all eight messages. Two new subtests: the five
reclaimed messages lose their pointer; the three that survive the sweep
(undelivered, held by a live second device, no other member in the chat) keep
theirs **at its original value**.

Unlike the audit above, this was **run, not reasoned**. Postgres 18 is installed
on the machine; a throwaway cluster was initialised on port 55433 and the suite
run against it. All twelve subtests pass, and four negative controls were run:

| Break | Caught by |
|---|---|
| delete `reply_to_id = NULL` from the sweep's SET | both pure tests + `a reclaimed message loses its reply pointer` |
| delete it from the age purge | `TestAgePurgeAlsoReclaimsTheReplyPointer` |
| null `reply_to_id` on every row (the over-broad fix) | `an un-swept message keeps its reply pointer` |
| let `reply_to_id` into the row-selection predicate | `TestReplyPointerIsReclaimedOnlyWhereTheBodyIs` |

## Finding 4 — `message_reactions.emoji`: the finding is STALE. No table exists.

The audit read `008_reactions.sql` and did not read
`056_drop_plaintext_reactions.sql`, which is the whole of the fix it was asking
for and landed long before this audit:

```sql
-- F4 cleanup: reactions are now E2EE reference-messages (type='reaction', with
-- {reactsTo, op, emoji} sealed inside the message content). The old relational
-- table stored the emoji in PLAINTEXT (server-readable) and its endpoints are
-- gone. Drop it.
DROP TABLE IF EXISTS message_reactions;
```

`message_reactions` has no reader and no writer left in the Go backend — the
only mention is the comment at `internal/routes/user.go:1503`, which records that
the data-export route was 500ing with `42P01` against it until the query was
removed. A reaction is now an ordinary sealed message, so it is reclaimed by the
same delivery sweep as everything else in `messages`, and it now gets its
`reply_to_id` reclaimed too.

Nothing to fix. The finding's severity claim ("plaintext, attributed,
timestamped, never reclaimed") is not true of this schema and should be struck.

## Finding 5 — `poll_votes`: assessed, NOT fixed. Correctly.

Same test applied: is there a point at which no client can still use this?
**No.** A vote is not a delivery artefact, it is live application state:

- `chats_helpers.go:2571` reads `(option_index, user_id)` on every poll render.
  The tally *and* the "you voted for this" highlight are computed from these
  rows, on demand, for as long as the poll is visible.
- There is no poll close, no poll expiry, no per-vote delivery pointer. Nothing
  in the schema or the routes marks a poll finished, so there is no moment
  analogous to "content has been nulled" at which the rows stop being read.
- The message's own reclaim is the wrong trigger and is actively the opposite:
  `optionCount` is *derived during the sweep* specifically so that voting keeps
  working after the body is reclaimed (see the comment on
  `deliveredMessagesSQL`). The system deliberately keeps polls functional past
  reclaim. Deleting the votes at that moment would break the exact case the
  derivation was written to preserve.

Reclaiming votes would remove data a deployed client still displays, which
constraint 3 forbids. The retention *is* already bounded, just not by a sweep:
`poll_votes.message_id` is `ON DELETE CASCADE`, so votes die with the poll
message — on disappearing-message expiry, on delete-for-everyone, on chat expiry
(migration 120) and on account deletion (`user.go:1633`).

What remains true is the audit's point about *shape*, and it is unchanged by any
of this: for a two-person chat with a two-option poll, an attributed
`option_index` is the entire content of the communication, and the care taken
over `optionCount` is undone one table over. The fix is to seal the vote the way
reactions were sealed in 056 — vote as an E2EE reference-message, server holds a
count it cannot attribute — which is a client release, a route change and a
migration. Written up, correctly not made here.

---

# The remaining findings — 2, 3, 6, 7, 8 (a later pass)

Same test as findings 1 and 5: **is there a point at which the server can clear
this without removing anything a deployed client can still legitimately
display?** One fix landed (finding 3). The rest are answered below with the
code that answers them, not with a preference.

**Checked: the last migration is now 133 (`133_rls_roles.sql`), not 132.**
Nothing in this pass needed a migration either — the one change is a SELECT.

## Finding 2 — `messages.type`: assessed against the sweep, NOT reclaimable. Confirmed.

The question was whether `type` could be coarsened or nulled by the
delete-on-delivery sweep the way `reply_to_id` now is. It cannot, and unlike
finding 1 this is not a wire-compatibility worry — it is that **the server
itself reads the column after the sweep has run**, on rows whose body is
already gone. Three readers, all of them live:

1. **Polls stay votable past reclaim, by design.**
   `internal/routes/chats_helpers.go:2454-2466` reads
   `SELECT type, meta FROM messages WHERE id = $1` on every vote and refuses
   with *"Not a poll message"* unless `type = 'poll'`. The comment immediately
   below it is explicit that this path is meant to keep working after the body
   is reclaimed — `optionCount` is derived *during* the sweep precisely so it
   does. Coarsening `type` at reclaim would make every already-delivered poll
   unvotable, and it would do it silently and permanently.
2. **Unread counts read it on arbitrarily old rows.**
   `chats_helpers.go:1396` recomputes `unread_count` as a `COUNT(*)` over
   `m.id > $1 AND m.type <> 'reaction'`. The window is "everything since your
   last read pointer", which includes reclaimed messages. A reaction rewritten
   to a coarse class starts counting as an unread message.
3. **Delete-for-everyone writes it.** `chats_helpers.go:1278` sets
   `type = 'system'` alongside `content = NULL`. A sweep that also rewrote
   `type` would be the second writer of the same column at the same moment,
   with no ordering between them.

And on top of those, the column is echoed to clients in `chatsMsgCols` and on
cold sync, so a coarsened historical row re-renders a photo as a generic
attachment on a client that fetches history — the case the earlier write-up
already named.

So the sweep is **the wrong place**, not merely a risky one: `reply_to_id` was
safe to reclaim there exactly because nothing read it, and `type` is the
opposite. The verdict in the original write-up stands unchanged, and the route
is unchanged: add the coarse class to CC-Wire's `MessageClass` (pinned to five
values by `internal/jobs/meta_public_proto_test.go`, so it cannot grow
per-media granularity in the meantime), move clients onto it, then stop writing
the fine-grained column. Client release first.

## Finding 3 — `GET /api/admin/messages`: FIXED, partially. The reply graph is out.

The endpoint selected `reply_to_id` and returned it as `replyToId`. **Nothing
rendered it.** `admin/index.html:378-394` draws six columns — id, type, sender,
chat, status, time — and never touches the field. So this half was the finding-1
conversation graph assembled into an operator-facing live tail *for a reader
that could not use it*: all of the exposure, none of the purpose.

Removed from the SELECT and from the response. The rule at the top of this task
— do not remove data a deployed client can still legitimately display — is
satisfied by inspection of the only client there is, not by assumption.

`type` is **not** removed: the console does render it, in a column. That half of
the finding is finding 2, and it needs the client release above. Which is the
honest shape of this endpoint's fix — half of it was free, half of it is not.

`internal/routes/admin_metadata_test.go` (new, pure, runs on every
`go test ./...`) pins both halves: that `reply_to_id`/`replyToId` is gone, and
that the route still selects neither `content` nor `meta` — the "METADATA ONLY"
claim in its header comment, which nothing had ever asserted. Both were
negative-controlled by re-adding each column and watching the suite fail.

## Finding 5 — `poll_votes`: re-confirmed, unchanged.

Re-checked against the code above and the earlier assessment is right, and is
now doubly right: `chats_helpers.go:2454-2466` shows the vote path deliberately
outliving the message body. There is no moment at which a vote stops being
read, so there is no analogue of "the content has been nulled". Left alone.

## Finding 6 — `story_views`: confirmed bounded, not changed.

`sweepExpiredStories` deletes the story and the views cascade with it
(`020_stories.sql:41-47`), and account deletion clears the viewer's rows
directly (`internal/routes/user.go:1617`,
`DELETE FROM story_views WHERE viewer_id = $1`). Both exits verified in source
this pass. The retention is already the story's own lifetime, and the data is
the product feature — the author is *shown* who viewed. Nothing to reclaim
earlier without deleting the feature.

## Finding 7 — `users.last_seen_at`: confirmed, not changed.

Unchanged from the original assessment: a single overwritten value, not a log,
and the minimum state a last-seen feature can have. Note it is now one of the
columns `GET /api/admin/users` surfaces (`admin.go:163`) — which is an operator
seeing *last* seen, not a session history, and is the same value every peer
sees unless ghost mode is on.

## Finding 8 — refusal-path logs: NOT changed, and in this pass could not be.

`internal/realtime/handlers.go:194,562` are **out of scope for this pass** —
`internal/realtime/` is owned by concurrent work and was not to be touched. That
is the immediate reason nothing changed there.

The substantive reason is the one already written above and it has not moved:
these fire on *refusal*, which is the anomalous path, and they are the only
record that someone tried to join a chat they do not belong to or relay to a
peer they are not entitled to. Deleting a `(uid, chat)` pair out of a security
log to improve a privacy metric trades a real signal for a cosmetic one. If it
is ever taken up, the shape that keeps both is to log a stable **hash** of the
pair rather than the pair — enough to correlate repeated attempts, not enough to
name the conversation — and that is a change to a file this pass may not edit.

## Honest summary of this pass

| Finding | Verdict |
|---|---|
| 2 `messages.type` | **Not reclaimable.** Three live server readers run on reclaimed rows; the sweep is the wrong place, not a risky one. Needs the CC-Wire class + a client release. |
| 3 admin feed | **Half fixed.** `reply_to_id` removed (nothing rendered it). `type` kept (the console renders it) — that half is finding 2. |
| 5 `poll_votes` | Re-confirmed not safely fixable. Unchanged. |
| 6 `story_views` | Confirmed bounded by story expiry + account deletion. Unchanged. |
| 7 `last_seen_at` | Confirmed minimal. Unchanged. |
| 8 refusal logs | Out of scope this pass (`internal/realtime/` is owned elsewhere), and still the wrong trade. Hash-the-pair written up as the shape if it is ever taken. |

No migration was written and none was needed.

**Mirrored in the Node backend.** `vaultchat-backend/routes/admin.js:116-131` is
the route the Go file was ported from and carried the identical
`SELECT … reply_to_id …`. Left alone it would be the same leak on whichever
binary answers, and the next person to diff the two would put it back into Go to
"fix the divergence". Same removal, same comment, both sides.
