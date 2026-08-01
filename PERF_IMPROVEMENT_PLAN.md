# VaultChat — Performance Improvement Plan

_Execution plan derived from `PERF_AUDIT.md`. No code — objectives, sequencing, approach, effort, risk, rollback, and success metrics. Every initiative is anchored to real files. Effort is in engineer-weeks (ew) for one engineer; risk is Low/Med/High._

---

## A. Principles this plan follows

1. **Measure before and after every change.** No initiative ships without a captured baseline and a target KPI (Section B). "Faster" is not a result; a number is.
2. **Backend-only before app-release.** Server changes (scaling, fan-out, DB) need no app store round-trip and roll back via a proxy flip — do them first for fast, reversible wins.
3. **Ship crypto behind a flag, gated by parity tests.** The existing self-tests (`services/crypto/*.selftest.ts`, `parity.selftest.ts`) are the correctness gate for any crypto change.
4. **One class-change first.** The single-node realtime ceiling (H1) is the only change that alters what the system *can* do rather than how fast it does it — it leads.
5. **Delete before optimize.** Redundant stacks (Node twin, Firestore, Supabase, dead TF.js) are removed, not tuned.

---

## B. Baseline KPIs — capture these FIRST (Phase 0)

You cannot claim the savings in the audit without these baselines. Capture on a low-end Android (e.g. a 3–4 GB RAM device) and a mid iPhone.

| KPI | How to measure | Baseline target to record |
|---|---|---|
| Cold start (TTI) | Hermes startup marker → first interactive frame; `lib/perf.ts` marks + Perfetto/Systrace | ms |
| JS thread frame drops on chat scroll | Perfetto / Flipper / Hermes sampling profiler, scroll a 500-msg thread | % frames >16.7ms |
| Message decrypt time (per bubble) | instrument `e2eeSession.rn.ts` decrypt path | ms/msg, JS thread |
| Vault unlock time | instrument `services/security/vaultKeys.ts` scrypt call | ms (blocking) |
| Peak JS heap on 200 MB encrypted media send | Hermes heap snapshot around `lib/mediaAttachments.ts:24` | MB |
| Bundle size (Hermes bytecode) | `expo export` output per platform | MB |
| Install size | built APK/IPA | MB |
| Backend: concurrent sockets/node | load test (`vaultchat-backend/loadtest/sockets.js` exists) | connections at first failure |
| Backend: p50/p99 message send→deliver | server timing + client receipt | ms |
| Backend: DB queries per message sent | pg_stat_statements around `delivery.go:62` | count |

**Deliverable of Phase 0:** a one-page dashboard of the 11 numbers above. Everything after is measured against it.

---

## C. Phased roadmap (sequenced)

### Phase 0 — Instrumentation & guardrails _(0.5 ew, Low risk) — do first_
- Stand up the KPI dashboard (Section B).
- Add a CI size-budget check on the Hermes bundle so cleanup gains don't silently regress.
- Confirm the crypto parity self-tests run in CI as a gate.
- **Exit criteria:** all 11 baselines recorded; CI gates live.

### Phase 1 — Client quick wins _(1.5–2 ew, Low risk) — no backend dependency_
Cheap, reversible, immediately felt. Can ship in one app release.
- **P1.1** Enable React Compiler.
- **P1.2** Fix chat-list re-render/network storm.
- **P1.3** Fix the `d2deService` fake-E2EE defect (security — do not defer for being in "phase 1"; it's here only because it's client-side and small).
- **P1.4** Fix memory leaks (intervals/timers not cleared).
- **P1.5** Tune op-sqlite PRAGMAs.
- **Exit criteria:** scroll frame-drops and list re-render count down vs baseline; unlock/DB writes measurably faster; leaks gone under a mount/unmount stress loop.

### Phase 2 — Backend scale unblock _(3–4 ew, Med/High risk) — backend only, no app release_
The class change. Everything here rolls back with a proxy/replica-count flip.
- **P2.1** Socket.IO Redis adapter + externalize presence/roster/games to Redis.
- **P2.2** Async fan-out + unread + push (worker pool / Kafka), membership cached in Redis, goroutine caps.
- **P2.3** PgBouncer + pool sizing.
- **Exit criteria:** two Go replicas serve one logical system correctly (presence/calls/fan-out cross-node) behind a canary; DB queries-per-message down; sockets-per-cluster scales with replica count.

