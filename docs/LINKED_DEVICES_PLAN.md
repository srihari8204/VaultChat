# Linked devices — plan

Design only. Nothing here is built. Written against finding F3 of the
September architecture review, which says the app has no companion devices and
no web client, that the Settings "Devices" figure counts sign-in sessions, and
that this matters because the work people would use this app for — the shop
ledger, Spaces rosters and runs, finance, document transfer — is work done
sitting down.

The review is right about the gap and right that it is the largest item in the
report. It is wrong about one thing, and the correction is the cheapest useful
result in this document: **the business half of the problem is not blocked on
the crypto half.** See §5.

---

## 1. What a "device" is today, and what it has to become

There are three different notions of "device" in this codebase. None of them
is a companion device, and no two of them are joined to each other.

| What | Where | Identity | What it actually is |
|------|-------|----------|---------------------|
| `devices` | migration `005_devices.sql`, `054_device_fcm_token.sql` | `UNIQUE (user_id, push_token)` | a push registration — Expo token + FCM token |
| `refresh_tokens` | `001_init.sql`, `127_refresh_token_lookup.sql` | row id | a sign-in session; user-agent + IP + expiry |
| `user_sync_devices.device_id` | `068_sync_devices.sql`, header `X-Device-Id` | SHA-256 hex in SecureStore, `services/deviceService.ts` | a per-INSTALL id, destroyed by uninstall |

`GET /user/security-overview` (`vaultchat-backend-go/internal/routes/user.go`,
`userSecurityOverview`) returns:

```
"activeSessions":  COUNT(*) FROM refresh_tokens WHERE ... revoked_at IS NULL
"linkedDevices":   COUNT(*) FROM devices        WHERE user_id = $1
```

So the field is literally named `linkedDevices` and counts push-token rows. A
user who reinstalls once, or who has a stale Expo token alongside a fresh one,
sees two "linked devices" and owns one phone. `GET /user/sessions` renders the
`refresh_tokens` rows, which is the list the Settings screen shows. The review
is right; the naming makes it worse than it looks.

**None of the three is authenticated as a device.** The access JWT
(`authSignAccess`, `auth.go`) carries `sub / email / iat / exp` — no device
claim. `X-Device-Id` is a self-asserted header; the cold-sync guard
(`chats.go`, `noteSyncDevice`) and the per-device delivery pointer
(`chats_helpers.go`, the `chat_device_delivery` upsert) both trust it. A
`refresh_tokens` row has no `device_id`, so revoking a session from the
sessions screen does not revoke that install's sync identity, and two installs
that copy the same device id are indistinguishable.

### The hard blocker is not sessions, it is the key schema

`011_prekeys.sql`:

```sql
CREATE TABLE IF NOT EXISTS identity_keys (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ...
```

One identity key per **account**. And `POST /user/keybundle`
(`user.go`, `userKeybundlePost`) does this when the uploaded key differs from
the stored one:

```sql
INSERT INTO identity_keys ... ON CONFLICT (user_id) DO UPDATE SET public_key_b64 = EXCLUDED...
DELETE FROM one_time_prekeys WHERE user_id = $1;
UPDATE signed_prekeys SET retired_at = NOW() WHERE user_id = $1 AND retired_at IS NULL;
```

A second install today does not merely fail to sync history. It **overwrites
the first device's published identity and destroys its prekeys.** Every peer
that fetches a bundle afterwards runs X3DH against the new device; the original
phone stops being reachable by new senders and its existing sessions survive
only until a peer re-keys. "One phone per user" is not a UX limitation waiting
for a feature — it is enforced by the schema, deliberately, and undoing it is
the architectural work the review means.

### What "device" has to mean

An addressable, independently authenticated, individually revocable principal
that owns its own key material. Concretely, everything below is keyed by
`user_id` today and is really keyed by "the thing holding the private key":

| Keyed by user today | Must be keyed by |
|---|---|
| `identity_keys (user_id PK)` | `(user_id, device_id)` |
| `signed_prekeys (user_id, key_id)` | `(user_id, device_id, key_id)` |
| `one_time_prekeys (user_id, key_id)` | `(user_id, device_id, key_id)` |
| `group_sender_keys (chat_id, sender_id, recipient_id)` | `+ sender_device_id, recipient_device_id` |
| client `PEER(chatId, senderId)` in `services/crypto/groupSession.rn.ts` | `PEER(chatId, senderId, senderDeviceId)` |
| per-peer ratchet in `services/crypto/e2eeSession.rn.ts` (keyed by peer user id) | keyed by peer *device* |
| Socket.IO room `user:<uid>` (`internal/realtime/server.go`) | plus `dev:<uid>:<deviceId>` for device-addressed traffic |

