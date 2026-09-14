# §9 — message correctness & offline: audit of the live outbox

Scope: `lib/messageQueue.ts` (the live send path), with `lib/api.ts` and
`lib/socket.ts` read for the auth and delivery seams. Line numbers are
post-change unless marked "before".

Three gaps were fixed. Two were found, judged risky or server-side, and
deliberately left — they are written up in §7 with what a fix would cost.
Nothing in `lib/socket.ts`, `lib/api.ts` or `vaultchat-backend-go/` was touched;
`services/transport/rust/src/work.rs` remains inert and unwired.

Checks: `npx tsx lib/messageQueue.selftest.ts` (new),
`node scripts/test-all.js` (all suites pass), `npx tsc --noEmit`, `npm run lint`
(0 errors).

---

## Summary

| # | Failure mode | Verdict |
|---|---|---|
| 1a | Acked to the UI, never persisted — **enqueue** | **was a real gap — FIXED** (`messageQueue.ts:212`) |
| 1b | Acked to the UI, never persisted — **local commit** | **was a real gap — FIXED** (`messageQueue.ts:576`, `:689`) |
| 2 | Send during a token refresh / reconnect | already handled |
| 3 | App killed mid-send | already handled |
| 4 | Ordering after a retry | **was a real gap — FIXED** (`messageQueue.ts:660-718`) |
| 5 | Unbounded outbox growth | **real gap — LEFT, see §7.1** |
| 6 | Idempotency of a retry | already handled, end to end |

---

## 1. A message acked to the UI but never persisted

This is the one that was hunted hardest, and it was present in **two** distinct
places. Both share a shape: a write that could fail, a `catch {}` that hid it,
and a UI event emitted regardless.

### 1a. `enqueue()` reported success for a row that never reached SQLite

`put()` (`messageQueue.ts:167`) wraps `queuePut` in `try { … } catch {}`.
Before the change, `enqueue()` did:

```ts
await put(msg);        // swallows a failed write
emit('pending', { msg });
flush().catch(() => {});
```

A failed `queuePut` — disk full, the cache DEK not loaded yet, a locked
database — therefore returned normally. The caller rendered an optimistic
bubble, `flush()` read a queue the row was never in, and the message was gone at
the next cold start. Nothing logged, nothing failed, nothing retried.

What makes this the worst of the set is that the user's evidence is a clock that
never becomes a tick, which is **identical to simply being offline**. It would
never be reported as data loss; it would be reported as "offline messages are
slow", if at all.

**Fixed.** `put()` now returns whether the row landed (`:167`) and `enqueue()`
throws when it did not (`:212-213`). Both call sites already do the right thing
with a throw and neither needed changing:

- `app/chat.tsx:1268` — inside a `try`/`catch` that alerts "Send failed", and
  crucially its `setInput('')` sits *after* the `await`, so the text stays in the
  composer. No optimistic bubble is created.
- `lib/notificationActions.ts:109` — already wrapped, swallowed deliberately.

Emitting `failed` instead of throwing was considered and rejected: the caller has
not rendered a bubble yet at that point, so `app/chat.tsx:752` (which matches on
`_tempId` in existing state) would drop the event on the floor — the same trap
already noted at `app/chat.tsx:336`.

`flush()` and `retry()` ignore the new return value on purpose. They are
rewriting a row that is already on disk, so a failed re-write loses nothing the
next pass cannot redo.

### 1b. The local plaintext commit could fail, and flush destroyed the copy anyway

`postOnce` writes the sender's own readable record at `messageQueue.ts:561-563`.
That write is the point of the whole "ONE LOCAL MESSAGE RECORD, LIKE SIGNAL"
block above it — a Double Ratchet ciphertext cannot be opened by its sender, so
this row is the only copy of the sender's own text.