### Phase 3 — Memory ceiling & native crypto _(5–7 ew, Med/High risk)_
Removes the OOM crash class and moves the crypto hot path off the JS thread.
- **P3.1** Stream chat-media crypto through existing native chunk primitives.
- **P3.2** Offload scrypt/PBKDF2 off the JS thread (worker now; native in P3.3).
- **P3.3** Activate Rust crypto-core: build the missing iOS binding, replace hex/JSON FFI with a binary boundary, flip default to `rust` behind the flag.
- **P3.4** Move the per-message ratchet + serialization into Rust.
- **Exit criteria:** 200 MB+ encrypted media send no longer OOMs and peak JS heap is flat vs file size; per-bubble decrypt time and unlock time down 5×+; parity tests green on both platforms.

### Phase 4 — Data tier & storage at scale _(3–5 ew, Med/High risk)_
- **P4.1** Partition Postgres `messages`; add `LIMIT`+loop to unbounded sweeps.
- **P4.2** Encrypted FTS5 search (blind-index) + message-cache eviction policy.
- **P4.3** Index the mutation-delta query; raise/paginate the 20k global-cursor catch-up cap.
- **Exit criteria:** synthetic 1B-row `messages` keeps chat-open + history queries flat; search is index-backed, not O(all-local); catch-up completes for a long-offline busy account.

### Phase 5 — Consolidation & cleanup _(2–3 ew, Med risk — verify orphaned first)_
- **P5.1** Delete Node backend + `server/` (keep rollback tag).
- **P5.2** Remove Firebase/Firestore path + shims + rules/indexes.
- **P5.3** Drop unused deps: Supabase, expo-sqlite (for messaging), dead TF.js models, `faceRecognitionService`.
- **P5.4** Lazy-load `ethers`/QR and other route-only heavy libs.
- **Exit criteria:** bundle + install size down 8–20 MB vs baseline; no runtime regression (Firestore path proven dead before deletion).

### Phase 6 — Reach features _(6–10 ew, High risk — new infra)_
- **P6.1** SFU (LiveKit/mediasoup) for group calls >5-6; enforce mesh cap server-side.
- **P6.2** HTTP/3 + QUIC at Caddy for REST (keep WS for realtime).
- **P6.3** CDN + presigned direct-to-storage for all media (extend the pattern chat media already uses).
- **P6.4** Protobuf/MessagePack wire + ratchet-state format.
- **Exit criteria:** 8-person group call stable on mid-tier phones; media bytes never transit the API; message wire size down 20–40%.

---

## D. Dependency & sequencing map

```
Phase 0 (instrument) ──► everything (gates all claims)

Phase 1 (client quick wins) ── independent, parallel to Phase 2
        P1.3 (d2de security) ── standalone, can ship immediately

Phase 2 (scale) ─ P2.1 Redis adapter ──► P2.2 async fan-out ──► P2.3 PgBouncer
                     (unlocks N replicas; prerequisite for real load testing)

Phase 3 (memory/crypto)
   P3.1 media streaming ── independent
   P3.2 KDF worker ──► P3.3 Rust core (iOS binding + binary FFI) ──► P3.4 ratchet in Rust
                          (P3.3 needs iOS binding BEFORE default flip)

Phase 4 (data) ── benefits from Phase 2 (replicas/PgBouncer) but P4.1 partitioning independent

Phase 5 (cleanup) ── AFTER Phase 2 proves Go path owns everything (so deleting Firestore/Node is safe)

Phase 6 (reach) ── AFTER Phase 2 (SFU signalling rides the scaled hub)
```

**Critical path to "world-class scale":** Phase 0 → P2.1 → P2.2 → P4.1. **Critical path to "no crashes / smooth":** Phase 0 → P1.1 → P3.1 → P3.3.

---

## E. Per-initiative cards

Each card: Objective · Why · Approach (no code) · Files · Effort · Risk · Rollback · Success metric.