Two things are already device-granular and are the parts that will not need
rebuilding: `chat_device_delivery` (migration 078) and `user_sync_devices`
(068). That is more of a head start than it sounds — see §3.

---

## 2. Key model — recommendation: per-device identity

**Recommendation: each linked device gets its own identity key. The sender
encrypts once per recipient device. The Signal model.**

The alternative — copy the primary's identity private key to the companion
across the link QR — is the one worth arguing about, because at first glance it
looks like a tenth of the work. It isn't, and the reason is mechanical rather
than principled:

**A Double Ratchet state cannot be shared by two devices.** Two devices
advancing the same sending chain independently either reuse a message key or
desync on the first concurrent send, and there is no reconciliation — the chain
is a hash ratchet, not a CRDT. The same is true of a sender key chain
(`services/crypto/senderKey.ts`: `messageKey = HMAC(CK, 0x01)`,
`nextCK = HMAC(CK, 0x02)`). So even the "share the identity" design needs a
separate session per device, which means a separate prekey bundle per device,
which means the fetch path and the encrypt-N-times send path have to be built
anyway. Sharing the identity key saves the `identity_keys` schema change and
essentially nothing else, while costing:

- **Revocation stops working.** Unlinking a companion cannot revoke a key the
  companion already holds a copy of. The only honest remedy is rotating the
  account identity and re-keying with every peer — i.e. the thing this design
  was supposed to avoid, triggered on every unlink.
- **Safety numbers stop meaning anything.** `e2eePeerIdentityKey` /
  `lib/confirmIdentity.ts` attest a key; under a shared identity they attest a
  key that N machines hold, at least one of which is a laptop in an office. A
  privacy product that shows a verification code for a key with unknown
  multiplicity is making a claim it cannot support.
- **A single compromise is permanent and total.** Any companion's storage
  compromise is the account's identity, retroactively and going forward.

Per-device identity costs, honestly, in this codebase:

1. `011_prekeys.sql` tables gain `device_id`; `GET /user/:id/keybundle` returns
   a **list** of bundles, one per active device, each consuming its own OTPK.
2. `POST /user/keybundle` scopes to the calling device — and its destructive
   branch (purge OTPKs, retire SPK) must be narrowed from the account to that
   device. Getting this wrong is an account-wide outage, so it wants a test.
3. `lib/chatService.ts` `encryptForChat` produces N envelopes instead of one.
   The message row model has to carry them. `message_bodies` (migration 099) is
   one body per message today; per-recipient-device bodies multiply row count
   by the recipient's device count. **This is the unmeasured cost and it
   dominates Phase 2** — see Open questions.
4. Your own other devices are recipients of your own outgoing messages. That is
   how a companion sees what you sent, and it is also the transport for sender
   key distribution, so it is not extra work — but it does mean "encrypt for
   N recipients" includes self.
5. Safety-number UI shows per-device fingerprints, or one combined fingerprint
   over the sorted set of device keys that changes when the set changes.

The trade is real: the shared-identity option is perhaps a third of the work
for a materially weaker product, and the weakness lands exactly on revocation
and verification, which are the two properties a privacy product sells. Take
per-device identity, and if the schedule cannot afford it, ship Phase 0 and
Phase 1 (§6) and no E2EE multi-device at all — a partial honest model beats a
complete dishonest one.

---

## 3. Delete-on-delivery

The retention fork the review implies is needed **already exists**, and it is
more complete than expected.

`078_device_delivery.sql` introduced `chat_device_delivery` precisely because
"delivered" meant "some device of this user acked" and that destroys a message
a second device never saw. Both sweeps in
`vaultchat-backend-go/internal/jobs/jobs.go` (`sweepDeliveredMessages` and
`sweepDeliveredBodies`) use the same three-layer predicate:

- `chat_members.last_delivered_message_id` — account pointer
- `chat_device_delivery` — per-device pointer
- `user_sync_devices.last_sync_at` inside `DELETE_ON_DELIVERY_DEVICE_STALE_DAYS`
  (default 30, clamped up to the retention floor) so a sold handset cannot pin
  history forever

with a grace of `DELETE_ON_DELIVERY_GRACE_SEC` (default 3h). A linked device
that has not acked a message blocks its purge, today, with no schema change.

So **messages that arrive after the link are already safe.** The gap is
narrower and sharper than "delete-on-delivery breaks linked devices":

> A device linked on Tuesday has no path to anything purged before Tuesday, and
> no retention policy can create one, because the ciphertext is gone.