The `catch` warned and continued (the `console.warn` at
`:566`, whose own comment reads "Do NOT swallow this quietly — it is the sender's
only readable copy") — and then returned a plain success. `flush()` acted on that
success and ran `item.plaintext = ''` unconditionally, because acceptance "swaps
the payload" from plaintext to ciphertext.

So on that branch **both copies went at once**: `cacheMessages` never landed, and
the outbox row that still held the text was wiped nine lines later. The user got
a tick, and their own bubble read "not available on this device" forever — while
the recipient could display it perfectly. The file already records this symptom
being seen on two handsets.

`cacheOwnPlaintext` at `:512` is not a rescue: it is skipped entirely when
encryption is off, and it swallows its own errors (`chatService.ts:1088`).

**Fixed, minimally.** `PostResult` gains a `committed` flag (`:454`), set false in
that `catch` (`:576`), and `flush()` blanks the plaintext only when the commit
landed (`:689`). The row stays accepted and inert either way, so nothing is
re-POSTed and no duplicate is possible.

The cost is honest and bounded: on this rare branch an accepted row keeps
readable text on disk instead of ciphertext, until `reapAwaitingDelivery`
(`:424`, 7-day cutoff at `:129`) or a delivery receipt releases it. That is the
same at-rest exposure any *queued* row already has, and it is strictly better
than the alternative, which is destroying the user's message.

---

## 2. Send during a token refresh / reconnect — already handled

**Refresh.** `api()` retries once on 401 through a single-flight
`tryRefresh()` (`api.ts:285-291`, used at `:404-406`), so a flush that 401s
mid-pass cannot start a second refresh and rotate the rotating refresh token out
from under itself. No double-send is possible: the first attempt was rejected
with 401 and never inserted.

The three-way `RefreshOutcome` (`api.ts:280`) is what keeps the queue alive
across a bad network: `transient` throws a plain `Error` with **no** `.status`,
so `isPermanent(undefined)` is false (`messageQueue.ts:41`) and the row keeps its
clock. `SessionEndedError` likewise carries no status, so a logged-out user's
queued messages survive in SQLite and flush after the next sign-in.

**Reconnect.** Three things can call `flush()` at once — the NetInfo listener
(`:765`), the 30s tick (`:774`) and `enqueue()` itself (`:215`). The
`flushing` / `flushAgain` guard (`:603`, `:719`) coalesces them into exactly one
extra pass, so concurrent passes — and therefore concurrent POSTs of the same
row — cannot happen. Verified by the existing `messageQueue.latency.selftest.ts`.

## 3. App killed mid-send — already handled

`enqueue()` persists **before** it flushes (`:212` then `:215`), so the row is on
disk before any network work begins. `initQueue()` (`:755`) migrates the legacy
AsyncStorage queue and then drains at boot (`:778`), independently of any screen
being mounted.

A kill *after* the POST reached the server but *before* the ack was processed
leaves a QUEUED row that gets re-POSTed on the next start — safe because of §6.

Storage is one row per item (`queuePut`), not a rewritten JSON array, so a kill
mid-write cannot corrupt unrelated queued messages.

## 4. Ordering — was a real gap, fixed

The flush page is oldest-first and sent serially, so order held *as long as
everything succeeded*. It did not hold across a transient failure. Before the
change the loop was:

```ts
catch (err) { … remaining.push(item); }   // and carry straight on
```

Message A 5xx's and goes to `remaining`; the loop immediately attempts message B
from the **same chat**; B is accepted and gets a lower server id than A will get
on its retry. Both sender and recipient sort on that id, so the reordering is
permanent. A thirty-second server blip while someone types three lines is enough
to produce it.

**Fixed** (`:660-718`): a transient failure adds its `chatId` to a `blocked` set
(`:718`) and later rows in that chat are deferred for the rest of the pass
(`:668`) — no attempt, no `attempts++`, no `retry` event, the clock simply keeps
ticking. This is WhatsApp's behaviour.

Deliberate limits on that fix:

- **Per chat, not global.** Other chats drain normally, which preserves the thing
  the page-rotation machinery at `:157` and `:726` exists to protect: 200
  messages wedged `WAITING_KEYS` on one peer must not starve everyone else.
- **Permanent rejections do not block.** A 400/403/404/413 message is red and is
  never going to arrive; holding the rest of the chat behind it would strand the
  chat forever.
- **Backoff maths is unaffected.** `blocked` is only ever populated from the
  `catch` that has already done `attempts++`, so `remaining` always contains at
  least one row with `attempts >= 1` and the `Math.max(...) - 1` index at `:731`
  can never go negative.

The remaining known ordering hole is `mediaOutbox`, which is a separate queue
with its own flush loop — a text message can still overtake a photo queued
before it. Out of scope here and not introduced by this change.

## 5. Unbounded growth — real gap, left. See §7.1.

## 6. Idempotency — already handled, end to end

`envelope.proto:139` declares `client_msg_id`; the live HTTP path uses the same
key under the name `clientId`, and it is wired all the way through:

- generated once per item and **persisted with the row** —
  `messageQueue.ts:182`, inside `baseItem`, so it is written to SQLite before the
  first POST;
- sent on every attempt — `messageQueue.ts:494`;
- never regenerated: `retry()` (`:267`) resets `attempts` and `lastError` only,
  and the catch path at `:712` re-`put`s the same object.

Server side (read-only; not modified):

- `vaultchat-backend/migrations/055_message_client_id.sql:22` creates
  `ux_messages_client_dedup (chat_id, sender_id, client_id) WHERE client_id IS
  NOT NULL`;
- `vaultchat-backend-go/internal/routes/chats_helpers.go:770` inserts with
  `ON CONFLICT (chat_id, sender_id, client_id) … DO NOTHING` and, on no-rows,
  **re-selects and returns the original row** (`:776`) rather than erroring.

So a retry after an ambiguous failure (the 30s `REQUEST_TIMEOUT_MS` at
`api.ts:257` firing on a POST the server actually committed) returns the original
message and creates no duplicate. The new selftest pins both halves, including
the two Go lines, because the client guarantee is worthless without them.

One nuance, benign: on a dedup retry the client retains the ciphertext from the
**retry's** ratchet step, not the one the server stored. Re-body would therefore
replace the stored bytes with a different-but-equally-valid DR ciphertext. Both
are decryptable by the recipient (skipped-key handling), so this is noted rather
than fixed.

---

## 7. Deliberately not fixed

### 7.1 The outbox has no size cap

`enqueue()` never counts rows, and `reapAwaitingDelivery` (`:424`) only reaps
rows that are already **accepted** and older than 7 days (`:129`). A queued row
that has never been accepted is retained forever, by design ("a message is NEVER
failed for lack of network"). A long offline period with heavy typing grows the
`queues` table without limit.

**Not fixed on purpose.** Every bounded-queue policy costs a user's message:
drop-oldest silently discards something they believe is sending, drop-newest
refuses a send at the composer. Both are worse outcomes than the growth, and
neither can be chosen without a product decision. The practical exposure is also
small — `PAGE = 200` bounds what a flush loads into memory (`:34`, `:180`), so
this is disk growth, not a latency or OOM path, and it takes thousands of
messages typed with no connectivity to matter.

If it is ever wanted: a soft cap in `enqueue()` that emits `failed` on the
**newest** message (so the user is told at the moment they send, rather than
losing something they already saw a clock on) is the smallest correct shape.

### 7.2 A failed `queuePut` gives a red bubble that Retry cannot resurrect

Fix 1a's throw means no bubble exists, so this is not reachable via that path.
But a `put()` failure inside `flush()`'s catch (`:713`) leaves a row whose
updated `attempts` did not persist, and the retry ladder re-reads the stale row.
Harmless (it retries anyway, one backoff step behind) and fixing it would mean
failing a send for a bookkeeping write. Left.

### 7.3 `retry(tempId)` on a row that is gone is a silent no-op

`retry()` (`:267`) returns early when `queueGet` finds nothing. The UI's Retry
button (`app/chat.tsx:1307`) therefore does nothing for a bubble whose row was
dropped by the permanent-failure path — the user must retype. Fixing this means
the UI holding the plaintext for a red bubble, which is `app/chat.tsx` work and
outside this scope.

### 7.4 `reBodyAwaiting` can run twice concurrently

It executes after `flushing` is cleared (`:739`), so a `flush()` starting at that
moment can overlap the previous call's recovery pass. The result is a duplicate
`PUT …/body` of the same ciphertext — idempotent, and costing one wasted request
at most. Guarding it would mean a second mutex on the live path for no
correctness gain. Left.

### 7.5 Server-side: `DELETE_ON_DELIVERY` is off

Not a client issue, and already written up in `docs/DELETE_ON_DELIVERY_STATE.md`.
Worth naming here only because the entire SERVER_ACCEPTED-vs-DELIVERED retention
design in this file (`:93-129`) exists to survive a reclaiming server that is not
currently reclaiming. The retention code is correct either way; it is simply
carrying a cost that today buys nothing.

---

## 8. What the new selftest covers

`lib/messageQueue.selftest.ts` runs the **real** `flush()` and `enqueue()` with
the import block rewritten to stubs (the same trick as
`messageQueue.flush.selftest.ts`, which continues to own paging, recovery and the
flush mutex). It asserts:

1. a later message in the same chat is held behind a transiently-failed one, a
   different chat is not, the held messages take no attempt of their own, and the
   chat drains in order once the failure clears;
2. a failed local commit keeps the plaintext on the accepted row, while the
   normal path still blanks it (so the at-rest property is not quietly lost);
3. `enqueueText` throws and leaves nothing behind when the outbox write fails;
4. the `clientId` is persisted, unchanged across a retry, and re-sent verbatim —
   plus the two Go lines that make that safe.

Note that `postOnce` reaches `cacheMessages` through a **dynamic**
`import('./localDb')`, so the harness provides a real module on disk rather than
rewriting an import — the commit failure in (2) is exercised, not simulated.
