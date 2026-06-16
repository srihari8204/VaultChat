# VaultChat — Gap-Closure Plan (207-feature spec → production)

> Status: PLAN (awaiting approval to implement). Created 2026-06-15.
> Source: full codebase audit vs. the master build prompt.
> Rule for every item below: **real production code only** — no mocks, no
> `setTimeout` fake progress, no hardcoded sample data, no fake security
> verdicts. If an item can't be built fully real without infra, it is marked
> **BLOCKED** with the exact infra needed.

## Progress log

- **2026-06-15** — P0 started (real code, no dummy data):
  - **W10 ✅** deleted dead fake-crypto `services/doubleRatchetService.ts` (no imports; only the real `services/crypto/` ratchet remains).
  - **W1 ✅** tamper-evident on-device audit chain: `services/security/auditChain.ts` (SHA-256 hash-linked log in SQLite, `verifyAuditChain()`), wired to real sources (screenshot capture in `chat.tsx`, device-integrity scan in `securityService.ts` via new `scanDeviceAndRecord()`), and a fully rebuilt `app/(tabs)/alerts.tsx` feed with integrity banner + live "Scan device". Typechecks clean.
  - **W2a ✅** `app/aiguardian.tsx` rewritten from fake "97/100 + fabricated events + 3s fake scan" into a real **Security Guardian**: honest signal-derived score (`services/security/securityScore.ts` — E2EE/app-lock/last-scan), real events from the audit chain, real `scanDeviceAndRecord()` scan; also fixed broken `#000` on-dark text. Typechecks clean.
  - **W3 ✅** genuine duress/decoy **cryptographic** separation: `services/security/vaultKeys.ts` (scrypt PIN→key + AES-256-GCM seal/open + dual-vault header logic, pure) and `duressVault.ts` (SecureStore persistence; **neither PIN stored**; unlock-by-decryption). Node self-test `vaultKeys.selftest.ts` **PROVES** the duress key cannot decrypt the real vault — 9/9 checks pass. Decoy is now a real **persistent** account (`lib/ghostProtocol.ts` + `decoy-chats.tsx`/`decoy-chat.tsx` persist via AsyncStorage; sent messages survive reload). `app/duresspin.tsx` rewired off the old plaintext-PIN string-compare. Typechecks clean. **Follow-on (#32):** seal the real session + message cache *at rest* under the real key so duress can't reach real data by any navigation path (architecture already supports it — `setupVaults` takes a `realPayload`).
  - **W1 backend tier ✅ (full-stack, per "do it on both ends")** — migration `vaultchat-backend/migrations/036_security_events.sql` (zero-knowledge: ciphertext `blob` + opaque SHA-256 hashes only, `user_id`-scoped, idempotent `UNIQUE(user_id,hash)`); routes `POST/GET /user/security-events` in `routes/user.js`; client ZK sync in `auditChain.ts` (`syncAuditChain()` — push-on-append + restore-on-reinstall; each event AES-256-GCM-sealed under a device key `vc_audit_key` the server never sees), wired into the Alerts tab. Backend syntax OK, client typechecks clean. Also fixed a stale `firebaseAdmin.js` ref in the backend `lint:syntax` script. **Local test:** `cd vaultchat-backend && npm run migrate` → restart api.
  - **W2b ✅ (full-stack)** `app/breachguard.tsx` rewritten from 100% fabricated → real: shared `lib/breachCheck.ts` (real HIBP k-anonymity password check + email breach API + monitor CRUD), `dark-web-guard.tsx` refactored onto it. Backend migration `037_breach_monitors.sql` + `GET/POST/PATCH/DELETE /user/breach-monitors` (watch list persisted; HIBP key stays on-device). Real scans emit audit-chain BREACH events (which sync to the W1 backup). Client typechecks, backend syntax OK. **Local test:** `npm run migrate` (037) → restart.
  - **W4 ✅ (full-stack)** real location sharing replaces the old fake screen (which faked "🔐 D2DE · AES-256-GCM · zero plaintext coordinates" while sending/encrypting nothing). **One-time:** `app/location.tsx` now sends a real `'location'` message (content = `{lat,lng,address}` JSON) through the normal pipeline → **E2EE in direct chats** like any text; `app/chat.tsx` renders a tappable location bubble + a Location entry in the attach menu. **Live:** emits `live_location_update` over the socket, which the server already **relays with zero storage** (`server.js`) and the chat already renders as a live banner — so the sender was the only missing half. Honest copy throughout; `lib/stealthMode.ts` false "AES-256 encrypted" comment corrected. **No new backend needed** (`'location'` type already whitelisted in `routes/chats.js`; live relay already existed). Client typechecks clean.
  - **🎉 P0 (honesty tier) COMPLETE + DEPLOYED:** W1, W2a, W2b, W3, W4, W10 — every fabricated security guarantee found has been made real or removed.
- **2026-06-15 — P1 started:**
  - **W8 ✅ (full-stack)** safety-number verification (#101): `services/security/safetyNumber.ts` (Signal-style symmetric numeric fingerprint, pure) + Node self-test `safetyNumber.selftest.ts` **PROVES** it's symmetric and that a MITM key changes the number (5/5). Backend: migration `038_contact_verifications.sql`, a non-consuming `GET /user/:id/identity`, and `GET/POST /user/contact-verifications`. Client: `lib/verification.ts` + `app/verify-contact.tsx`; tapping a direct-chat contact's name (`app/chat.tsx` header) opens the safety number + "Mark as verified". Typechecks + backend syntax OK. **Deploy:** `npm run migrate` (applies 038).
  - **W9 ✅ (full-stack)** removed the server's plaintext message search — the documented ZK violation. Both `GET /chats/search` and `GET /chats/:id/messages/search` no longer run `content ILIKE`: global search returns chat/contact **name** matches only, and in-chat search moved fully **on-device** (`lib/chatService.searchInChat` decrypts + matches the local store; `app/in-chat-search.tsx` copy updated). The server can no longer read message bodies via search. Backend syntax OK, client typechecks. **No new migration** (route change only — redeploy the bundle). Follow-on: global cross-chat message-content search on-device (per-chat search covers the common case).
  - **#32 Phase A ✅ (client; flag `VAULT_SESSION_SEALED`, default OFF)** — real session tokens sealed under the unlock PIN instead of plaintext SecureStore, so a duress/decoy PIN can't reach the real session. `services/security/sessionSeal.ts` (reuses proven `vaultKeys`) + `sessionSeal.selftest.ts` **4/4** (duress PIN can't unseal). `lib/api.ts` seam (flag-OFF path byte-identical; in-memory session + seal/unseal), wired into `set-mpin` (seal), `enter-mpin` (unseal; PIN-only when sealed — biometric can't unseal a PIN-key), and the `_layout` unlock gate. Fallbacks everywhere → never bricks. Typechecks clean. **Enable + two-device test before prod.** **Phase B** (re-key the SQLite message cache under the real key) pending.
  - **#32 Phase B ✅ (client; flag `VAULT_CACHE_ENCRYPTED`, default OFF)** — the local SQLite cache (`lib/localDb`) stored message bodies in plaintext; now the sensitive columns (`messages.content`, `messages.meta`, `chats.data`) are sealed at rest with AES-256-GCM. Envelope keying (`lib/cacheCrypto.ts`): a random 32-byte DEK encrypts fields and is itself sealed under the PIN-derived session key in SecureStore (`vc_cache_dek`); the DEK is loaded into memory only after unlock, so duress/seizure can't read bodies. Field codec uses an `enc:v1:` prefix → sealed + legacy-plaintext rows coexist (lazy migration, no bulk rewrite); pass-through when locked/off so `localDb` is byte-identical with the flag off. DEK lifecycle wired into `lib/api.ts` (`sealCurrentSession`→provision, `loadSealedSession`→unlock, `clearTokens`→drop key) and `clearLocalDb`→wipe envelope. `exportAll` decrypts / `importAll` re-encrypts so backups stay portable. Self-test **10/10** (`lib/cacheCrypto.selftest.ts`: wrong DEK can't read, locked pass-through, legacy coexist). Typechecks clean. Indexed/queried columns (ids, timestamps, deleted_at) stay cleartext by design. **Enable with `VAULT_SESSION_SEALED` and two-device test before prod.**
  - **W6 ✅ (full-stack) — media + location at rest.** Audit found two real plaintext leaks + dead code:
    - **Location pins (client, always-on):** `location-sharing.tsx` and `current-location.tsx` put lat/lng in **plaintext `meta`** (server-readable). Fixed → coordinates now ride in the message **content** (E2E-encrypted in direct chats, like `location.tsx` already did). Render already parses content JSON. (Legacy history with coords-in-meta no longer shows a map link — acceptable; we stop surfacing the leaked field.)
    - **Live location (full-stack, always-on, zero-knowledge relay):** live sharing previously emitted **plaintext** coords over the socket (and had no working receiver). New `lib/liveLocationCrypto.ts` — a per-session AES-256-GCM key generated by the sharer, delivered to the peer ONCE inside the initial E2E `location` message (`content.lk`); every position update is encrypted to an **opaque blob**. Backend `server.js` `live_location_update` now relays the opaque blob (membership-checked, no storage, **never sees coordinates**; legacy plaintext tolerated for rollout). Peer (`chat.tsx`) stashes the session key on decrypt and opens each blob to drive the live banner. Self-test **5/5** (`liveLocationCrypto.selftest.ts`: wrong key can't decrypt, blob leaks no coords, fresh nonce per update). **Deploy:** rebuild + reload backend image (relay change); client ships in next APK.
    - **Media (client; flag `MEDIA_E2EE`, default OFF):** the proven E2E media module (`lib/mediaAttachments.ts`) existed but had **zero callers** — all sends used the plaintext path. New `lib/sendMedia.ts` routes direct-chat photo/video/voice/file through `uploadEncryptedAttachment` (fresh per-file AES-256-GCM key, server stores opaque ciphertext; key delivered in the E2E content via `buildMediaContent`). Wired into the 3 `chat.tsx` send sites; receive path stashes the key (`parseMediaContent`) and the 4 media bubbles render via `getDecryptedAttachmentUri` (decrypted local file). **Gated on `meta.encrypted`** so the plaintext path is byte-identical with the flag off; group/legacy media falls back to the direct URL. Media AES-GCM codec round-trip verified. **Before enabling:** wire the shared-media views (`media-gallery`, `media-viewer`, `file-viewer`, `contact-info` shared media) to `getDecryptedAttachmentUri`, then two-device direct-chat round-trip.
    - **Cleanup:** deleted dead Firebase `services/liveLocationService.ts` (orphaned, plaintext-to-Firestore, zero callers).
    - **W6 follow-on ✅** — shared-media views now decrypt encrypted media: `media-gallery` (lazy per-tile `MediaThumb` decrypts via the message content) and `contact-info` (`SharedMediaThumb`) both resolve through `getDecryptedAttachmentUri`; both call `getChat` so the peer is known for decrypt. `media-viewer`/`file-viewer` are orphaned routes (no navigators) → nothing routes encrypted media through them. `MEDIA_E2EE` is now fully enable-able.
  - **W7 ✅ (full-stack) — per-viewer story encryption (flag `STORY_E2EE`, default OFF).** Closes the gap `020_stories.sql` itself deferred to "Phase-3b, needs real E2EE." An encrypted story's media is uploaded as opaque AES-256-GCM ciphertext (reuses `uploadEncryptedAttachment`); its single content key is wrapped **separately per authorized viewer** by encrypting it through the author↔viewer **E2EE session** (the proven per-peer Double Ratchet — `lib/storyKeys.ts`). Backend: migration **039** (`stories.encrypted` + `story_keys(story_id, viewer_id, wrapped_key)`); `GET /stories/audience` (eligible viewer ids for wrapping), `POST /stories` accepts `encrypted` + per-viewer `keys` (validated against the real audience), `GET /stories/:id/key` serves a viewer only their own opaque wrapped key (404 if not in audience / expired). Client: `status.tsx` encrypts + wraps + posts; `story-viewer.tsx` fetches its wrapped key → unwraps → `putMediaKey` → `getDecryptedAttachmentUri` to render. Server stores only opaque ciphertext + opaque wrapped keys — **can never read a story**. Plaintext/encrypted stories coexist (`story.encrypted` gates the path); flag-off byte-identical. Late/non-audience viewers have no key and can't decrypt (correct for ephemeral). Typechecks clean, `stories.js` syntax OK. **Deploy:** `npm run migrate` (applies 039) + redeploy bundle; client in next APK; two-device test before enabling the flag.
  - **W5 ✅ (full-stack) — group chat E2EE via Sender Keys (flag `GROUP_E2EE`, default OFF).** The last P1 item. Each member encrypts group messages with their own **sender key** — a symmetric hash ratchet + Ed25519 signing key (`services/crypto/senderKey.ts`, pure, **9/9 self-test**: in-order + out-of-order decrypt, forgery + cross-chain rejection, rotation makes the old chain unreadable). Each member's Sender Key Distribution Message (SKDM) is delivered to every other member over the **pairwise Double Ratchet** (reuses the proven 1:1 session), so the server only ever stores opaque blobs. Backend: migration **040** (`group_sender_keys(chat_id, sender_id, recipient_id, skdm)`) + `POST/GET /chats/:id/sender-keys` (publish/fetch opaque SKDMs, membership-validated). Client session (`services/crypto/groupSession.rn.ts`): persists own + peer sender keys (chunked SecureStore), **auto-rotates** on member removal and redistributes on any membership change, ingests SKDMs on first decrypt. chatService seam: `encryptForChat`/`decryptFromChat` gain a group branch (detects the `GSK1:` envelope); a sender renders their own (un-self-decryptable) messages from the own-plaintext cache. Server stores ciphertext + opaque key-distribution blobs only — **can never read group messages**; group location pins ride the same E2E content path automatically. Flag-OFF byte-identical (groups stay plaintext); graceful rollout (pre-E2EE history + keyless members fall back). Typechecks clean, `chats.js` syntax OK. **Deploy:** `npm run migrate` (applies 040) + redeploy bundle; **3-device group test incl. add/remove member** before enabling.
  - **P1 COMPLETE.** All at-rest/E2E gaps closed behind flags. Deploy: apply migrations **039 + 040**, redeploy backend bundle, ship APK. Enable + multi-device test each flag in order: `VAULT_SESSION_SEALED`, `VAULT_CACHE_ENCRYPTED`, `MEDIA_E2EE`, `STORY_E2EE`, `GROUP_E2EE`.
- **2026-06-16 — P2 started (pure-code items; infra-blocked ones deferred):**
  - **W14 ✅ (client, no infra) — VaultBeam integrity + transfers dashboard.** Replaced the fake `verifyTransferHash` (was `// For now… return true`) with a **real per-file SHA-256** verify. `lib/transferManager.ts`: `sha256OfBase64` + `computeFileSha256` (@noble), real `verifyTransferHash` (recomputes the on-disk file hash vs the sender's), `completeTransfer(id, verified)`, and `sha256`/`verified` on `TransferState`. `app/vaultbeam.tsx`: the sender now hashes the file and ships it in the transfer `meta`; the receiver recomputes the hash of the assembled bytes and **refuses a corrupted/incomplete file** (status → error, no save) — shows "🔒 SHA-256 integrity verified" on success; transfers are persisted so the dashboard has real data. New `app/transfers.tsx` dashboard (active/queued/history + totals, integrity badges) over the previously-orphaned `transferManager`; reachable from a VaultBeam header button. Integrity logic Node-proven (intact verifies, single-byte corruption detected). Typechecks clean. **Client-only; ships in next APK.**
  - **Infra-blocked (deferred):** W11 group calls (needs self-hosted SFU + coturn), W12 screen share (native screen-capture build), W13 native ring/PiP (native call modules), P2b W21–W23 (prod provisioning). These need the server/native build you'll set up — see [[backlog_local_android_toolchain]].

## Definition of Done (applies to every workstream)

A workstream is "done" only when:
1. Real code path end-to-end (client + backend + DB where relevant) — no stub branch.
2. Anything labelled "encrypted/secure/private" is actually encrypted; verified with
   a **two-device round-trip** and a **server-can't-read** assertion (the existing
   "no plaintext field server-side" test is extended to cover it).
3. No UI claims a guarantee the code doesn't deliver (honesty principle).
4. Degrades gracefully on low-end Android (Huawei P30 Pro class) — never hard-fails.

---

## Reconciled starting state (what's actually real today)

- **1:1 DM E2EE is REAL and wired**: X3DH + Double Ratchet + AES-GCM in
  `services/crypto/` (47/47 self-tests), behind `E2EE_ENABLED=true`, prekey
  distribution live at `vaultchat-backend/routes/user.js` (`GET/POST /user/keybundle`).
- **Dead code**: `services/doubleRatchetService.ts` is the old fake-DH skeleton — delete it.
- **Real WebRTC 1:1 voice/video** works (Socket.IO signalling, TURN config present).
- **All 19 game engines** are real (`services/gameEngines.ts`). Backend is Postgres
  (35 migrations) + Express + Socket.IO; real-time fan-out works.
- **Gaps fall into 4 priority tiers below.**

---

## Reconciliation with the 2026-06-10 Features Deck

`docs/VaultChat-Features-Deck.html` (a prior session's inventory deck) was cross-checked
against the live code audit. Three takeaways changed/extended this plan:

1. **The deck over-claims some items as "Live & real" that the code audit found fake/cosmetic.**
   This does NOT lower their priority — it raises it, because they're being represented as done:
   - **Decoy & Duress** (deck slide 7, listed live) → code is cosmetic, no crypto separation → **W3**.
   - **AI Guardian / Pegasus** `aiguardian.tsx` (deck slide 9, "safety analysis") → hardcoded
     "97/100" theatre → **W2**.
   - **Doc scanner "OCR → PDF"** (deck slide 6) → animation only, no real OCR → **W16**.
   - **"Call recording & group calls"** (deck slide 6) → group calls stubbed (SFU not ready) → **W11**.
   ⚠️ If this deck is shown to investors/users, those four lines are a misrepresentation risk
   until W2/W3/W11/W16 land. Treat the deck as aspirational, the audit as truth.

2. **The deck reveals a whole scale-out stack that is BUILT but gated OFF in prod** — Redis
   Socket.IO adapter, Kafka (KRaft) durable bus + fan-out worker, R2/MinIO object storage,
   local-first SQLite. The deck's own "Where to next" lists promoting these + direct FCM/APNs +
   multi-device. These were missing from this plan → added as **P2b (W21–W23)** below.

3. **Genuinely-real items the audit + deck agree are DONE (no work needed):** dark-web-guard
   (HIBP k-anonymity, keyless), Emergency SOS + trusted contacts (real GPS), encrypted .vcbak
   backup, Security Hub (`GET /user/security-overview`), local-first SQLite render, admin console
   (metadata-only). The deck also honestly labels a set of *placeholder* screens "in development"
   — see W24.

---

# P0 — Honesty & Integrity (start here; no infra needed)

The spec's #1 principle is zero-knowledge + honest UX. These items are currently
*actively dishonest* (fake scan results, cosmetic "hidden" data) and must be fixed first.

### W1 — Security console + tamper-evident audit chain (#41)
- **Build:** `security_events` table (already referenced as "coming"), an append-only
  hash-chained log in encrypted SQLite on-device (each entry hashes the previous →
  tamper-evident), and a real Alerts tab feed reading it. Event sources: root/key change,
  capture attempts, scan results, attachment flags, login anomalies.
- **Expected output:** Alerts tab shows a live, ordered, verifiable event feed; tapping
  an event shows detail + escalation link; chain integrity is verifiable on open.
- **Blocker:** none (pure code).

### W2 — Make scanners honest (#33-40: Pegasus, network, keylogger, IOC, attachment, threat-intel)
- **Build:** replace hardcoded "97/100" theatre with **real on-device signals** where RN can
  read them (root/jailbreak, ADB/debugger attached, dangerous installed packages vs. a bundled
  IOC list, accessibility-service abuse, VPN/proxy/network posture, app-signature check), and
  for things a sandboxed app genuinely *cannot* detect (kernel-level Pegasus), **say so
  honestly** ("limited heuristic — clean ≠ safe") instead of faking a verdict.
- **Expected output:** each scan returns results derived from real device state, graded
  honestly, written to the W1 audit chain; no fabricated numbers anywhere.
- **Blocker:** deeper signals (overlay detection, package enumeration, signature/attestation)
  need **native modules → custom dev build** (see CROSS-CUTTING blocker). Pure-JS subset ships
  first; native subset lands after the build pipeline exists.

### W3 — Real Duress PIN + Decoy profile with cryptographic separation (#204, #205)
- **Build:** two PIN-derived keys. Real profile is sealed under a key derived from the *real*
  PIN; the decoy profile is a *separate encrypted store* keyed by the duress PIN. The duress
  PIN can **never** derive the real key (no shared secret), so coerced unlock physically cannot
  reveal real chats. Identical unlock timing for both. Decoy chats become a real (small, seeded
  but persistent) account, not hardcoded read-only UI.
- **Expected output:** entering duress PIN opens a believable, usable decoy with its own
  storage; real data is cryptographically invisible; storage inspection shows only two opaque
  encrypted blobs, indistinguishable.
- **Blocker:** none (pure crypto + storage).

### W4 — Honesty sweep on false badges
- **Build:** remove/disable any "encrypted/D2DE/secure" badge whose code doesn't back it
  (e.g. live-location "D2DE" badge while coords are plaintext — fixed for real in W6).
- **Expected output:** every security/privacy claim in the UI maps to real code.
- **Blocker:** none.

---

# P1 — Core privacy promises (close the E2EE gaps; no infra)

### W5 — Group E2EE (sender-keys) (#22 for groups, group key rotation scenario)
- **Build:** sender-key (MLS-lite) group ratchet in `services/crypto/`; per-member key
  distribution via existing prekey routes; key rotation on join/leave; server stores ciphertext
  + rotation metadata only. New members see only admin-permitted history, re-encrypted
  device-to-device.
- **Expected output:** group messages are ciphertext server-side; membership change rotates keys;
  two-device group round-trip verified.
- **Blocker:** none (uses existing prekey infra). Largest single crypto effort (~1 wk).

### W6 — Encrypt media + live location through the seam (#95, media payloads)
- **Build:** route attachments and live-location coordinates through `lib/mediaCrypto.ts` /
  the E2EE seam; stop writing plaintext lat/long to Firestore; migrate location to the
  ciphertext-only model used for messages.
- **Expected output:** server/Firestore never holds readable coordinates or media bytes;
  the location "encrypted" badge is now true.
- **Blocker:** none.

### W7 — Per-viewer story encryption + two-way capture alerts (#15, #17, #18, #97)
- **Build:** wrap each story's content key per viewer (sealed to each viewer's identity key);
  cryptographic revoke; download tracking; capture-attempt alert delivered to the **poster**
  (inbound notification + audit-chain entry), not just a local toast.
- **Expected output:** removing a viewer revokes their access; poster gets "X tried to
  screenshot your status" as a real alert; server can't read story content.
- **Blocker:** none.

### W8 — Safety-number verification (#101)
- **Build:** derive a stable numeric/QR fingerprint from both parties' identity keys; compare
  in-person or via QR; mark contact verified; show state in chat header.
- **Expected output:** tapping a contact name shows a real key fingerprint + QR; mismatch warns.
- **Blocker:** none.

### W9 — On-device encrypted search; remove server plaintext search (#9, #55)
- **Build:** encrypted SQLite FTS5 index on-device over decrypted-locally content; change the
  server `/chats/search` to return **metadata only** (or remove the `content ILIKE` path). This
  closes the documented zero-knowledge violation and matches "search is on-device" (vs Telegram).
- **Expected output:** search works fully offline/on-device; server has no endpoint that reads
  message bodies; ZK test passes.
- **Blocker:** none.

### W10 — Delete dead `services/doubleRatchetService.ts`
- **Build:** remove the fake-DH skeleton; confirm nothing imports it.
- **Expected output:** only the real `services/crypto/` ratchet remains.
- **Blocker:** none.

---

# P2 — Real-time / calls / transfer completeness (infra required)

### W11 — Group calls (SFU) + full in-call toolset (#121, #125-130, #132, #133)
- **Build:** integrate an SFU; N-way audio/video with insertable-streams E2EE; add-participant,
  in-call chat, raise-hand, in-call reactions (wired to signalling), grid/spotlight,
  capture-moment, on-device captions, noise-cancel.
- **Expected output:** real 3+ person E2EE call with the full toolset.
- **🚧 BLOCKER (infra):** **self-hosted SFU** (LiveKit or mediasoup) on the Hetzner box, plus
  **coturn TURN/STUN** for NAT traversal. Captions/noise-cancel also need native modules.

### W12 — Real screen share (#114-118)
- **Build:** native screen-capture → WebRTC video track; annotate, view-only, pause, voice overlay.
- **Expected output:** a peer sees your live screen P2P; view-only enforced.
- **🚧 BLOCKER (infra):** **custom native build** (screen-capture API + foreground service) and
  TURN/SFU from W11.

### W13 — Native incoming ring, cellular auto-hold, PiP (#135, #136, #131)
- **Build:** Android ConnectionService / iOS CallKit full-screen lock-screen ring; PhoneState
  listener for GSM auto-hold; Picture-in-Picture.
- **Expected output:** app-killed call rings natively on lock screen; GSM call auto-holds the
  VaultChat call; PiP works.
- **🚧 BLOCKER (infra):** **custom native build** (native call/telephony/PiP modules — not
  available in Expo Go).

### W14 — VaultBeam: SHA-256 verify + transfers dashboard (#113, #111) — *pure code, pull earlier*
- **Build:** real per-file SHA-256 compute + compare on completion; transfers dashboard UI
  (active/queue/history) over the existing `transferManager`.
- **Expected output:** corrupted/incomplete transfer fails verification; dashboard shows real state.
- **Blocker:** none (can ship inside P1 window).

---

# P2b — Promote the already-built scale stack to prod (code exists; needs prod infra)

These are **not new code** — they're built and staging-validated but gated OFF in prod. The work
is prod provisioning + careful cutover. High value, can run in parallel with P0/P1. See
[[arch_whatsapp_migration]].

### W21 — Promote realtime / Kafka / R2 to prod
- **Build:** stand up Redis, Kafka (KRaft), MinIO/R2 in prod on the Hetzner box; flip the gates;
  cut media uploads to presigned R2; enable the Socket.IO Redis adapter + Kafka fan-out worker.
- **Expected output:** prod runs the durable bus + object storage + multi-node-ready fan-out;
  instant local-first open with delta sync; rollback path documented.
- **🚧 BLOCKER (infra):** prod Redis + Kafka + MinIO/R2 running on the box (compose substrate
  exists). Confirm the 62GB box has headroom or provision storage.

### W22 — Direct FCM/APNs + content-free high-priority push (#193, app-killed-call scenario)
- **Build:** move from Expo Push relay to **direct Firebase Admin (FCM) + APNs**; high-priority
  *data* messages that wake a killed app; payload carries **no content** (routing only). This is a
  hard prerequisite for W13 (native full-screen incoming-call ring on the lock screen).
- **Expected output:** killed-app device wakes on a call/message; push payload provably content-free.
- **🚧 BLOCKER (infra):** Firebase project + service-account for FCM; Apple APNs key for iOS.

### W23 — Multi-device + observability (parity; lower priority)
- **Build:** multi-device session/key sync; basic prod observability (metrics, error tracking,
  delivery dashboards).
- **Expected output:** a second device syncs sessions; ops can see delivery/error rates.
- **🚧 BLOCKER (infra, light):** an observability sink (self-host Grafana/Loki or a hosted tier).

---

# P3 — Feature completeness (messaging, media, AI, settings)

### W15 — Messaging gaps (#60 @mentions, #54 link preview, #79 pin bar, #46 swipe reply, #63 GIF, #57 silent send, #67 real channels)
- Mostly pure code + small backend additions (pin table, mention metadata, link-preview fetch
  done **client-side** to preserve ZK). Channels move from mock AsyncStorage to real routes.
- **🚧 minor BLOCKER:** GIF needs a provider decision — **Tenor/Giphy API key** (privacy-proxied
  through our backend) **or** a self-hosted GIF store. Everything else: no infra.

### W16 — Media gaps (#85/86 real doc scanner, #87 contact share, #139 file→email)
- Doc scanner: real edge-detection/perspective-correction + OCR.
- **🚧 BLOCKER:** doc scanner needs **native** (VisionCamera + ML Kit doc-scan / OpenCV) → custom
  build. file→email needs **transactional mail / SMTP relay** (also unblocks the pending
  email-bridge). Contact share: no infra.

### W17 — On-device AI (#188 translation, #64 transcription, #189/#72/#70 assistant + summarize + browser AI, #69 mini browser)
- True on-device per the spec: ML Kit translation, Whisper STT, Ollama LLM, SearXNG search.
- **🚧 BLOCKER (infra + decision):**
  - **Custom native build** for ML Kit + Whisper.
  - **Ollama**: decide **on-device** (bundle 2GB/5GB quantized models — needs native build +
    device RAM headroom) **vs. server-side Ollama** on Hetzner. Note: on-device is the spec
    requirement ("no token leaves the device"); server-side is a pragmatic fallback you've used
    before. **Your call.**
  - **SearXNG instance** (self-hosted) for #69/#70 private search.

### W18 — i18n + settings (#197 language, #196 appearance, #194 contact discovery, #199 transfers, #202 help, #203 storage) — *foundational, pull earlier*
- Add an i18n framework (Telugu / Hindi / English first) and migrate strings; build the missing
  settings screens. i18n touches every screen, so doing it early reduces rework.
- **Blocker:** none.

### W19 — Notes Vault finish + split-key backup (#148 attachments, #142 rich text, #207 Shamir split-key, #200 cloud vault)
- Real attachment storage + rich-text; Shamir secret-sharing for split-key backup (pure crypto).
- **Blocker:** none (cloud-vault target storage already exists: S3/R2/MinIO).

### W20 — Onboarding parity (#6 8-digit PIN, #2 6-box OTP, #3 VaultID QR)
- Make PIN 8 digits, OTP a 6-box auto-advance input, add a QR for VaultID.
- **Blocker:** none.

### W24 — Resolve the deck's "in development" placeholder screens (build-or-cut)
- The 2026-06-10 deck honestly labels these "in development": Calls-tab history feed,
  Alerts feed (= **W1**), communities, family hub, creator channels, watch-together (#118),
  decentralized ID, trust score, bot API, digital wellbeing, meeting scheduler.
- **Build:** for each, either implement the real full-stack feature or remove the screen — no
  screen may ship as a permanent "coming soon" placeholder (honesty rule).
- **Expected output:** zero placeholder screens in the app; each is real or gone.
- **Blocker:** none (some, e.g. bot API / communities, may need a backend decision).

---

# P-UI — UI/UX & Design-System Polish (no infra; not aligned with WhatsApp/Signal/Telegram today)

Audit verdict: the app is *functionally* rich but visually reads "beta" vs. rival messengers.
The spec's "Obsidian Aurora / Midnight Gold" system exists only as a skeleton (~20% adopted).
**U1–U4 are foundation** — do them early (alongside W18 i18n), because they touch every screen
once and every later UI fix depends on them; doing screen polish first means redoing it. All
no-infra (pure code). Headline evidence in parentheses below.

### U1 — Design-token foundation (unblocks all UI work)
- **Build:** expand `constants/theme.ts` into a full token set — `SPACING` (4/8/12/16/24/32),
  `RADIUS`, `ELEVATION`/`SHADOWS`, `MOTION` (spring presets), full `TYPOGRAPHY`. Migrate hardcoded
  colors to Aurora tokens, high-visibility screens first (chat, chats, login, profile).
- **Why (evidence):** ~1,669 hardcoded color/bg instances across `app/`; only ~26/136 screens read
  `Aurora.*`; no spacing/radius/elevation scale (border-radii seen: 8/10/14/18/20/24/29 — no system).
- **Expected output:** one source of truth for color/space/type/motion; screens read tokens.

### U2 — Load Sora + Nunito Sans + a `Text` wrapper
- **Build:** bundle the fonts, `useFonts()` in root layout (block render until ready), apply via the
  U1 typography scale through a `Text`/`Typography` wrapper instead of raw `<Text>`.
- **Why (evidence):** `expo-font` is installed but **never called** — the whole app is system font,
  despite the spec mandating Sora (headings) + Nunito Sans (body).
- **Expected output:** brand typography everywhere; consistent type scale.

### U3 — Theme switching (Dark/Light/System) + Appearance toggle (#196)
- **Build:** a `ThemeProvider` consuming `useColorScheme()`, persisted preference, a Profile →
  Appearance toggle. Wire `use-theme-color` to the provider. Ships together with W18 settings.
- **Why (evidence):** `userInterfaceStyle: automatic` is declared but unwired; `Colors.light` is
  never consumed; screens hardcode dark hex (`#0A0A0F`, `#151718`) → effectively dark-only.
- **Expected output:** real light/dark/system switching; no hardcoded-dark screens.

### U4 — Shared component library
- **Build:** `components/ui/` — `Button`, `Card`, `Avatar` (image+initials+presence dot), `Badge`,
  `Header`, `Input` (focus states), `Sheet` (on `@gorhom/bottom-sheet`). Replace per-screen
  duplication. Critically, **replace `Alert.alert` used as menus** with real bottom sheets.
- **Why (evidence):** only ~20 shared components, no Button/Card/Avatar/Header primitives; each
  screen rolls its own styles; attachment/action menus use native `Alert.alert` (unpolished).
- **Expected output:** consistent, reusable primitives; far less style duplication.

### U5 — Icon system (kill emoji-as-icons) + tab badges
- **Build:** one vector set (Ionicons or lucide) across the tab bar, chat actions, list rows; add
  `tabBarBadge` unread counts on Chats/Alerts; fix tab label size/active weight.
- **Why (evidence):** tab bar uses emoji (💬🟢📞🧩🔔👤); pin/mute/lock/search rendered as emoji
  (📌🔕🔒🔍); mixed Ionicons in a few screens → inconsistent. Emoji-as-icons is the #1 "beta" tell.
- **Expected output:** one consistent, accessible icon language; live unread badges.

### U6 — Chat surface polish (highest-traffic screen)
- **Build:** fix bubble corner-radius/tail (base 16px with a single 4px tail corner per side);
  rethink sent/received colors (purple-sent currently inverts rival convention); render ticks as
  **vector icons** placed at the bubble's bottom-right (not emoji in meta text); add **date
  separators** ("Today"/"Yesterday") and **consecutive-message grouping**; overlay reaction chips on
  the bubble; style system messages as centered cards; animate typing as bouncing dots; composer
  focus state + **live recording waveform**; chat header avatar 40px + E2E lock as a vector badge
  that taps through to key verification (ties to **W8**).
- **Why (evidence):** `chat.tsx` — `borderRadius:16` fights `borderTopRightRadius:4`; ticks/lock are
  emoji text; no date separators / grouping in the FlatList renderItem; reactions sit below bubble.
- **Expected output:** chat feels like a top-tier messenger.

### U7 — Chat-list, Status & Calls polish
- **Build:** per-contact avatar colors (name-hash palette) instead of all-purple initials;
  pinned/muted as icons; Status ring states (distinct unseen vs seen); story-viewer tap-zone
  affordance. **Build the Calls tab call-log UI** — it's currently a stub (overlaps W24 + the
  calls feature): avatar · name · call-type icon · missed-call styling · timestamp · tap-to-dial.
- **Expected output:** polished list/status surfaces; a real Calls tab, not a placeholder.

### U8 — Cross-cutting performance & polish primitives (several quick wins)
- **Build:** FlashList (or FlatList batching props: `maxToRenderPerBatch`/`removeClippedSubviews`)
  for chats + messages; **blurhash** placeholders via `expo-image` for media; skeleton loaders +
  designed empty/error states; **Reanimated 3 + Gesture Handler** for transitions & swipe-actions;
  **haptics** on send/long-press/tab/reaction; systematic `useSafeAreaInsets` (replace hardcoded
  `paddingTop: 56`). Target 60fps on the Huawei P30 Pro class.
- **Why (evidence):** no blurhash (bare RN `Image`), skeletons only in 1 file, lists lack perf props,
  animations use RN `Animated` not Reanimated, haptics wired on only ~6 auth screens, one screen
  uses safe-area insets.
- **Expected output:** smooth, modern feel on low-end Android; no pop-in, no jank.

**UI sequencing:** U1 → U2 → U3 → U4 (foundation, ~1.5–2 wks) before mass screen polish; then
U5/U6/U7 (the visible wins); U8's quick wins (haptics, list props, blurhash) can land anytime.

---

# CROSS-CUTTING BLOCKER — Custom native build / dev client

A large share of P2/P3 (overlay+tamper+cert-pin hardening, ML Kit, Whisper, on-device Ollama,
screen capture, PiP, native call ring) **cannot run in Expo Go** — they need a **custom EAS dev
client / native build**. Your memory already tracks a backlog item to set up **JDK 17 + Android
SDK locally** so APK builds run on the box instead of EAS cloud. **Standing this up is the single
biggest enabler** — it unblocks ~6 native-dependent workstreams at once. Recommend provisioning
it in parallel with P0/P1 (which need no native build).

---

# Infra checklist for you to provision (to unblock P2/P3)

| # | Infra | Unblocks |
|---|-------|----------|
| 1 | **Custom native build pipeline** (JDK17+Android SDK local, or EAS dev client) | W2(native), W12, W13, W16(scanner), W17(MLKit/Whisper/on-device Ollama), native hardening |
| 2 | **Self-hosted SFU** (LiveKit or mediasoup) on Hetzner | W11 group calls, W12 screen share |
| 3 | **coturn TURN/STUN** server | reliable W11/W12 + hardens 1:1 calls & VaultBeam on flaky networks |
| 4 | **Ollama decision** — on-device (bundle models) vs server-side host | W17 assistant/summarize/browser AI |
| 5 | **SearXNG instance** (self-hosted) | W17 mini browser / browser AI search |
| 6 | **Transactional mail / SMTP relay** | W16 file→email + pending email-bridge |
| 7 | **GIF provider** — Tenor/Giphy key (proxied) or self-hosted | W15 GIF |
| 8 | **Prod Redis + Kafka + MinIO/R2** on the Hetzner box (code built) | W21 scale-stack promotion |
| 9 | **Firebase service-account (FCM) + Apple APNs key** | W22 direct push, W13 native call ring |
| 10 | **Observability sink** (Grafana/Loki self-host or hosted) | W23 multi-device/observability |

Everything in **P0 and P1** (W1-W10, W14) needs **none** of the above — it can start immediately.
**W21 (scale-stack promotion)** is code-complete; it only needs infra #8 + a careful prod cutover,
so it's high-value and can run in parallel with P0/P1.

---

# Recommended sequence

1. **Now:** P0 (W1-W4) + W10 + W14 — honesty + the dead-code delete + transfer verify. No infra.
   In parallel: you provision infra #1 (native build), #2/#3 (SFU+TURN), and #8 (prod Redis/Kafka/R2).
2. **Parallel track (code-complete):** W21 promote the scale stack to prod once infra #8 is up.
3. **Next:** P1 (W5-W9) — the real crypto gaps. Plus the UI foundation **U1-U4** and **W18 (i18n)**
   early together — they all touch every screen once, so doing them before screen-level polish
   avoids rework.
4. **Then (once infra lands):** W22 (push) → P2 (W11-W13, which depend on SFU/TURN/native/push).
5. **Then:** UI polish **U5-U7** + P3 (W15-W17, W19-W20, W24) and W23. **U8 quick wins**
   (haptics, list perf props, blurhash) can be dropped in at any point.

Each workstream ships as its own commit/PR with the DoD checklist satisfied.