And even for what survives, `coldSyncMaxMessages` (`chats.go`, default 2000,
enforced by default since `COLD_SYNC_WARN_ONLY` stopped defaulting to true)
deliberately caps what an unrecognised install can drain — a guard that exists
to make a stolen refresh token less useful, and which a companion link should
satisfy by being *recognised*, not by being exempted.

### Options, and the recommendation

- **A device-count-aware retention fork.** Reject as a *history* mechanism: it
  is already built (078) and it only ever helps messages newer than the link.
  It needs no work beyond Phase 1 wiring the device id authentically.
- **Primary-to-companion transfer over VaultBeam P2P.** `lib/vaultBeamDirect.ts`
  already moves AES-256-GCM chunks over LAN TCP or a WebRTC datachannel,
  signalled over the existing socket relay, falling back to the R2 relay tier.
  It is the right shape for a phone→laptop bulk transfer with no server hop.
  It needs one thing it does not have: **device-level socket addressing.**
  Fan-out targets `user:<uid>` rooms (`realtime/server.go`, `Join("user:"+uid)`
  and `To("user:"+uid)`), so a device can only shout at every socket on the
  account including itself. Adding `dev:<uid>:<deviceId>` is small, and Phase 1
  needs it anyway for the link handshake.
- **Accept no history on link.** Defensible, and it is what a strict reading of
  delete-on-delivery implies, but it makes a companion useless for exactly the
  audience the review names: the ledger you open on a laptop is worthless if it
  starts empty.
- **The option the brief did not list, because it already exists:
  seed the companion from the encrypted backup bundle.** `lib/cloudBackup.ts`
  already serializes the local SQLite message DB, the decrypted plaintext
  cache, and prefs into one AES-256-GCM blob, and **deliberately excludes
  identity and ratchet material** (its header explains why: a
  server-recoverable bundle containing identity keys would let the server
  reconstruct the keys protecting the whole account). That exclusion is exactly
  what a companion wants — history without keys, for a device that is about to
  mint its own identity.

**Recommendation: seed from the backup bundle at link time, over VaultBeam
direct where both devices are reachable, falling back to the server-stored
blob.** State the cap in the link UI: *this device gets the history your phone
has now.*

**One condition, and it is not optional.** `cloudBackup`'s default key mode is
account-managed: the server generates the DEK, stores it in `user_backup_keys`,
and hands it to any authenticated session via `GET /user/backup/key`. Seeding a
companion from a bundle under that mode means the server can decrypt the
account history it just relayed. Companion seeding must use the opt-in E2EE key
mode (`lib/backupCrypto`) or a key derived from the link handshake secret. If
that is not acceptable for UX reasons, use VaultBeam direct only and do not
offer the server-relayed fallback. Shipping the convenient version by accident
would negate the product's central claim, quietly, in a code path nobody looks
at twice.

---

## 4. Groups and sender keys with N devices

Today: `040_group_sender_keys.sql` stores one opaque SKDM per
`(chat_id, sender_id, recipient_id)`; the client (`groupSession.rn.ts`) keeps
`OWN(chatId)` and `PEER(chatId, senderId)`. Both are per-user.

With N devices per user, four things change:

1. **A sender key belongs to a sending device, not a user.** Same hash-ratchet
   argument as §2 — two devices cannot share a chain. So each device has its own
   `OWN` chain per group, and each receiving device holds one `PEER` chain per
   *(sender user, sender device)*.
2. **Distribution fan-out grows from `M-1` to `ΣD_m − 1`** — every other device
   of every member, plus your own other devices. `group_sender_keys` becomes
   `PK (chat_id, sender_id, sender_device_id, recipient_id, recipient_device_id)`,
   and each SKDM is still sealed under the pairwise ratchet, which is now
   per-device-pair. For a 50-member group where people average two devices, a
   single key rotation is ~100 sealed blobs instead of ~50. That is fine; it is
   the rotation *frequency* below that needs watching.
3. **The message envelope needs a sender device id** so the receiver picks the
   right peer chain. Today `senderId` is enough; it stops being enough.
4. **Unlinking a device must rotate sender keys in every group that user is
   in.** This is the part that gets forgotten. Removal of a *member* already
   rotates (`groupSession.rn.ts` rotates on member removal so a leaver's stale
   copy goes dark). Removal of a *device* has identical semantics and identical
   consequences — skip it and an unlinked laptop keeps reading every group the
   user is in, forever, which is a worse failure than never having supported
   companions. Cost: one rotation per group at unlink time, fanned out to every
   device of every member. For a user in 40 groups that is a real burst; it
   should be queued and resumable, not done inline in the unlink request.

The tempting shortcut — "the companion decrypts using the primary's chain" —
is the shared-chain bug again, and it fails the first time both devices are
online and either sends.