### P1.1 — Enable React Compiler
- **Objective:** auto-memoize the render tree; cut wasted re-renders app-wide.
- **Why:** `babel-plugin-react-compiler` is a dependency but `app.json:14` `reactCompiler:false` and `babel.config.js` omits it — the team already hand-writes the comparators it would generate (`chat.tsx:4356`, `chats.tsx:599`).
- **Approach:** turn it on in Expo config + babel preset option; run the app's interaction suite; watch for compiler bailouts on the two big screens and resolve any rules-of-hooks violations it surfaces.
- **Files:** `app.json`, `babel.config.js`.
- **Effort:** 0.3 ew · **Risk:** Low (compiler is conservative; bails rather than miscompiles).
- **Rollback:** flip the flag off.
- **Success metric:** re-render count on chat/list screens down; scroll frame-drops down vs baseline.

### P1.2 — Chat-list re-render / network storm
- **Objective:** a single inbound message updates one row, not the whole list.
- **Why:** `app/(tabs)/chats.tsx:176-178` calls `fetchList()` on every socket event, replacing all chat objects with new identities (`:84-85`) — defeats the `ChatRow` memo (`:603`) and re-runs `syncAllHistory` (`:89`) each time.
- **Approach:** apply the socket delta to the affected chat in place, preserving object identity for untouched rows; decouple history sync from per-message events (debounce or event-scope it).
- **Files:** `app/(tabs)/chats.tsx`.
- **Effort:** 0.5 ew · **Risk:** Low-Med (ordering/unread-count correctness).
- **Rollback:** revert to `fetchList`.
- **Success metric:** list re-renders per inbound message ≈1 row (was whole list); no redundant `syncAllHistory` per message.

### P1.3 — d2de fake-E2EE fix _(security)_
- **Objective:** stop deriving an "E2EE" key that anyone with two UIDs can reproduce.
- **Why:** `services/d2deService.ts:19-30` derives the key from `vaultchat-v1-${sortedUIDs}` + static salt — no secret input; advertises "Double Ratchet / X3DH" (`:82-90`).
- **Approach:** route d2de through the real X3DH/Double-Ratchet session already implemented (`services/crypto/e2eeSession.ts`), or remove the feature. Version the ciphertext/field format for migration.
- **Files:** `services/d2deService.ts`, `services/crypto/e2eeSession.ts`.
- **Effort:** 0.7 ew · **Risk:** Med (format/migration).
- **Rollback:** feature flag; keep reading old format during migration window.
- **Success metric:** key material no longer derivable from public identifiers; parity tests pass.

### P1.4 — Memory leaks
- **Objective:** no timers/subscriptions firing after unmount.
- **Why:** countdown interval not cleared (`app/emergency-sos.tsx:170`), typing timers not cleared (`app/(tabs)/chats.tsx:167-169`), always-on module flushers (`lib/mediaOutbox.ts:183`, `lib/messageQueue.ts:326`).
- **Approach:** clear intervals/timeouts in effect cleanup; gate module-level flushers on connectivity/foreground.
- **Files:** as above.
- **Effort:** 0.3 ew · **Risk:** Low.
- **Rollback:** trivial.
- **Success metric:** mount/unmount stress loop shows flat retained heap; no "setState on unmounted" warnings.

### P1.5 — op-sqlite PRAGMA tuning
- **Objective:** cut fsync stalls and `SQLITE_BUSY`; speed reads.
- **Why:** opened WAL-only (`lib/localDb.ts:61,73`); missing `synchronous`, `busy_timeout`, `mmap_size`, `cache_size`, `temp_store`; per-message `runAsync` inserts (`:138-165`).
- **Approach:** add `synchronous=NORMAL`, `busy_timeout=5000`, `mmap_size≈256 MB`, `cache_size`, `temp_store=MEMORY` at open; convert batch upsert to multi-row insert.
- **Files:** `lib/localDb.ts`.
- **Effort:** 0.4 ew · **Risk:** Low (`NORMAL` is WAL-safe).
- **Rollback:** revert pragmas.
- **Success metric:** sync-batch write time down; no `SQLITE_BUSY` under catch-up load.

### P2.1 — Socket.IO Redis adapter + external presence
- **Objective:** allow >1 Go replica; make the system horizontally scalable.
- **Why:** `internal/realtime/server.go:8` — in-process fan-out; presence/roster/games in process memory (`:60-67`); `hasLiveSocket`/`callRoster` assume single node (`:207-211`, `handlers.go:317`). This is the hard ceiling.
- **Approach:** enable `zishang520/socket.io-go-redis` (wire-compatible with the Node adapter the stack already used); move presence, call rosters, and game rooms into Redis with TTLs; make roster/`hasLiveSocket` cross-node queries.
- **Files:** `internal/realtime/server.go`, `cmd/api/main.go:78-87`, `internal/redisx/`.
- **Effort:** 2 ew · **Risk:** High (cross-node semantics; call rooms).
- **Rollback:** run a single replica (in-process path unchanged); adapter is additive.
- **Success metric:** two replicas behind a canary — users on different nodes see presence, share calls, receive fan-out; no correctness regression.