---

## 5. What breaks that is NOT messaging — and the cheap win

**This is the most useful finding in this document.**

Shop Book, Khata, Spaces and Operations are **plain server-side Postgres
rows**. Not encrypted to a device key, not device-local, not touched by
delete-on-delivery, not dependent on any ratchet:

- `061_shopbook.sql` and everything after it (062, 069, 083, 092–097, 110–112,
  122): shops, products, orders, line items, ledger entries, stock, billing,
  purchases, returns, tax, documents, khata walk-ins and credit limits — all
  plaintext columns, scoped in the route handlers by owner/customer id.
- Spaces (084–089, 102, 113, 114): roster, roles, links, runs, run riders, run
  events, workforce, trips, items — server rows under RLS gates. Since
  `103_space_locations.sql` even member location is server-readable by explicit
  owner directive, so the sealed-relay constraint does not apply to the ops
  data a web dashboard would show.

**A web client for the shop ledger, khata, Spaces and documents requires zero
crypto work, zero changes to `identity_keys`, zero changes to sender keys, and
zero changes to retention.** It requires:

1. **CORS on the Go API.** There is no `Access-Control-Allow-Origin` anywhere
   in `vaultchat-backend-go` — grep finds nothing. A browser cannot call this
   API at all today. This is the single actual blocker, and it is a middleware
   with an origin allowlist from env.
2. **A browser-shaped session.** The refresh token is an opaque bearer the
   client stores; on web it wants an HttpOnly, `SameSite=Strict` cookie rather
   than `localStorage`. Migration 127's `token_lookup` already makes per-session
   revoke correct (it was the fix for "sign out other devices" signing itself
   out), so "sign out this browser" works the day the cookie lands.
3. **A web app.** `react-native-web` and `react-dom` are already dependencies
   and `app.json` has a `web` block (metro bundler, static output) — but the app
   imports `@op-engineering/op-sqlite`, `expo-secure-store`, Notifee and
   `react-native-webrtc`. Expecting `expo export --platform web` to produce a
   usable build is not realistic. A separate small React app against the same
   REST endpoints is the honest cheaper path. How much of `components/finance`
   and the Shop Book screens ports is a spike, not an assumption.

### The correction to the review

The review lists four things: shop ledger, Spaces rosters and runs, finance,
document transfer. Three of them are server-side. **Finance is not.**

`app/finance/*` reads `db/ledger.ts`, `db/chitti.ts`, `db/reminders.ts`,
`db/financeTimeline.ts` — all of which open `db/financeDb.ts`, an on-device
SQLite file (`interest.db`). Every lending ledger, chit group, member,
collection, auction and reminder lives on exactly one phone. `db/financeBackup.ts`
exists precisely because "losing the device lost all of it", and its own header
says so.

So the review's "largest item in the report" splits into two items of very
different size:

- **shop ledger + khata + Spaces + documents** → server-side → reachable from a
  web client behind a CORS middleware and a session cookie. Cheap. Do it first.
- **finance + messages** → device-local → not reachable until either a
  server-side model exists (a product decision about where a user's lending
  book lives, with its own privacy argument) or the full companion-device stack
  lands.

Document transfer is *probably* in the cheap half — uploads are R2-backed and
server-mediated — but confirm whether media encryption (the W6 flag) is on in
the shipped config before promising it, because per-file keys wrapped in the
message envelope would put documents back in the expensive half.

---

## 6. Phased plan

Sizes are planning numbers, not estimates. Phase 2's number is the least
trustworthy because the message-storage cost has not been measured.

### Phase 0 — Web client for server-side data · ~2–3 weeks
CORS middleware + origin allowlist env; refresh-token cookie mode; a separate
React app for Shop Book, Khata, Spaces/Ops and documents. No schema change, no
crypto, nothing touched in `services/crypto/`.

**What Phase 0 does NOT give you:** no messages, no finance, no push, and
nothing in Settings that can honestly be called a linked device. It is a
second front end on existing server data, and that is the point — it delivers
most of the review's business case without any of its architecture.

### Phase 1 — Device as a first-class principal · ~3–4 weeks
- `user_devices` table: id, user_id, display name, platform, `linked_at`,
  `revoked_at`, `last_seen_at`. `refresh_tokens.device_id` FKs to it. The
  `devices` push rows and `user_sync_devices` rows gain the same FK, so the
  three notions in §1 finally join.
- Device claim in the access JWT, so `X-Device-Id` stops being self-asserted
  and the cold-sync and retention guards become authenticated.