### P2.2 — Async fan-out, unread, push
- **Objective:** take multi-query-per-message off the request goroutine.
- **Why:** `FanOutToChat` runs members-query + blocks-query + `vc_bump_unread` + push-query per message (`internal/realtime/delivery.go:62,79`); presence flips do a `DISTINCT` self-join each (`presence.go:96`); unbounded goroutine spawns (`presence.go:38,60`, `chats_helpers.go:427,434`).
- **Approach:** cache chat membership in Redis (invalidate on membership change); move fan-out/unread/push to a bounded worker pool or the disabled Kafka `EVENT_BUS`; cap goroutines.
- **Files:** `internal/realtime/delivery.go`, `presence.go`, `chats_helpers.go`.
- **Effort:** 1.5 ew · **Risk:** Med (delivery ordering, at-least-once semantics).
- **Rollback:** synchronous path behind a flag.
- **Success metric:** DB queries per message ↓ (target ≤1 write + cache hit); goroutine count bounded under a reconnect storm.

### P2.3 — PgBouncer + pool sizing
- **Objective:** survive many app processes without exhausting Postgres connections.
- **Why:** pool default 30 (`internal/db/db.go:57`), no PgBouncer (compose TODO never done); `db.WithUser` opens a txn per RLS read (`db.go:27-44`) → 3× round-trips.
- **Approach:** add PgBouncer (transaction pooling); right-size pools; batch RLS reads within one txn or cache RLS context.
- **Files:** `docker-compose.yml`, `internal/db/db.go`.
- **Effort:** 0.7 ew · **Risk:** Med (prepared-statement mode vs transaction pooling).
- **Rollback:** direct connections.
- **Success metric:** Postgres connection count flat as replicas scale; read round-trips per RLS query down.