- Link flow: primary displays a QR, companion presents it, primary approves.
  Handshake over the existing socket relay; add `dev:<uid>:<deviceId>` rooms.
- Settings shows real linked devices; revoking one kills the refresh token, the
  sync identity and the push row in one transaction.
- Rename or retire the `linkedDevices` field in `security-overview` — today it
  is wrong, and Phase 1 is when it can be right.

**What Phase 1 does NOT give you:** the companion still cannot decrypt a single
message. It is purely the session and identity substrate. It is worth shipping
alone anyway, because it fixes an honesty bug in Settings and turns two
security guards from advisory into enforced.

### Phase 2 — Per-device keys and 1:1 multi-device messaging · ~6–10 weeks
Prekey tables gain `device_id`; `GET /user/:id/keybundle` returns a list;
`POST` scoped to the caller's device with its purge branch narrowed;
`chatService` encrypts per recipient device including self; per-device envelope
storage; per-device safety numbers; companion history seeded from the E2EE-mode
backup bundle at link time.

**What Phase 2 does NOT give you:** groups. A companion in Phase 2 sees 1:1
chats and is blind in every group.

### Phase 3 — Groups · ~3–5 weeks on top of Phase 2
`group_sender_keys` widened to device granularity; client `PEER` namespaced by
sender device; sender device id in the envelope; rotation on unlink, queued and
resumable.

### Phase 4 — Web messaging client · large, deliberately last
A browser implementation of the ratchet and sender keys (the crypto core is
pure `@noble` TypeScript, so it ports — the storage layer does not), plus an
IndexedDB encrypted store, plus the plaintext-cache model meaning the web
client's readable history is its own and starts at link time. Do not start this
before Phase 3 is real.

---

## Open questions

- **Per-device envelope storage growth is unmeasured.** `message_bodies`
  (migration 099) is partitioned and swept; multiplying rows by recipient
  device count changes both the write path and the sweep's cost. Measure before
  committing to Phase 2's shape — the alternative (one body, per-device key
  wraps in a side table) may be cheaper and is worth pricing.
- **Are documents/media encrypted in the shipped config?** The W6 media
  encryption flag decides whether document transfer is in Phase 0's cheap half
  or not. Check the deployed flag values, not the code.
- **Web app: `react-native-web` or a separate React app?** A spike on one Shop
  Book screen answers it in a day. Assuming either way is how this phase
  overruns.
- **Does finance get a server model?** Not an engineering question. A lending
  ledger that lives only on one phone is defensible as a privacy stance and
  indefensible as a product for someone who does this work at a desk. Decide it
  explicitly rather than letting the answer be "whatever the companion
  transfer happens to carry".
- **iOS and desktop-native are out of scope here.** Phase 1's device model
  should not assume Android, but nothing in this plan validates an iOS path.

---

## Implementation status (appended 2026-09-14)

**Built: the schema half of Phase 1, and nothing else.**

- `vaultchat-backend/migrations/132_user_devices.sql` — `user_devices` keyed
  `(user_id, device_id)` on the existing per-install id, plus nullable
  `device_id` columns and composite FKs on `refresh_tokens` and `devices`.
  **WRITTEN, NOT APPLIED.** Additive, idempotent, rollback block included.
  (Migrations live in `vaultchat-backend/migrations/`, not
  `vaultchat-backend-go/migrations/`, which does not exist.)
- `vaultchat-backend-go/internal/routes/user_devices_migration_test.go` —
  structural guard: the migration stays additive, issues no DDL against
  `identity_keys` / `signed_prekeys` / `one_time_prekeys` /
  `group_sender_keys`, and no Go file references `user_devices`. The second
  test is meant to be deleted by whoever adds the JWT device claim.

**Deliberately not built**, because each one edits a live path:

- Device claim in the access JWT (`auth.go`, `authSignAccess`). Until it
  lands `X-Device-Id` stays self-asserted and `user_devices` must stay
  unread — a guard keyed on an unauthenticated header is worse than no guard.
- `dev:<uid>:<deviceId>` socket rooms (`internal/realtime/server.go`), link
  QR handshake, revoke-in-one-transaction, and renaming
  `security-overview.linkedDevices`.
- Everything in §2/Phase 2: `identity_keys` is still `user_id PRIMARY KEY`.

**On the "blocked on identity_keys PK" framing:** Phase 1 is not blocked on
it and never was — §6 says so. What *is* blocked is per-device E2EE (Phase
2+), and the block is real: widening the prekey tables also requires
`POST /user/keybundle`'s purge branch to be narrowed from account to device
and `encryptForChat` to fan out per device. Getting either wrong is a silent
account-wide decryption outage, so it is not a change to make alongside
anything else.