### P3.1 — Streaming chat-media crypto
- **Objective:** eliminate the ~4× JS-heap blow-up and OOM ceiling on encrypted media.
- **Why:** `lib/mediaAttachments.ts:24-28` whole-file base64 + GCM + base64 write; same on encrypted download (`:53-57`, `:104-108`) and every multipart part (`lib/resumableUpload.ts:142`). The native module already exposes `readCipherChunk`/`writeCipherChunk` (VaultBeam).
- **Approach:** re-route media encrypt/decrypt/upload-part through the native offset-streaming primitives instead of `readAsStringAsync({base64})`; add integrity hashing (VaultBeam already hashes; chat media doesn't).
- **Files:** `lib/mediaAttachments.ts`, `lib/mediaCrypto.ts`, `lib/resumableUpload.ts`.
- **Effort:** 1.5 ew · **Risk:** Med (correctness across tiers; test large files).
- **Rollback:** flag-gated; JS path remains.
- **Success metric:** 200 MB+ encrypted send peak JS heap flat vs file size; no OOM; throughput ≥ current.

### P3.2 — KDF offload (interim, non-native)
- **Objective:** stop scrypt/PBKDF2 blocking first paint / unlock before Rust lands.
- **Why:** scrypt N=2^14 runs synchronously on unlock, twice on setup (`services/security/vaultKeys.ts:24-31`); PBKDF2-100k on first Vault op (`lib/vaultCrypto.ts:18-25`).
- **Approach:** move to a worklet/worker thread now; replaced by native in P3.3.
- **Files:** `services/security/vaultKeys.ts`, `lib/vaultCrypto.ts`.
- **Effort:** 0.6 ew · **Risk:** Low-Med.
- **Rollback:** synchronous path.
- **Success metric:** unlock no longer blocks the UI thread; measured unlock latency unchanged or better.

### P3.3 — Activate Rust crypto-core (both platforms)
- **Objective:** make native crypto actually reachable, including iOS, and default-on.
- **Why:** `services/crypto/index.ts:68` defaults to `ts`; flag `=rust` never set; core is Android-only (no `crypto-core-ios`), silently skipped without `cargo-ndk` (`plugins/withCryptoCore.js:45-53`); FFI marshals hex+JSON (`CryptoCore.ts:63,83`).
- **Approach:** add `plugins/crypto-core-ios` mirroring `vaultbeam-core-ios`; make prebuild fail loudly without `cargo-ndk`; replace hex/JSON boundary with binary; flip default to `rust`, `ts` as fallback.
- **Files:** `plugins/withCryptoCore.js`, new `plugins/crypto-core-ios`, `services/crypto/native/CryptoCore.ts`, `services/crypto/index.ts`.
- **Effort:** 2.5 ew · **Risk:** High (build system + crypto correctness).
- **Rollback:** flag back to `ts`.
- **Success metric:** parity tests green on iOS+Android with `rust` backend; per-op crypto time 5–30× faster.

### P3.4 — Ratchet + serialization in Rust
- **Objective:** move the per-message hot path (runs per visible bubble on scroll) off JS.
- **Why:** `e2ee.ts:206-263` per-message HMAC/HKDF/AES-GCM + `serializeState` hex+JSON churn (`:266`), multiplied on scroll.
- **Approach:** use the vector-proven `rust/src/e2ee.rs`/`sender_key.rs`; binary ratchet-state; deterministic zeroize.
- **Files:** `services/crypto/e2ee.ts` (delegates), Rust core.
- **Effort:** 1.5 ew (after P3.3) · **Risk:** Med.
- **Rollback:** TS ratchet behind flag.
- **Success metric:** per-bubble decrypt time down 5×+; JS-thread crypto time on scroll near zero.

### P4.1 — Partition `messages` + bound sweeps
- **Objective:** sustain billions of rows without heap/vacuum collapse.
- **Why:** single unpartitioned `BIGSERIAL` heap; unbounded `DELETE FROM messages/stories` sweeps (`internal/jobs/jobs.go:75,194`).
- **Approach:** range-partition by `created_at` (or hash by `chat_id`) with online backfill/dual-write; add `LIMIT`+loop to sweeps.
- **Files:** migrations, `internal/jobs/jobs.go`.
- **Effort:** 2 ew · **Risk:** High (online migration of a live hot table).
- **Rollback:** partitioning is forward-only; stage on a replica first.
- **Success metric:** chat-open + history queries flat at synthetic 1B rows; sweep locks bounded.

### P4.2 — Encrypted FTS + cache eviction
- **Objective:** index-backed search that respects at-rest encryption; bound local cache.
- **Why:** search is JS `.includes()` over ≤5000 decrypted rows (`localDb.ts:214-236`), lossy and O(all-local); `messages` cache has no eviction.
- **Approach:** FTS5 over a client-tokenized blind-index column (trigram/HMAC token) so plaintext never lands in the index; add LRU/size cap eviction to the message cache.
- **Files:** `lib/localDb.ts`, `lib/cacheCrypto.ts`.
- **Effort:** 1.5 ew · **Risk:** Med (search recall vs privacy trade-off).
- **Rollback:** keep JS search as fallback.
- **Success metric:** search latency independent of cache size; recall ≥ current (no 5000-row cap); cache size bounded.

### P4.3 — Delta-sync robustness
- **Objective:** busy/long-offline accounts fully catch up; mutation sync not dropped.
- **Why:** global-cursor catch-up hard-capped at 20k msgs/run (`lib/syncEngine.ts:51`); mutation delta is an unindexed `GREATEST(edited_at,deleted_at)` sort capped 500 (`vaultchat-backend/routes/chats.js:98`).
- **Approach:** paginate past the 20k cap (loop until drained); add an index for the mutation-delta sort; raise/paginate its cap.
- **Files:** `lib/syncEngine.ts`, backend route + migration.
- **Effort:** 0.8 ew · **Risk:** Low-Med.
- **Rollback:** current caps.
- **Success metric:** simulated long-offline busy account reaches zero unsynced; >500 mutations sync correctly.

### P5.1–P5.4 — Consolidation & cleanup
- **Objective:** remove redundant backends/deps; shrink bundle + install; cut attack/billing surface.
- **Why:** Node twin un-routed (`docker-compose.yml:105`); Firestore path redundant (`metro.config.js:8`, `services/chatService.ts`); Supabase/expo-sqlite unused; dead TF.js models + eager `ethers`.
- **Approach:** verify each is truly orphaned at runtime (esp. Firestore — some `services/*` still call it) → delete Node + `server/` (keep tag) → remove Firebase shims/rules/indexes → drop unused deps → lazy-load remaining route-only heavy libs.
- **Files:** `vaultchat-backend/`, `server/`, `metro.config.js`, `shims/`, `firestore.*`, `package.json`, `constants/vaultID.ts`, `services/faceRecognitionService.ts`.
- **Effort:** 2.5 ew · **Risk:** Med (must prove orphaned first).
- **Rollback:** git tag for backends; deps re-addable.
- **Success metric:** bundle + install size −8–20 MB; no runtime regression in a full smoke pass.

### P6.1–P6.4 — Reach features
- **Objective:** large group calls, lossy-network REST wins, media off the API path, leaner wire.
- **Why:** mesh dies >5-6 (`app/group-call-active.tsx`); REST over TCP head-of-line-blocks on mobile; JSON+base64 wire is fat (`e2eeSession.ts:258`).
- **Approach:** add SFU (LiveKit/mediasoup) + server-enforced mesh cap; HTTP/3+QUIC at Caddy (WS stays); CDN + presigned direct-to-storage for all media; protobuf/msgpack for wire + ratchet state.
- **Effort:** 6–10 ew total · **Risk:** High (new infra).
- **Rollback:** feature-flag SFU; QUIC is additive; wire format versioned.
- **Success metric:** 8-person call stable on mid phones; media bytes bypass API; wire size −20–40%.

---

## F. KPI target summary (vs Phase 0 baseline)

| KPI | Target | Delivered by |
|---|---|---|
| Cold start / TTI | −20–35% | P1.1, P5.x, lazy-load |
| Scroll frame-drops (chat) | −50–80% | P1.1, P1.2, P3.4 |
| Per-bubble decrypt | −80%+ | P3.3, P3.4 |
| Vault unlock (blocking) | −70%+ (unblocks UI) | P3.2, P3.3 |
| Peak JS heap on large media | OOM eliminated; flat vs file size | P3.1 |
| Install size | −8–20 MB | P5.x |
| Concurrent capacity | 1 node → horizontal | P2.1 |
| DB queries per message | multi → ≤1 write | P2.2 |
| Search latency | O(all-local) → index-backed | P4.2 |
| Message wire bytes | −20–40% | P6.4 |

---

## G. Risk register (top items)

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Redis-adapter cross-node call/presence bugs (P2.1) | Med | High | Canary node on shared Redis before scaling replicas; contract tests on roster/presence |
| Crypto regression from Rust/format changes (P3.x) | Med | High | Parity self-tests as CI gate; flag + TS fallback; version ciphertext |
| Online `messages` partition migration (P4.1) | Med | High | Stage on replica; dual-write/backfill window; forward-only |
| Deleting a not-actually-dead Firestore path (P5.2) | Low-Med | High | Prove orphaned at runtime first; rollback tag |
| d2de format migration breaks old messages (P1.3) | Med | Med | Read-old/write-new window; versioned field |
| SFU operational burden (P6.1) | Med | Med | Managed LiveKit first; flag-gate; 1:1 calls untouched |
| Cleanup regresses bundle silently later | Low | Med | CI size budget from Phase 0 |

---

## H. Rollout & verification methodology (applies to every initiative)

1. **Baseline** the relevant KPI (Section B) on the two reference devices / a load-test cluster.
2. **Flag-gate** where behavior changes (crypto, fan-out, d2de, media path).
3. **Canary** backend changes on one replica / a staging cluster before fleet-wide.
4. **Gate crypto on parity tests** — no merge if `parity.selftest.ts` / crypto self-tests fail.
5. **Re-measure** the same KPI; record delta in the dashboard; a change that doesn't move its target metric is reverted, not kept "just in case."
6. **Roll back** via the stated mechanism (flag flip / replica count / proxy) — every initiative has one.

---

_Total estimated effort: ~30–40 engineer-weeks across Phases 0–6. Critical-path-to-scale (Phase 0 → P2.1 → P2.2 → P4.1) ≈ 8–10 ew; critical-path-to-smooth-and-stable (Phase 0 → P1.1 → P3.1 → P3.3) ≈ 8–10 ew. The two paths are largely parallelizable across a backend and a client engineer._
