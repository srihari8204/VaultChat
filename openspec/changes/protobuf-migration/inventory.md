# Inventory — client HTTP contracts, Waves 4.2–4.5

Read-only analysis. Nothing was built, generated, committed or connected to.
No source file, `.proto` or other OpenSpec file was touched. This is the only
new file.

Companion to `design.md`. Every landmine named here is already documented
there; this file says **which contracts carry it**.

> **Line numbers drift.** `internal/routes/chats.go` was being edited by
> another agent while this file was produced: `GET /chats` moved from
> `chats.go:73` to `chats.go:76` and `PeerLastReadMessageID` from the
> `chats.go:1114-1115` recorded in `design.md §1.7` to `chats.go:1137-1138`,
> both within this run. Every line number below was re-resolved against the
> tree as of the final pass. **Re-resolve before acting on a row** — the
> method+path and the handler *file* are stable; the line is not.

## 1. Method — what was enumerated, what was sampled

Enumeration was mechanical, not eyeballed. Honesty about that matters more
than a round number, so the procedure is stated in full.

| Step | How | Result |
|---|---|---|
| Client call sites | scan of `app/ lib/ services/ components/ hooks/ utils/ store/ contexts/` for `api(…)` / `api<T>(…)` / `api()(…)`, first argument a string or template literal, non-test files only | **351 call sites** |
| Unique contracts | `${…}` → `{}`, query string dropped, trailing query-template stripped | **332 unique method+path** |
| Go routes | every `HandleFunc("METHOD /path"` under `internal/routes/*.go`, non-test | **408 registrations, 408 unique** |
| Join | `/api` prefix stripped, `{name}` → `{}` | **324 joined automatically, 8 joined by hand, 0 unresolved** |

**332 vs design.md's 331** — the two counts were produced by different runs
with different normalisation; they agree to within one contract. This run's
332 is the list in §10 and every row is individually resolvable to a file:line
on both sides. The 8 hand-joined rows are named in §6.

**Counted, not estimated:** the 332 rows, their client file:line, their Go
handler file:line, and which Go file each handler lives in.

**Sampled, not counted** — and then flagged by rule, so a row's flag is
evidence of a *file-level* fact, not a read of that row's response struct:

| Flag | What was actually read | How the flag was then applied |
|---|---|---|
| `PEER` | `chats.go:1109-1147` — the `chatsListItem` struct, in full | Exactly one contract emits it. **Verified per-row.** |
| `ID64` | `lib/msgIds.ts:28-33` and its 13 call sites, `chatsPublicMsg` (`chats.go:297-320`), `openspec/config.yaml:17` | Path-pattern rule (`/messages`, `/chats/delta`, `/poll-votes`, `/read`, `/delivered`, `/pin-message`, `/bookmarks`, `/scheduled-messages`, `/chats/{}/events`, `GET /chats`). **Rule-derived.** |
| `DYN` | `chatsPublicMsg.Meta any`; `json.RawMessage` at `shopbook_tax.go:35-36`, `shopbook_admin.go:177-179`, `shopbook.go:1377`; `map[string]any` at `nav.go:247,479-482`, `user.go:375` | Applied to message-carrying contracts and to handlers in those files. **Rule-derived.** |
| `ISO` | `internal/httpx/httpx.go:22-36` (`JSTime`) | Handler's **file** contains `JSTime`. File-level, not per-route. **Rule-derived, the weakest flag here.** |
| `EPOCH` | `space_items.go:48,72,184`, `space_trips.go:45`, `spaces_locations.go:170,317`, `admin.go:343`, `calls.go:177,204`, `call_sessions.go:1163` | Handler's file uses `UnixMilli`. Note `calls.go:177` emits epoch-ms as a **string** — a third convention. **Rule-derived.** |
| `MONEY` | `shopbook_money.go:5-10,38-80,449-458`; 49 `float64 json:` fields across `shopbook*.go`; 43 `.Float()` sites in `shopbook.go` alone | Every `/shopbook/**` contract except a hand-checked 12-entry no-money allowlist. **Rule-derived with a hand exception list.** |
| `**COLD**` | `app/_layout.tsx:26-76` module-scope imports and initialisers, `components/TermsGate.tsx:56`, `components/UpdateGate.tsx:19`, `lib/push.ts:181`, `lib/CallService.ts:69`, `lib/syncEngine.ts:228` | 7 contracts. **Verified per-row**, but the *ordering* was read from source, not instrumented on a device. |

**Not enumerated at all, and deliberately so:** response field lists. 332
response structs were not read. Risk below is a triage rank, not a schema.

## 2. Risk, and how it was assigned

Risk is rule-derived from the flags above, first match wins:

| Risk | Rule | Count |
|---|---|---|
| HIGH | `**COLD**`, or `PEER`, or `MONEY`, or `ID64`+`DYN`, or `EPOCH` | **94** |
| MEDIUM | `DYN` alone, or `ID64` alone | **19** |
| LOW | `ISO` only, or no flag | **219** |

Two thirds of the surface is LOW. That is the useful finding: the migration is
small in risk terms and concentrated in three places — **ShopBook money (65),
message ids (25), and the 7 cold-start contracts**.

## 3. Request / response / error shapes — one answer for all 332

Verified at source, so it is not restated per row:

| | Shape | Where |
|---|---|---|
| Request | The **only** network-boundary `JSON.stringify` is `lib/api.ts:246`. There is no second encoder. | `api.ts:245-247` |
| Response | The **only** network-boundary `JSON.parse` is `lib/api.ts:553`. Empty body → `undefined`; non-JSON text → returned as text (`shopBookService.ts:905-908` depends on this for rendered invoice HTML). | `api.ts:551-554` |
| Error, shape A | `{"error": "message"}` — `httpx.Err` writes this and nothing else, plus optional flat extras. | `httpx.go:77-86` |
| Error, shape B | `{"error": {"code", "message"}}` — onboarding/auth only. | `auth.go:240`, `auth_phone.go:92` |
| Error, client | Both are unwrapped at `api.ts:534-541`; `err.status` and `err.body` are preserved because a 409 price change carries data the caller must render. | `api.ts:543-546` |

**Consequence for Waves 4.2–4.5:** a typed error envelope is ONE decision, not
332. Two shapes exist; protobuf forces them to become one, and that is a
behaviour change for every `catch` that reads `e.body`.

## 4. The six bypasses — NOT in the 332, NOT reachable through `lib/api.ts`

These call `fetch(SERVER_URL…)` directly and never touch the funnel:

| Contract | Site | Why it bypasses | Status |
|---|---|---|---|
| `POST /auth/refresh` | `lib/api.ts:349` | inside the funnel's own refresh path; migrating it with the funnel is circular | HIGH — the token path |
| `GET /app/version` | `lib/appVersion.ts:80` | must work before auth exists | **already done** — Wave 3.1 landed `lib/appVersionPolicy.ts` and `appVersionNegotiation.selftest.ts`, with a Go golden wire in `appversion_negotiation_test.go` |
| `GET /app/flags` | `lib/remoteFlags.ts:73` | module-scope, pre-auth | HIGH — cold start; `design.md §1.9` names it "most exposed" |
| `GET /user/export` | `lib/chatService.ts:1907` | streams a file, not JSON | LOW — nothing to migrate |
| `GET /health` | `lib/serverTime.ts:16` | clock-skew probe, pre-auth | LOW |
| `POST /api/face/verify` | `app/face-verify-new-device.tsx:61` | note the `/api` prefix — a different mux | MEDIUM — not reviewed in this run |

## 5. Cold-start critical path — 7 contracts, plus 2 of the bypasses

| Contract | Reached from | Why it is cold |
|---|---|---|
| `GET /app/flags` *(bypass)* | `app/_layout.tsx:35` `loadRemoteFlags` | module scope, does network work at boot |
| `GET /app/version` *(bypass)* | `components/UpdateGate.tsx:19` | gate in front of the tree |
| `GET /user/terms` | `components/TermsGate.tsx:56` → `lib/terms.ts:39` | gate in front of the tree |
| `GET /user/profile` | `app/(constants)/authService.ts:362` (+4 sites) | authenticated shell |
| `GET /chats` | `lib/chatService.ts:1149` | first screen |
| `GET /chats/delta` | `lib/syncEngine.ts:228` | first sync pass |
| `POST /user/devices` | `lib/push.ts:181` | push registration at boot |
| `POST /call/token` | `lib/CallService.ts:69` | `registerForCalls` at boot |
| `POST /app/usage` | `lib/usageCounter.ts:126` | `attachUsageFlush` at module scope |

`design.md §1.9` establishes that the codec itself is boot-safe
(`inlineRequires`, dynamic `import()` inside `connectCCWire`). That guarantee
**does not extend** to these nine: they run from `app/_layout.tsx` module
scope or from a gate, so anything they pull in is on the boot path by
definition.

## 6. The 8 contracts the automatic join could not resolve

Resolved by hand. Each is a routing quirk worth knowing before editing:

| Contract | Resolution |
|---|---|
| `GET /user/{}/identity` | `user.go:97` registers `GET /user/` as a **subtree fallback**; `userSubtreeGet` (`user.go:100-111`) string-splits the path → `user.go:924`. It is not a ServeMux pattern. |
| `GET /user/{}/keybundle` | same fallback → `user.go:2369`. The comment at `user.go:94-96` says why: registering the pattern would panic against `/user/by-vault/{vaultId}`. |
| `POST /chats/{}/locations`, `/locations/start`, `/locations/stop` | client uses the `api()(…)` lazy-getter form (`lib/location/publisher.ts:104,118,124`), which no `api(` scan matches. → `spaces_locations.go:53,54,55`. |
| `GET /chats/{}/ops/summary`, `GET /chats/{}/attendance`, `GET /chats/{}/leave/balance` | nested template containing a `?` (`lib/spaces/api.ts:209,218,288`) defeats query stripping. All three are GET. → `spaces_workforce.go:63,64,72`. |

Every one of these is a **migration hazard on its own terms**: a mechanical
"rewrite every `api(` call" pass silently misses all 8.

## 7. Recommended execution order

Cheap wins before landmines. Each batch's entry condition is that the previous
one shipped green, because the funnel is shared — a regression in `lib/api.ts`
is a regression in all 332 at once.

| # | Batch | Contracts | Why here |
|---|---|---|---|
| **1** | **The funnel itself, still emitting JSON** | 0 | Put content negotiation and the typed-error seam into `api.ts:246` / `:553` / `:534-541` with protobuf **off**. Nothing changes on the wire. This is where the real risk lives, and it is testable with zero contracts migrated. |
| **2** | **`LOW`, no request body, no landmine** | the bodyless subset of the 219 LOW rows | Read-only, scalar-only, one convention. If these break, they break visibly and cheaply. Proves the decode direction. |
| **3** | **`LOW` with a request body** | rest of the 219 | Adds the encode direction. Still no landmine. |
| **4** | **`ISO`-only timestamp contracts** | subset of LOW, already covered by 2–3 | Forces the timestamp decision (§9-T) on the *easy* contracts, where a wrong answer is a wrong-looking date, not a lost message. |
| **5** | **`ID64` without `DYN`** | the 19 MEDIUM | `lib/msgIds.ts` is a single, documented, tested chokepoint, with negative local-only ids (`config.yaml:17`). Carry ids as strings and the coercion stays exactly where it already is. |
| **6** | **`EPOCH` — spaces locations / items / trips** | 15 | Small and self-contained. Forces §9-T2 inside one domain instead of across the backend. |
| **7** | **Message-carrying contracts (`ID64`+`DYN`)** | the `/messages` and `/chats/delta` group | `Meta any` has no shape. Needs §9-D answered first. Highest blast radius outside money. |
| **8** | **The cold-start 7** | 7 | Only after every mechanism above is proven in production. A decode regression here is a boot failure, not a screen failure. |
| **9** | **ShopBook** | 65 | Blocked — see §8. |
| **8, with the rest** | `GET /chats` | 1 | **Unblocked 2026-09-19.** The `PeerLast*` "bug" was refuted on evidence — see §8. Sequence it with the other cold-start contracts, not separately. |

Reasoning, in one line: **the funnel is the risk, not the contracts.** 219 of
332 carry nothing worse than an ISO timestamp, so they are the cheap proof
that the funnel works; everything genuinely hard is a decision (§9), not code.

## 8. DO NOT MIGRATE YET

| Contract(s) | Blocking reason |
|---|---|
| ~~**`GET /chats`** (1)~~ | **RETRACTED 2026-09-19 — this was wrong, and acting on it would have caused the damage it warned about.** `PeerLastReadMessageID` / `PeerLastDeliveredMessageID` (`chats.go:1216-1217`) are indeed `*int64` emitted as JSON **numbers** beside string sibling ids, but that is not a live defect: both representations converge to `number \| null` at `lib/ccwire/startupAdapter.ts:142-143`, which runs each through `wireId()` (`lib/msgIds.ts:59-63`) before anything is typed as `ChatSummary` (`lib/chatService.ts:50-51`). No consumer sees a string — `app/(tabs)/chats.tsx:921,923` compares numbers. The shape is **pinned deliberately** by `lib/chatsCacheRollback.selftest.ts:63-66`, which regex-matches the `*int64` tag in `chats.go` source and fails if it changes; `:202-208` and `lib/chatsListProto.selftest.ts:282` assert the convergence. All pass, `defects[]` empty. The "one-line fix" this row asked for (`,string` on the json tags) would have **broken four passing assertions and introduced** the divergence. Fix nothing; migrate with batch 8. |
| **All 65 `MONEY` ShopBook contracts** | `money.Float()` is documented "for JSON output only" (`shopbook_money.go:52`) *because the shipped client parses a number*. Scale is hard-coded at 2dp (`*100` / `/100` / `/10000` at `:42,46,52,76,80`) across four seeded currencies. `sbRoundOff` (`:449-458`) applies the Indian round-to-the-rupee rule gated on `round_off_enabled` **alone, not on country** — a USD shop with that flag set gets Indian rounding. There is no correct protobuf field to write until a human answers §9-M. |
| **`POST /nav/route`, `/nav/matrix`, `/nav/trace`** (3) | `map[string]any` at `nav.go:247,479-482` is a **Valhalla passthrough** shape, not a first-party contract. Typing it means owning an upstream schema. Out of scope. |
| **`POST /auth/refresh`** (bypass) | Lives inside the funnel's own retry path (`api.ts:349`). Migrating it while migrating the funnel is a circular change. Alone, last, or not at all. |
| ~~**`GET /app/flags`** (bypass)~~ | **STALE 2026-09-19 — already migrated, contrary to this row.** Live on both sides in the working tree: `lib/remoteFlagPolicy.ts:88` (`flagsFromProtobuf`, dynamic `import()` of `app_flags_pb`) and `internal/routes/appflags.go:120` (`acceptsProtobuf` + `proto.Marshal`). The caution below was real and was not honoured; the mitigation that makes it survivable is `appflags.go:130`'s fall-through — a marshal failure answers JSON rather than failing the boot. Either accept this as migrated (recommended: it is response-direction only, and the client falls back to `JSON.parse` at `api.ts:603` against any server that does not negotiate) or revert `remoteFlagPolicy.ts`. Do not leave the plan and the code disagreeing. |
| **`GET /user/export`** (bypass) | Streams a file. Not a JSON contract. Nothing to migrate. |
| **Message `meta`** — every `/messages` contract | `chatsPublicMsg.Meta` is `any` (`chats.go:303`), assembled in SQL by merging two jsonb columns (`chats.go:1086-1087`). There is no shape to generate from. Blocked on §9-D. |
| **`POST /api/face/verify`** | Different mux (`/api` prefix), not reviewed in this run. Do not assume it behaves like the other 332. |

## 9. Decisions a human must make — these are not code

Each blocks a batch in §7. None can be resolved by reading more source,
because in every case the source contains **both** answers.

### §9-M — Money representation and scale

`design.md §1.6` establishes that a monetary field must carry, or be reachable
from, its currency **and its scale**; the same section records that ShopBook's
scale is hard-coded to 2dp for four seeded currencies and that `sbRoundOff`
applies an Indian rounding rule without checking country.

**The question:** does a monetary field become
(a) `int64` minor units plus a currency code, scale looked up per currency,
(b) `int64` plus an explicit `int32 scale` carried on the wire, or
(c) a decimal string?

**Why a human:** (a) is correct and breaks every shipped client — which is
exactly why `money.Float()` exists. (b) is self-describing and makes the
`round_off_enabled` bug *visible* rather than fixing it. (c) preserves the
current wire exactly and gives up the point of the migration. Three-minor-unit
currencies (BHD, KWD, JOD, TND) and zero-decimal ones (JPY, KRW, VND) have
**no** representation today under any option. **Blocks 65 contracts.**

### §9-T — Timestamp unit

`httpx.JSTime` (ISO 8601 string, `httpx.go:22-36`) governs 176 of the 332
contracts by file-level evidence. `UnixMilli` int64 governs 15. `calls.go:177`
emits epoch-ms as a **string**. All three are live in the same backend today.

**The question:** one canonical wire representation, or two with the boundary
declared per field?

**Why a human:** a single answer makes either 15 or 176 contracts a breaking
change for shipped clients. Declaring both encodes the inconsistency into the
schema permanently. **Blocks batches 4 and 6.**

### §9-T2 — Which `EPOCH` contracts are truly epoch-ms

The 15 `EPOCH` rows were flagged because their handler **file** calls
`UnixMilli`, not because their response struct was read.

**The question:** each of the 15 must be confirmed individually before batch 6.
**This is the weakest inference in this document and it is labelled as such
rather than presented as a count.**

### §9-I — Identifier width

`design.md §1.7` establishes two live disciplines: CC-Wire is string/BigInt
exact end to end, while REST + SQLite + UI coerces to a JS number **by design
and with the reasoning documented** (`msgIds.ts:28-33`), bounded at 2^53.
`openspec/config.yaml:17` adds that local-only rows **must use negative ids**,
so the id space is not merely 64-bit — it is signed and the sign is
load-bearing.

**The question:** `string` (preserves both disciplines, keeps
`normalizeMsgIds` exactly where it is), `int64` (honest about the type — but
`@bufbuild/protobuf` v1 hands back a `bigint`, which every downstream
`Map<number, …>` and `typeof id === 'number'` filter rejects: precisely the
bug `msgIds.ts` was written to fix), or `sint64` (cheaper for the negative
local ids, and meaningless on the wire since those rows are never sent)?

**Why a human:** `int64` is the "correct" answer and is the one that silently
breaks reply quoting and the message cache. **Blocks batches 5 and 7.**

### §9-D — `meta`, and free-form JSON generally

`chatsPublicMsg.Meta` is `any`, assembled in SQL from `meta` merged with
`meta_private` (`chats.go:1086-1087`). `shopbook_tax.go:35-36`,
`shopbook_admin.go:177-179` and `shopbook.go:1377` use `json.RawMessage`.

**The question:** `google.protobuf.Struct`, `bytes` carrying the JSON as-is,
or enumerate the real shapes?

**Why a human:** `Struct` costs more bytes than the JSON it replaces and
defeats the purpose. `bytes` is honest but means the migration did not happen
for this field — and `AppEvent.payload_json` already proves that outcome is
the thing this project exists to escape (`proposal.md`, "Why"). Enumerating is
correct and unbounded in effort. **Blocks batch 7.**

### §9-E — Error envelope

Two shapes are live: `{"error": string}` (`httpx.go:78`) and
`{"error":{code,message}}` (`auth.go:240`). `api.ts:534-541` accepts both, and
`err.body` is preserved deliberately because a 409 carries data the caller
renders (`api.ts:543-546`).

**The question:** one envelope — and what happens to the callers that read
`e.body` off a failure?

**Why a human:** it is a behaviour change at every `catch` in the client, and
it is invisible to the type checker. **Blocks batch 1 — the first batch.**

## 10. The 332 contracts

Legend — `Req` = request body present at the call site. Landmines:
`**COLD**` cold-start critical path · `ID64` 64-bit id passing through a JS
number · `PEER` the `chats.go` `PeerLast*` int64-as-JSON-number inconsistency ·
`ISO` `httpx.JSTime` present in the handler's file · `EPOCH` `UnixMilli`
present in the handler's file · `MONEY` ShopBook decimal via `money.Float()` ·
`DYN` free-form JSON with no typed shape.

Go handler paths are relative to `vaultchat-backend-go/internal/routes/`;
client paths are relative to the repo root. `(+n)` = n further call sites for
the same contract; the first is shown. `{}` is a path parameter.

### chats — 105

| Contract | Req | Client site | Go handler | Landmines | Risk | Reason |
|---|---|---|---|---|---|---|
| `DELETE /chats/{}/events/{}` | - | lib/chatService.ts:2154 | chats_calendar.go:46 | ID64 ISO | MEDIUM | 64-bit id on the wire, Number()-coerced client-side |
| `DELETE /chats/{}/invitations/{}` | - | lib/chatService.ts:2289 | chats_invitations.go:64 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `DELETE /chats/{}/invite-links/{}` | - | lib/chatService.ts:2086 | chats.go:135 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `DELETE /chats/{}/join-requests/{}` | - | lib/chatService.ts:2441 | chats.go:87 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `DELETE /chats/{}/links` | Y | lib/spaces/api.ts:84 | spaces_roster.go:71 | - | LOW | scalars only, no landmine found |
| `DELETE /chats/{}/members/{}` | - | lib/chatService.ts:2009 | chats.go:145 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `DELETE /chats/{}/messages/{}` | - | lib/chatService.ts:1494 | chats.go:95 | ID64 ISO DYN | HIGH | 64-bit message id Number()-coerced (msgIds.ts:28-33) AND untyped `meta any` |
| `DELETE /chats/{}/messages/{}/vote/{}` | - | lib/chatService.ts:1564 | chats.go:147 | ID64 ISO DYN | HIGH | 64-bit message id Number()-coerced (msgIds.ts:28-33) AND untyped `meta any` |
| `GET /chats` | - | lib/chatService.ts:1149 | chats.go:76 | **COLD** ID64 PEER ISO | HIGH | cold-start critical path — a decode regression is a boot failure, not a screen failure |
| `GET /chats/common/{}` | - | lib/chatService.ts:2558 | chats.go:80 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /chats/delta` | - | lib/syncEngine.ts:228 (+1) | chats.go:75 | **COLD** ID64 ISO DYN | HIGH | cold-start critical path — a decode regression is a boot failure, not a screen failure |
| `GET /chats/search` | - | lib/chatService.ts:2058 | chats.go:79 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /chats/{}` | - | lib/chatService.ts:1192 (+1) | chats.go:81 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /chats/{}/attendance` | - | lib/spaces/api.ts:218 | spaces_workforce.go:64 | - | LOW | scalars only, no landmine found |
| `GET /chats/{}/devices` | - | lib/spaces/api.ts:323 | spaces_devices.go:53 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /chats/{}/devices/{}/commands` | - | lib/spaces/api.ts:337 | spaces_devices.go:59 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /chats/{}/devices/{}/events` | - | lib/spaces/api.ts:334 | spaces_devices.go:57 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /chats/{}/events` | - | lib/chatService.ts:2135 | chats_calendar.go:43 | ID64 ISO | MEDIUM | 64-bit id on the wire, Number()-coerced client-side |
| `GET /chats/{}/incidents` | - | lib/spaces/api.ts:160 | spaces_ops.go:55 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /chats/{}/invitations` | - | lib/chatService.ts:2280 | chats_invitations.go:62 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /chats/{}/invite-links` | - | lib/chatService.ts:2074 | chats.go:134 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /chats/{}/join-requests` | - | lib/chatService.ts:2435 | chats.go:85 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /chats/{}/leave` | - | lib/spaces/api.ts:233 | spaces_workforce.go:67 | - | LOW | scalars only, no landmine found |
| `GET /chats/{}/leave/balance` | - | lib/spaces/api.ts:288 | spaces_workforce.go:72 | - | LOW | scalars only, no landmine found |
| `GET /chats/{}/links` | - | lib/spaces/api.ts:78 | spaces_roster.go:69 | - | LOW | scalars only, no landmine found |
| `GET /chats/{}/membership/candidates` | - | lib/chatService.ts:2355 | chats_membership.go:51 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /chats/{}/membership/pending` | - | lib/chatService.ts:2335 | chats_membership.go:52 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /chats/{}/messages` | - | lib/chatService.ts:1375 | chats.go:89 | ID64 ISO DYN | HIGH | 64-bit message id Number()-coerced (msgIds.ts:28-33) AND untyped `meta any` |
| `GET /chats/{}/messages/{}/votes` | - | lib/chatService.ts:1572 | chats.go:148 | ID64 ISO DYN | HIGH | 64-bit message id Number()-coerced (msgIds.ts:28-33) AND untyped `meta any` |
| `GET /chats/{}/ops/pending` | - | lib/spaces/api.ts:266 | spaces_workforce.go:70 | - | LOW | scalars only, no landmine found |
| `GET /chats/{}/ops/people` | - | lib/spaces/api.ts:278 | spaces_workforce.go:71 | - | LOW | scalars only, no landmine found |
| `GET /chats/{}/ops/summary` | - | lib/spaces/api.ts:209 | spaces_workforce.go:63 | - | LOW | scalars only, no landmine found |
| `GET /chats/{}/poll-votes` | - | lib/chatService.ts:1579 | chats.go:149 | ID64 ISO | MEDIUM | 64-bit id on the wire, Number()-coerced client-side |
| `GET /chats/{}/roster` | - | lib/spaces/api.ts:67 | spaces_roster.go:66 | - | LOW | scalars only, no landmine found |
| `GET /chats/{}/runs` | - | lib/spaces/api.ts:94 | spaces_runs.go:89 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /chats/{}/runs/{}` | - | lib/spaces/api.ts:97 | spaces_runs.go:91 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /chats/{}/runs/{}/events` | - | lib/spaces/api.ts:145 | spaces_runs.go:98 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /chats/{}/sender-keys` | - | services/crypto/groupSession.rn.ts:138 | chats.go:152 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /chats/{}/tasks` | - | lib/spaces/api.ts:249 | spaces_workforce.go:74 | - | LOW | scalars only, no landmine found |
| `GET /chats/{}/visitor-passes` | - | lib/spaces/api.ts:171 | spaces_ops.go:58 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `PATCH /chats/{}` | Y | lib/chatService.ts:1931 | chats.go:82 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `PATCH /chats/{}/devices/{}` | Y | lib/spaces/api.ts:331 | spaces_devices.go:55 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `PATCH /chats/{}/duty` | Y | lib/spaces/api.ts:156 | spaces_runs.go:99 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `PATCH /chats/{}/events/{}` | Y | lib/chatService.ts:2150 | chats_calendar.go:45 | ID64 ISO | MEDIUM | 64-bit id on the wire, Number()-coerced client-side |
| `PATCH /chats/{}/hidden` | Y | lib/chatService.ts:2513 | chats.go:139 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `PATCH /chats/{}/incidents/{}` | Y | lib/spaces/api.ts:168 | spaces_ops.go:57 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `PATCH /chats/{}/leave/allowance` | Y | lib/spaces/api.ts:291 | spaces_workforce.go:73 | - | LOW | scalars only, no landmine found |
| `PATCH /chats/{}/leave/{}` | Y | lib/spaces/api.ts:240 | spaces_workforce.go:69 | - | LOW | scalars only, no landmine found |
| `PATCH /chats/{}/members/{}/role` | Y | lib/chatService.ts:2028 | chats.go:132 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `PATCH /chats/{}/members/{}/role-key` | Y | lib/spaces/api.ts:87 | spaces_roster.go:72 | - | LOW | scalars only, no landmine found |
| `PATCH /chats/{}/membership/approval-mode` | Y | lib/chatService.ts:2421 | chats_membership.go:55 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `PATCH /chats/{}/messages/{}` | Y | lib/chatService.ts:1480 | chats.go:91 | ID64 ISO DYN | HIGH | 64-bit message id Number()-coerced (msgIds.ts:28-33) AND untyped `meta any` |
| `PATCH /chats/{}/notif-sound` | Y | lib/chatService.ts:2522 | chats.go:144 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `PATCH /chats/{}/roster/{}` | Y | lib/spaces/api.ts:76 | spaces_roster.go:68 | - | LOW | scalars only, no landmine found |
| `PATCH /chats/{}/runs/{}` | Y | lib/spaces/api.ts:107 (+1) | spaces_runs.go:92 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `PATCH /chats/{}/screenshot-mode` | Y | lib/chatService.ts:71 | chats.go:140 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `PATCH /chats/{}/shift` | Y | lib/spaces/api.ts:354 | spaces_ops.go:61 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `PATCH /chats/{}/tasks/{}` | Y | lib/spaces/api.ts:256 | spaces_workforce.go:76 | - | LOW | scalars only, no landmine found |
| `PATCH /chats/{}/vanish-mode` | Y | lib/chatService.ts:89 | chats.go:142 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /chats` | Y | lib/chatService.ts:1213 (+1) | chats.go:77 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /chats/join/{}` | - | lib/chatService.ts:2093 | chats.go:78 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /chats/{}/archive` | Y | lib/chatService.ts:2504 | chats.go:138 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /chats/{}/attendance/check-in` | Y | lib/spaces/api.ts:221 | spaces_workforce.go:65 | - | LOW | scalars only, no landmine found |
| `POST /chats/{}/attendance/check-out` | - | lib/spaces/api.ts:224 | spaces_workforce.go:66 | - | LOW | scalars only, no landmine found |
| `POST /chats/{}/delivered` | Y | lib/chatService.ts:1523 | chats.go:96 | ID64 ISO | MEDIUM | 64-bit id on the wire, Number()-coerced client-side |
| `POST /chats/{}/devices` | Y | lib/spaces/api.ts:327 | spaces_devices.go:54 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /chats/{}/devices/{}/commands` | Y | lib/spaces/api.ts:341 | spaces_devices.go:60 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /chats/{}/events` | Y | lib/chatService.ts:2142 | chats_calendar.go:44 | ID64 ISO | MEDIUM | 64-bit id on the wire, Number()-coerced client-side |
| `POST /chats/{}/favourite` | Y | lib/chatService.ts:2498 | chats.go:137 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /chats/{}/incidents` | Y | lib/spaces/api.ts:165 | spaces_ops.go:56 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /chats/{}/invitations` | Y | lib/chatService.ts:2273 | chats_invitations.go:61 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /chats/{}/invitations/{}/approve` | - | lib/chatService.ts:2340 | chats_membership.go:56 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /chats/{}/invitations/{}/cancel` | - | lib/chatService.ts:2298 | chats_membership.go:58 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /chats/{}/invitations/{}/reject` | - | lib/chatService.ts:2345 | chats_membership.go:57 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /chats/{}/invitations/{}/resend` | - | lib/chatService.ts:2285 | chats_invitations.go:63 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /chats/{}/invite-links` | Y | lib/chatService.ts:2080 | chats.go:133 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /chats/{}/join-requests/{}/approve` | - | lib/chatService.ts:2438 | chats.go:86 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /chats/{}/leave` | Y | lib/spaces/api.ts:237 | spaces_workforce.go:68 | - | LOW | scalars only, no landmine found |
| `POST /chats/{}/links` | Y | lib/spaces/api.ts:81 | spaces_roster.go:70 | - | LOW | scalars only, no landmine found |
| `POST /chats/{}/locations` | - | lib/location/publisher.ts:104 | spaces_locations.go:53 | EPOCH | HIGH | epoch-ms int64 timestamps in a backend whose default is ISO strings — unit is ambiguous |
| `POST /chats/{}/locations/start` | - | lib/location/publisher.ts:118 | spaces_locations.go:54 | EPOCH | HIGH | epoch-ms int64 timestamps in a backend whose default is ISO strings — unit is ambiguous |
| `POST /chats/{}/locations/stop` | - | lib/location/publisher.ts:124 | spaces_locations.go:55 | EPOCH | HIGH | epoch-ms int64 timestamps in a backend whose default is ISO strings — unit is ambiguous |
| `POST /chats/{}/members` | Y | lib/chatService.ts:2002 | chats.go:131 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /chats/{}/membership/request` | - | lib/chatService.ts:2360 | chats_membership.go:53 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /chats/{}/membership/transfer` | Y | lib/chatService.ts:2413 | chats_membership.go:54 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /chats/{}/messages` | Y | lib/chatService.ts:1410 (+1) | chats.go:88 | ID64 ISO DYN | HIGH | 64-bit message id Number()-coerced (msgIds.ts:28-33) AND untyped `meta any` |
| `POST /chats/{}/messages/{}/vote` | Y | lib/chatService.ts:1555 | chats.go:146 | ID64 ISO DYN | HIGH | 64-bit message id Number()-coerced (msgIds.ts:28-33) AND untyped `meta any` |
| `POST /chats/{}/mute` | Y | lib/chatService.ts:2484 | chats.go:143 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /chats/{}/pin` | Y | lib/chatService.ts:2492 | chats.go:136 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /chats/{}/pin-message` | Y | lib/chatService.ts:157 | chats.go:150 | ID64 ISO | MEDIUM | 64-bit id on the wire, Number()-coerced client-side |
| `POST /chats/{}/read` | Y | lib/chatService.ts:1515 | chats.go:97 | ID64 ISO | MEDIUM | 64-bit id on the wire, Number()-coerced client-side |
| `POST /chats/{}/roster` | Y | lib/spaces/api.ts:72 | spaces_roster.go:67 | - | LOW | scalars only, no landmine found |
| `POST /chats/{}/runs` | Y | lib/spaces/api.ts:104 | spaces_runs.go:90 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /chats/{}/runs/{}/ping` | - | lib/spaces/api.ts:153 | spaces_runs.go:97 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /chats/{}/runs/{}/riders/{}/state` | Y | lib/spaces/api.ts:140 | spaces_runs.go:96 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /chats/{}/runs/{}/stops/{}/arrive` | - | lib/spaces/api.ts:125 | spaces_runs.go:94 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /chats/{}/save-contact` | - | lib/chatService.ts:1988 | chats_anon.go:143 | - | LOW | scalars only, no landmine found |
| `POST /chats/{}/screenshot-captured` | - | lib/chatService.ts:82 | chats.go:141 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /chats/{}/sender-keys` | Y | services/crypto/groupSession.rn.ts:71 | chats.go:151 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /chats/{}/tasks` | Y | lib/spaces/api.ts:253 | spaces_workforce.go:75 | - | LOW | scalars only, no landmine found |
| `POST /chats/{}/visitor-passes` | Y | lib/spaces/api.ts:174 | spaces_ops.go:59 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /chats/{}/visitor-passes/redeem` | Y | lib/spaces/api.ts:177 | spaces_ops.go:60 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `PUT /chats/{}/messages/{}/body` | Y | lib/messageQueue.ts:366 | chats.go:94 | ID64 ISO DYN | HIGH | 64-bit message id Number()-coerced (msgIds.ts:28-33) AND untyped `meta any` |
| `PUT /chats/{}/runs/{}/riders` | Y | lib/spaces/api.ts:130 | spaces_runs.go:95 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `PUT /chats/{}/runs/{}/stops` | Y | lib/spaces/api.ts:115 | spaces_runs.go:93 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |

### shopbook — 76

| Contract | Req | Client site | Go handler | Landmines | Risk | Reason |
|---|---|---|---|---|---|---|
| `DELETE /shopbook/my-shop/coupons/{}` | - | services/shopBookService.ts:673 | shopbook.go:101 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `DELETE /shopbook/my-shop/documents/{}` | - | services/shopBookService.ts:240 | shopbook_verify.go:39 | - | LOW | scalars only, no landmine found |
| `DELETE /shopbook/my-shop/products/{}` | - | services/shopBookService.ts:773 | shopbook.go:90 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `DELETE /shopbook/my-shop/suppliers/{}` | - | services/shopBookService.ts:699 | shopbook.go:104 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/countries` | - | services/shopBookService.ts:331 | shopbook.go:113 | - | LOW | scalars only, no landmine found |
| `GET /shopbook/credit-notes/{}` | - | services/shopBookService.ts:200 | shopbook_return.go:38 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/favorites` | - | services/shopBookService.ts:656 | shopbook.go:77 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/invoices/{}/render` | - | services/shopBookService.ts:908 | shopbook_documents.go:42 | MONEY DYN | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/ledger/{}` | - | services/shopBookService.ts:750 | shopbook.go:73 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/loyalty` | - | services/shopBookService.ts:688 | shopbook.go:82 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/my-ledgers` | - | services/shopBookService.ts:493 | shopbook.go:120 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/my-shop` | - | services/shopBookService.ts:755 | shopbook.go:85 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/my-shop/audit` | - | services/shopBookService.ts:212 | shopbook_purchase.go:33 | - | LOW | scalars only, no landmine found |
| `GET /shopbook/my-shop/coupons` | - | services/shopBookService.ts:667 | shopbook.go:99 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/my-shop/dashboard` | - | services/shopBookService.ts:798 | shopbook.go:94 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/my-shop/documents/{}/url` | - | services/shopBookService.ts:244 | shopbook_verify.go:40 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/my-shop/ledger` | - | services/shopBookService.ts:802 (+1) | shopbook.go:95 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/my-shop/location-request` | - | services/shopBookService.ts:265 | shopbook_verify.go:43 | - | LOW | scalars only, no landmine found |
| `GET /shopbook/my-shop/orders` | - | services/shopBookService.ts:716 (+1) | shopbook.go:91 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/my-shop/orders/{}/bill` | - | services/shopBookService.ts:84 | shopbook_bill.go:30 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/my-shop/payments` | - | services/shopBookService.ts:123 | shopbook_payment.go:38 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/my-shop/products` | - | services/shopBookService.ts:764 | shopbook.go:87 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/my-shop/purchases` | - | services/shopBookService.ts:147 | shopbook_purchase.go:30 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/my-shop/purchases/{}` | - | services/shopBookService.ts:150 | shopbook_purchase.go:32 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/my-shop/reports` | - | services/shopBookService.ts:952 | shopbook.go:109 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/my-shop/returns` | - | services/shopBookService.ts:181 | shopbook_return.go:36 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/my-shop/stock` | - | services/shopBookService.ts:281 | shopbook_stock.go:40 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/my-shop/stock/movements` | - | services/shopBookService.ts:302 | shopbook_stock.go:42 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/my-shop/suppliers` | - | services/shopBookService.ts:693 | shopbook.go:102 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/notifications` | - | services/shopBookService.ts:479 | shopbook.go:118 | - | LOW | scalars only, no landmine found |
| `GET /shopbook/orders` | - | services/shopBookService.ts:709 (+1) | shopbook.go:70 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/orders/{}` | - | services/shopBookService.ts:724 | shopbook.go:71 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/orders/{}/invoice` | - | services/shopBookService.ts:464 | shopbook.go:117 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/payments` | - | services/shopBookService.ts:126 | shopbook_payment.go:39 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/returns` | - | services/shopBookService.ts:177 | shopbook_return.go:35 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/search-products` | - | services/shopBookService.ts:983 | shopbook.go:74 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/shops` | - | services/shopBookService.ts:606 | shopbook.go:66 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/shops/{}` | - | services/shopBookService.ts:610 | shopbook.go:67 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/shops/{}/coupons` | - | services/shopBookService.ts:664 | shopbook.go:79 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/shops/{}/products` | - | services/shopBookService.ts:614 | shopbook.go:68 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/shops/{}/ratings` | - | services/shopBookService.ts:678 | shopbook.go:80 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `GET /shopbook/starter-catalog` | - | services/shopBookService.ts:336 | shopbook.go:114 | - | LOW | scalars only, no landmine found |
| `POST /shopbook/favorites` | Y | services/shopBookService.ts:659 | shopbook.go:78 | - | LOW | scalars only, no landmine found |
| `POST /shopbook/my-shop` | Y | services/shopBookService.ts:760 | shopbook.go:86 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `POST /shopbook/my-shop/counter-sale` | Y | services/shopBookService.ts:900 | shopbook_documents.go:40 | MONEY DYN | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `POST /shopbook/my-shop/coupons` | Y | services/shopBookService.ts:670 | shopbook.go:100 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `POST /shopbook/my-shop/customers/{}/credit-limit` | Y | services/shopBookService.ts:129 | shopbook_payment.go:40 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `POST /shopbook/my-shop/documents` | Y | services/shopBookService.ts:237 | shopbook_verify.go:38 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `POST /shopbook/my-shop/documents/presign` | Y | services/shopBookService.ts:231 | shopbook_verify.go:37 | - | LOW | scalars only, no landmine found |
| `POST /shopbook/my-shop/khata-customers` | Y | services/shopBookService.ts:862 | shopbook_khata.go:34 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `POST /shopbook/my-shop/khata-customers/{}/credit-limit` | Y | services/shopBookService.ts:876 | shopbook_khata.go:35 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `POST /shopbook/my-shop/ledger` | Y | services/shopBookService.ts:831 | shopbook.go:96 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `POST /shopbook/my-shop/ledger/remind` | Y | services/shopBookService.ts:923 | shopbook.go:107 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `POST /shopbook/my-shop/ledger/{}/invoice` | - | services/shopBookService.ts:887 | shopbook_documents.go:38 | MONEY DYN | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `POST /shopbook/my-shop/ledger/{}/receipt` | - | services/shopBookService.ts:893 | shopbook_documents.go:39 | MONEY DYN | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `POST /shopbook/my-shop/location-request` | Y | services/shopBookService.ts:261 | shopbook_verify.go:42 | - | LOW | scalars only, no landmine found |
| `POST /shopbook/my-shop/orders/{}/bill` | Y | services/shopBookService.ts:93 | shopbook_bill.go:31 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `POST /shopbook/my-shop/orders/{}/item/{}` | Y | services/shopBookService.ts:784 | shopbook.go:92 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `POST /shopbook/my-shop/orders/{}/status` | Y | services/shopBookService.ts:792 | shopbook.go:93 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `POST /shopbook/my-shop/payments` | Y | services/shopBookService.ts:119 | shopbook_payment.go:37 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `POST /shopbook/my-shop/plan` | Y | services/shopBookService.ts:929 | shopbook.go:108 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `POST /shopbook/my-shop/products` | Y | services/shopBookService.ts:769 | shopbook.go:88 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `POST /shopbook/my-shop/products/bulk` | Y | services/shopBookService.ts:988 | shopbook.go:89 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `POST /shopbook/my-shop/purchases` | Y | services/shopBookService.ts:157 | shopbook_purchase.go:31 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `POST /shopbook/my-shop/returns/{}/decide` | Y | services/shopBookService.ts:187 | shopbook_return.go:37 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `POST /shopbook/my-shop/stock/adjust` | Y | services/shopBookService.ts:288 | shopbook_stock.go:41 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `POST /shopbook/my-shop/submit-verification` | Y | services/shopBookService.ts:247 | shopbook_verify.go:41 | - | LOW | scalars only, no landmine found |
| `POST /shopbook/my-shop/suppliers` | Y | services/shopBookService.ts:696 | shopbook.go:103 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `POST /shopbook/notifications/read` | Y | services/shopBookService.ts:483 | shopbook.go:119 | ID64 | MEDIUM | 64-bit id on the wire, Number()-coerced client-side |
| `POST /shopbook/orders` | Y | services/shopBookService.ts:648 | shopbook.go:69 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `POST /shopbook/orders/{}/buyer-tax` | Y | services/shopBookService.ts:100 | shopbook_bill.go:32 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `POST /shopbook/orders/{}/cancel` | Y | services/shopBookService.ts:736 | shopbook.go:115 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `POST /shopbook/orders/{}/collected` | - | services/shopBookService.ts:744 | shopbook.go:116 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `POST /shopbook/orders/{}/item/{}/decision` | Y | services/shopBookService.ts:728 | shopbook.go:72 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `POST /shopbook/orders/{}/rate` | Y | services/shopBookService.ts:681 | shopbook.go:81 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |
| `POST /shopbook/orders/{}/return` | Y | services/shopBookService.ts:172 | shopbook_return.go:34 | MONEY | HIGH | money crosses as decimal via money.Float(); scale hard-coded 2dp for every currency |

### user — 47

| Contract | Req | Client site | Go handler | Landmines | Risk | Reason |
|---|---|---|---|---|---|---|
| `DELETE /user/account` | Y | lib/chatService.ts:1899 | user.go:67 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `DELETE /user/backup` | - | lib/cloudBackup.ts:358 | user.go:93 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `DELETE /user/blocks/{}` | - | lib/chatService.ts:2596 | user.go:86 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `DELETE /user/bookmarks/{}` | - | lib/chatService.ts:1664 | user.go:74 | ID64 ISO | MEDIUM | 64-bit id on the wire, Number()-coerced client-side |
| `DELETE /user/devices` | Y | lib/push.ts:199 | user.go:64 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `DELETE /user/ghost-mode/{}` | - | lib/chatService.ts:1854 | user.go:71 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `DELETE /user/scheduled-messages/{}` | - | lib/chatService.ts:1818 | user.go:80 | ID64 ISO | MEDIUM | 64-bit id on the wire, Number()-coerced client-side |
| `DELETE /user/sessions` | - | lib/chatService.ts:1888 | user.go:77 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `DELETE /user/sessions/{}` | - | lib/chatService.ts:1884 | user.go:76 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /user/backup` | - | lib/cloudBackup.ts:346 | user.go:92 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /user/backup/key` | - | lib/cloudBackup.ts:84 | user.go:87 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /user/backup/meta` | - | lib/cloudBackup.ts:319 | user.go:88 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /user/blocks` | - | lib/chatService.ts:2590 | user.go:84 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /user/bookmarks` | - | lib/chatService.ts:1603 | user.go:72 | ID64 ISO | MEDIUM | 64-bit id on the wire, Number()-coerced client-side |
| `GET /user/by-vault/{}` | - | lib/chatService.ts:1362 | user.go:60 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /user/contact-verifications` | - | lib/verification.ts:22 | user.go:58 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /user/ghost-mode` | - | lib/chatService.ts:1836 | user.go:68 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /user/ghost-mode/{}` | - | lib/chatService.ts:1840 | user.go:69 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /user/profile` | - | app/(constants)/authService.ts:362 (+4) | user.go:46 | **COLD** ISO | HIGH | cold-start critical path — a decode regression is a boot failure, not a screen failure |
| `GET /user/scheduled-messages` | - | lib/chatService.ts:1803 | user.go:78 | ID64 ISO | MEDIUM | 64-bit id on the wire, Number()-coerced client-side |
| `GET /user/security-events` | - | services/security/auditChain.ts:365 | user.go:53 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /user/security-overview` | - | lib/security.ts:19 | user.go:48 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /user/sessions` | - | lib/chatService.ts:1878 | user.go:75 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /user/settings` | - | lib/chatService.ts:2549 | user.go:82 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /user/sos` | - | lib/chatService.ts:1260 | user.go:51 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /user/terms` | - | lib/terms.ts:39 | terms.go:56 | **COLD** | HIGH | cold-start critical path — a decode regression is a boot failure, not a screen failure |
| `GET /user/turn` | - | lib/chatService.ts:2655 | user.go:65 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /user/{}/identity` | - | lib/verification.ts:12 | user.go:97 -> user.go:924 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /user/{}/keybundle` | - | services/crypto/e2eeSession.rn.ts:37 | user.go:97 -> user.go:2369 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /user/backup/commit` | Y | lib/cloudBackup.ts:338 | user.go:90 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /user/backup/presign` | Y | lib/cloudBackup.ts:328 | user.go:89 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /user/blocks` | Y | lib/chatService.ts:2593 | user.go:85 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /user/bookmarks` | Y | lib/chatService.ts:1654 | user.go:73 | ID64 ISO | MEDIUM | 64-bit id on the wire, Number()-coerced client-side |
| `POST /user/contact-verifications` | Y | lib/verification.ts:28 | user.go:59 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /user/devices` | Y | lib/push.ts:181 | user.go:63 | **COLD** ISO | HIGH | cold-start critical path — a decode regression is a boot failure, not a screen failure |
| `POST /user/keybundle` | Y | services/crypto/e2eeSession.rn.ts:33 | user.go:81 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /user/pin` | Y | app/(constants)/authService.ts:278 | user.go:61 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /user/pin/verify` | Y | lib/chatService.ts:2532 | user.go:62 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /user/reports` | Y | lib/chatService.ts:2603 | user.go:49 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /user/scheduled-messages` | Y | lib/chatService.ts:1472 (+1) | user.go:79 | ID64 ISO | MEDIUM | 64-bit id on the wire, Number()-coerced client-side |
| `POST /user/security-events` | Y | services/security/auditChain.ts:329 | user.go:52 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /user/sos` | Y | lib/chatService.ts:1257 | user.go:50 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /user/terms` | Y | lib/terms.ts:78 | terms.go:57 | - | LOW | scalars only, no landmine found |
| `PUT /user/backup` | Y | lib/cloudBackup.ts:340 | user.go:91 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `PUT /user/ghost-mode/{}` | Y | lib/chatService.ts:1847 | user.go:70 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `PUT /user/profile` | Y | app/(constants)/authService.ts:253 (+3) | user.go:47 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `PUT /user/settings` | Y | lib/chatService.ts:2552 | user.go:83 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |

### broadcasts — 16

| Contract | Req | Client site | Go handler | Landmines | Risk | Reason |
|---|---|---|---|---|---|---|
| `DELETE /broadcasts/{}/invite-link` | - | lib/broadcast.ts:323 | golive_invites.go:52 | - | LOW | scalars only, no landmine found |
| `GET /broadcasts/live` | - | lib/broadcast.ts:115 | broadcasts.go:43 | - | LOW | scalars only, no landmine found |
| `GET /broadcasts/{}` | - | lib/broadcast.ts:120 | broadcasts.go:44 | - | LOW | scalars only, no landmine found |
| `GET /broadcasts/{}/chat` | - | lib/broadcast.ts:201 | broadcasts.go:55 | - | LOW | scalars only, no landmine found |
| `GET /broadcasts/{}/invite-link` | - | lib/broadcast.ts:317 | golive_invites.go:51 | - | LOW | scalars only, no landmine found |
| `GET /broadcasts/{}/polls` | - | lib/broadcast.ts:254 | golive_polls.go:47 | - | LOW | scalars only, no landmine found |
| `POST /broadcasts` | Y | lib/broadcast.ts:108 | broadcasts.go:42 | - | LOW | scalars only, no landmine found |
| `POST /broadcasts/{}/chat` | Y | lib/broadcast.ts:208 | broadcasts.go:56 | - | LOW | scalars only, no landmine found |
| `POST /broadcasts/{}/end` | Y | lib/broadcast.ts:133 | broadcasts.go:45 | - | LOW | scalars only, no landmine found |
| `POST /broadcasts/{}/invite-link` | Y | lib/broadcast.ts:307 | golive_invites.go:50 | - | LOW | scalars only, no landmine found |
| `POST /broadcasts/{}/polls` | Y | lib/broadcast.ts:246 | golive_polls.go:46 | - | LOW | scalars only, no landmine found |
| `POST /broadcasts/{}/polls/{}/close` | Y | lib/broadcast.ts:280 | golive_polls.go:49 | - | LOW | scalars only, no landmine found |
| `POST /broadcasts/{}/polls/{}/vote` | Y | lib/broadcast.ts:270 | golive_polls.go:48 | - | LOW | scalars only, no landmine found |
| `POST /broadcasts/{}/token` | - | lib/call/sfuToken.ts:100 | broadcasts.go:52 | - | LOW | scalars only, no landmine found |
| `POST /broadcasts/{}/unwatch` | - | lib/broadcast.ts:191 | broadcasts.go:54 | - | LOW | scalars only, no landmine found |
| `POST /broadcasts/{}/watch` | - | lib/broadcast.ts:185 | broadcasts.go:53 | - | LOW | scalars only, no landmine found |

### auth — 16

| Contract | Req | Client site | Go handler | Landmines | Risk | Reason |
|---|---|---|---|---|---|---|
| `GET /auth/security-questions/{}` | - | lib/onboarding.ts:197 | auth.go:58 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /auth/logout` | Y | app/(constants)/authService.ts:384 | auth.go:44 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /auth/lookup` | Y | lib/onboarding.ts:137 | auth.go:55 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /auth/mfa/configure` | Y | lib/onboarding.ts:171 | auth.go:64 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /auth/mpin/recover` | Y | lib/onboarding.ts:209 | auth.go:62 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /auth/mpin/set` | Y | lib/onboarding.ts:158 | auth.go:60 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /auth/mpin/verify` | Y | lib/onboarding.ts:163 | auth.go:61 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /auth/onboard/resend-otp-phone` | Y | lib/onboarding.ts:121 | auth.go:53 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /auth/onboard/send-otp-phone` | Y | lib/onboarding.ts:114 | auth.go:52 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /auth/onboard/verify-otp-phone` | Y | lib/onboarding.ts:128 | auth.go:54 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /auth/profile/init` | Y | lib/onboarding.ts:149 | auth.go:56 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /auth/profile/photo` | Y | lib/onboarding.ts:192 | auth.go:63 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /auth/security-questions/save` | Y | lib/onboarding.ts:154 | auth.go:57 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /auth/security-questions/verify` | Y | lib/onboarding.ts:202 | auth.go:59 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /auth/send-otp` | Y | app/(constants)/authService.ts:115 | auth.go:40 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /auth/send-otp-phone` | Y | app/(constants)/authService.ts:153 | auth.go:45 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |

### stories — 9

| Contract | Req | Client site | Go handler | Landmines | Risk | Reason |
|---|---|---|---|---|---|---|
| `DELETE /stories/{}` | - | lib/chatService.ts:1780 | stories.go:31 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /stories/audience` | - | lib/chatService.ts:1741 | stories.go:27 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /stories/feed` | - | lib/chatService.ts:1768 | stories.go:24 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /stories/privacy` | - | lib/chatService.ts:1731 | stories.go:25 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /stories/{}/key` | - | lib/chatService.ts:1759 | stories.go:30 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /stories/{}/views` | - | lib/chatService.ts:1772 | stories.go:28 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /stories` | Y | lib/chatService.ts:1721 (+2) | stories.go:23 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /stories/{}/viewed` | - | lib/chatService.ts:1776 | stories.go:29 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `PUT /stories/privacy` | Y | lib/chatService.ts:1735 | stories.go:26 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |

### calls — 9

| Contract | Req | Client site | Go handler | Landmines | Risk | Reason |
|---|---|---|---|---|---|---|
| `GET /calls/history` | - | lib/callSession.ts:206 | call_sessions.go:59 | EPOCH ISO | HIGH | epoch-ms int64 timestamps in a backend whose default is ISO strings — unit is ambiguous |
| `GET /calls/{}` | - | lib/callSession.ts:190 | call_sessions.go:60 | EPOCH ISO | HIGH | epoch-ms int64 timestamps in a backend whose default is ISO strings — unit is ambiguous |
| `POST /calls` | Y | lib/callSession.ts:89 | call_sessions.go:56 | EPOCH ISO | HIGH | epoch-ms int64 timestamps in a backend whose default is ISO strings — unit is ambiguous |
| `POST /calls/{}/end` | - | lib/callSession.ts:150 | call_sessions.go:62 | EPOCH ISO | HIGH | epoch-ms int64 timestamps in a backend whose default is ISO strings — unit is ambiguous |
| `POST /calls/{}/hand` | Y | lib/callSession.ts:174 | call_sessions.go:64 | EPOCH ISO | HIGH | epoch-ms int64 timestamps in a backend whose default is ISO strings — unit is ambiguous |
| `POST /calls/{}/leave` | - | lib/callSession.ts:144 | call_sessions.go:61 | EPOCH ISO | HIGH | epoch-ms int64 timestamps in a backend whose default is ISO strings — unit is ambiguous |
| `POST /calls/{}/ring` | Y | lib/callSession.ts:127 | call_sessions.go:66 | EPOCH ISO | HIGH | epoch-ms int64 timestamps in a backend whose default is ISO strings — unit is ambiguous |
| `POST /calls/{}/role` | Y | lib/callSession.ts:157 | call_sessions.go:63 | EPOCH ISO | HIGH | epoch-ms int64 timestamps in a backend whose default is ISO strings — unit is ambiguous |
| `POST /calls/{}/sfu-token` | - | lib/call/sfuToken.ts:57 | call_sessions.go:65 | EPOCH ISO | HIGH | epoch-ms int64 timestamps in a backend whose default is ISO strings — unit is ambiguous |

### vaultbeam — 8

| Contract | Req | Client site | Go handler | Landmines | Risk | Reason |
|---|---|---|---|---|---|---|
| `GET /vaultbeam/relay/{}` | - | lib/vaultbeamRelay.ts:63 | vaultbeam.go:512 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /vaultbeam/relay/abort` | Y | lib/vaultbeamRelay.ts:82 | vaultbeam.go:514 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /vaultbeam/relay/block-url` | Y | lib/vaultbeamRelay.ts:57 | vaultbeam.go:508 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /vaultbeam/relay/complete` | Y | lib/vaultbeamRelay.ts:75 | vaultbeam.go:513 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /vaultbeam/relay/grow` | Y | lib/vaultbeamRelay.ts:54 | vaultbeam.go:510 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /vaultbeam/relay/init` | Y | lib/vaultbeamRelay.ts:48 | vaultbeam.go:507 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /vaultbeam/relay/received` | Y | lib/vaultbeamRelay.ts:68 | vaultbeam.go:511 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /vaultbeam/relay/uploaded` | Y | lib/vaultbeamRelay.ts:60 | vaultbeam.go:509 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |

### contacts — 7

| Contract | Req | Client site | Go handler | Landmines | Risk | Reason |
|---|---|---|---|---|---|---|
| `DELETE /contacts/trusted/{}` | - | lib/chatService.ts:1277 | contacts.go:43 | - | LOW | scalars only, no landmine found |
| `GET /contacts/sync/{}` | - | lib/chatService.ts:1291 | contacts.go:39 | - | LOW | scalars only, no landmine found |
| `GET /contacts/trusted` | - | lib/chatService.ts:1271 | contacts.go:41 | - | LOW | scalars only, no landmine found |
| `POST /contacts/match` | Y | lib/chatService.ts:2721 | contacts.go:37 | - | LOW | scalars only, no landmine found |
| `POST /contacts/sync/create` | - | lib/chatService.ts:1288 | contacts.go:38 | - | LOW | scalars only, no landmine found |
| `POST /contacts/sync/verify` | Y | lib/chatService.ts:1294 | contacts.go:40 | - | LOW | scalars only, no landmine found |
| `POST /contacts/trusted` | Y | lib/chatService.ts:1274 | contacts.go:42 | - | LOW | scalars only, no landmine found |

### uploads — 7

| Contract | Req | Client site | Go handler | Landmines | Risk | Reason |
|---|---|---|---|---|---|---|
| `GET /uploads/multipart/{}/parts` | - | lib/resumableUpload.ts:92 | uploads.go:145 | - | LOW | scalars only, no landmine found |
| `POST /uploads/multipart/abort` | Y | lib/resumableUpload.ts:75 | uploads.go:147 | - | LOW | scalars only, no landmine found |
| `POST /uploads/multipart/complete` | Y | lib/resumableUpload.ts:126 | uploads.go:146 | - | LOW | scalars only, no landmine found |
| `POST /uploads/multipart/init` | Y | lib/resumableUpload.ts:61 | uploads.go:143 | - | LOW | scalars only, no landmine found |
| `POST /uploads/multipart/part-urls` | Y | lib/resumableUpload.ts:108 | uploads.go:144 | - | LOW | scalars only, no landmine found |
| `POST /uploads/{}/revoke` | - | lib/chatService.ts:2933 | uploads.go:150 | - | LOW | scalars only, no landmine found |
| `POST /uploads/{}/viewed` | - | lib/chatService.ts:2919 | uploads.go:149 | - | LOW | scalars only, no landmine found |

### channels — 5

| Contract | Req | Client site | Go handler | Landmines | Risk | Reason |
|---|---|---|---|---|---|---|
| `GET /channels` | - | lib/chatService.ts:1318 | channels.go:28 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `GET /channels/{}/posts` | - | lib/chatService.ts:1333 | channels.go:31 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /channels` | Y | lib/chatService.ts:1321 | channels.go:29 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /channels/join` | Y | lib/chatService.ts:1324 | channels.go:30 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /channels/{}/posts` | Y | lib/chatService.ts:1336 | channels.go:32 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |

### chat-codes — 4

| Contract | Req | Client site | Go handler | Landmines | Risk | Reason |
|---|---|---|---|---|---|---|
| `DELETE /chat-codes` | - | lib/chatService.ts:1976 | chat_codes.go:64 | - | LOW | scalars only, no landmine found |
| `GET /chat-codes` | - | lib/chatService.ts:1971 | chat_codes.go:63 | - | LOW | scalars only, no landmine found |
| `POST /chat-codes` | Y | lib/chatService.ts:1964 | chat_codes.go:62 | - | LOW | scalars only, no landmine found |
| `POST /chat-codes/{}/join` | - | lib/chatService.ts:1995 | chat_codes.go:67 | - | LOW | scalars only, no landmine found |

### games — 4

| Contract | Req | Client site | Go handler | Landmines | Risk | Reason |
|---|---|---|---|---|---|---|
| `DELETE /games/tables` | - | lib/games/useLiveTables.ts:79 | games.go:102 | - | LOW | scalars only, no landmine found |
| `GET /games/tables` | - | lib/games/useLiveTables.ts:43 | games.go:101 | - | LOW | scalars only, no landmine found |
| `POST /games/launch-token` | - | lib/gamesSocket.ts:49 | games.go:94 | - | LOW | scalars only, no landmine found |
| `POST /games/voice-token` | Y | lib/games/useTableVoice.ts:257 | games.go:109 | - | LOW | scalars only, no landmine found |

### communities — 4

| Contract | Req | Client site | Go handler | Landmines | Risk | Reason |
|---|---|---|---|---|---|---|
| `GET /communities` | - | lib/chatService.ts:2569 | communities.go:19 | - | LOW | scalars only, no landmine found |
| `GET /communities/{}` | - | lib/chatService.ts:2575 | communities.go:20 | - | LOW | scalars only, no landmine found |
| `POST /communities` | Y | lib/chatService.ts:2572 | communities.go:18 | - | LOW | scalars only, no landmine found |
| `POST /communities/{}/groups` | Y | lib/chatService.ts:2578 | communities.go:21 | - | LOW | scalars only, no landmine found |

### invitations — 4

| Contract | Req | Client site | Go handler | Landmines | Risk | Reason |
|---|---|---|---|---|---|---|
| `GET /invitations` | - | lib/chatService.ts:2303 | chats_invitations.go:52 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /invitations/redeem` | Y | lib/chatService.ts:2330 | chats_invitations.go:53 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /invitations/{}/accept` | - | lib/chatService.ts:2314 | chats_membership.go:45 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |
| `POST /invitations/{}/reject` | - | lib/chatService.ts:2318 | chats_invitations.go:54 | ISO | LOW | timestamps only (httpx.JSTime ISO) — well-defined, one convention |

### nav — 4

| Contract | Req | Client site | Go handler | Landmines | Risk | Reason |
|---|---|---|---|---|---|---|
| `GET /nav/geocode` | - | lib/nav/geocode.ts:12 | nav.go:24 | DYN | MEDIUM | carries json.RawMessage / map[string]any with no typed shape |
| `POST /nav/matrix` | Y | lib/nav/routing.ts:220 | nav.go:25 | DYN | MEDIUM | carries json.RawMessage / map[string]any with no typed shape |
| `POST /nav/route` | Y | lib/nav/routing.ts:135 (+1) | nav.go:23 | DYN | MEDIUM | carries json.RawMessage / map[string]any with no typed shape |
| `POST /nav/trace` | Y | lib/nav/routing.ts:249 | nav.go:26 | DYN | MEDIUM | carries json.RawMessage / map[string]any with no typed shape |

### call — 3

| Contract | Req | Client site | Go handler | Landmines | Risk | Reason |
|---|---|---|---|---|---|---|
| `POST /call/cancel` | Y | lib/CallService.ts:178 | calls.go:24 | EPOCH | HIGH | epoch-ms int64 timestamps in a backend whose default is ISO strings — unit is ambiguous |
| `POST /call/initiate` | Y | lib/CallService.ts:169 | calls.go:23 | EPOCH | HIGH | epoch-ms int64 timestamps in a backend whose default is ISO strings — unit is ambiguous |
| `POST /call/token` | Y | lib/CallService.ts:69 | calls.go:22 | **COLD** EPOCH | HIGH | cold-start critical path — a decode regression is a boot failure, not a screen failure |

### gif — 1

| Contract | Req | Client site | Go handler | Landmines | Risk | Reason |
|---|---|---|---|---|---|---|
| `GET /gif/search` | - | components/GifPicker.tsx:81 | gif.go:59 | - | LOW | scalars only, no landmine found |

### link — 1

| Contract | Req | Client site | Go handler | Landmines | Risk | Reason |
|---|---|---|---|---|---|---|
| `GET /link/preview` | - | components/LinkPreview.tsx:29 | link.go:45 | - | LOW | scalars only, no landmine found |

### app — 1

| Contract | Req | Client site | Go handler | Landmines | Risk | Reason |
|---|---|---|---|---|---|---|
| `POST /app/usage` | Y | lib/usageCounter.ts:126 | usage.go:74 | **COLD** | HIGH | cold-start critical path — a decode regression is a boot failure, not a screen failure |

### golive — 1

| Contract | Req | Client site | Go handler | Landmines | Risk | Reason |
|---|---|---|---|---|---|---|
| `POST /golive/invite/{}` | Y | lib/broadcast.ts:351 | golive_invites.go:63 | - | LOW | scalars only, no landmine found |

---

## 4a. Bypass exceptions — the 4.6 verdicts

Appended by Wave 4.6. §4 above listed the six bypasses as *found*; this section
records what was *decided* about each, after reading what `lib/api.ts` actually
supports rather than assuming. One was routed. Five are exceptions, each with a
reason and a stated retirement condition — or none, where the constraint is
real.

Guarded by `lib/apiBypasses.selftest.ts`, which fails when a **seventh** bypass
appears. A document cannot do that half.

| # | Site | Verdict |
|---|---|---|
| 1 | `lib/chatService.ts:1989` `GET /user/export` | EXCEPTION — retirable |
| 2 | `lib/chatService.ts:2900-2919` `POST /uploads` (no-progress) | **ROUTED through `api()`** |
| 3 | `lib/chatService.ts:2952` `POST /uploads` (XHR progress) | EXCEPTION — permanent |
| 4 | `app/face-verify-new-device.tsx:61` `POST /api/face/verify` | EXCEPTION — retirable (dead route) |
| 5 | `services/deviceService.ts:62` `POST /api/face/check-device` | EXCEPTION — retirable (dead route) |
| 6 | `services/deviceService.ts:83` `POST /api/face/trust-device` | EXCEPTION — retirable (dead route) |

### 1. `GET /user/export` — `lib/chatService.ts:1989` — EXCEPTION

**Reason.** `exportMyData()` returns a **`string`**, and its caller depends on
that: `app/settings.tsx:172` writes it straight to disk with
`writeAsStringAsync(dest, json, { encoding: 'utf8' })`. `api()` has exactly one
response path for a non-protobuf call — `res.text()` then `JSON.parse(text)`
(`api.ts:599-601`) — and the export body **is** valid JSON, so `api()` would
return a parsed **object**. `writeAsStringAsync` would then write
`"[object Object]"` and the user's GDPR export would be a 15-byte file. The
byte-for-byte contract in the function's own comment is not decoration; it is
what makes the on-disk artifact match what the server sent.

Routing it would also change the error text: today
`Export failed (503): <first 200 bytes>`, via `api()` just the server's
`error` field or `HTTP 503`. `app/settings.tsx:178` shows that string to the
user verbatim.

**RETIREMENT CONDITION.** `lib/api.ts` gains a response-shape opt-in that
returns the raw body untouched — the same shape `proto` already uses, a caller
option rather than a registry (e.g. `text?: true` returning `string`). Then
this becomes `api<string>('/user/export', { text: true })` and picks up the 401
refresh and X-Device-Id with no behaviour delta. Blocked only by file ownership
in this wave — `lib/api.ts` was not editable here.

**What it loses meanwhile:** 401 refresh-and-retry, X-Device-Id, and the 30s
abort backstop. An expired access token makes the export button fail with
`Export failed (401)` instead of refreshing and succeeding.

### 2. `POST /uploads` (no-progress path) — ROUTED

`api()` already special-cases a `FormData` body (`api.ts:309`): it passes the
body through untouched, so React Native still sets `multipart/form-data` and
the boundary itself, and it **deliberately skips** the 30s abort backstop for
uploads. That is precisely what this call site was doing by hand, which is why
routing it is behaviour-preserving rather than lossy.

Same method, same `?viewOnce=1&purpose=…` query string, same `file` field name,
same `Authorization: Bearer` (now attached by `api()` instead of by hand), same
caller `AbortSignal`, same parsed-JSON return. The pre-existing
`if (!token) throw new Error('Not signed in')` guard is untouched — the XHR
path below still needs the header it builds.

**Gained:** 401 refresh-and-retry, `X-Device-Id`, `err.body`, `err.status`.

**One deliberate delta, called out.** `err.status` did not exist on this path
before (the old hand-rolled `catch` threw a bare `Error`), and
`lib/mediaOutbox.ts:37` keys `isPermanent()` off exactly that field. So a 413
on this path used to look transient and burned all 8 retry attempts; now it
fails fast. This matches what the XHR path has always done — `chatService.ts`
sets `err.status` there explicitly, with a comment naming this same
`isPermanent` behaviour as the reason. The change makes the two upload paths
agree; it does not invent a new policy. The blast radius is small in practice:
`mediaOutbox` sends through `sendMedia`/`mediaAttachments`, which pass
`onProgress` and therefore take the XHR path. The fetch path's live callers are
`status.tsx:290`, `profile.tsx:166`, `group-info.tsx:202` and
`onboarding.ts:191`, which all render `e?.message` in an `Alert` and never read
`.status`.

### 3. `POST /uploads` via XMLHttpRequest — `lib/chatService.ts:2952` — EXCEPTION, PERMANENT

**Reason.** `fetch` reports no upload progress. React Native's `fetch` is a
polyfill over this very `XMLHttpRequest`, and only the XHR exposes
`upload.onprogress`. `api()` is built on `fetch`, so there is no version of
"route it through `api()`" that keeps the progress ring — the sender-side
percentage on every photo, video and document send (`UPLOAD_PROGRESS`,
`constants/flags.ts:153`, on) would simply stop updating. That is a real
platform constraint, not an unwillingness to refactor.

**No retirement condition worth writing down.** It would take `fetch` gaining a
request-body progress stream in React Native's Android and iOS networking
modules — not a change this codebase can make or schedule.

**What it loses:** the 401 refresh-and-retry, `expectedUserId`, and
`X-Device-Id`. A 401 mid-upload fails the send rather than refreshing and
retrying; `mediaOutbox` then treats it as transient, so it recovers on a later
attempt once some other request has refreshed the token. Not a correctness
hole, but a slower and noisier path than the funnel's.

*Not done here on purpose:* those three could be replicated by hand inside
`postWithProgress` (read the device id, attach the header, call
`refreshAccessToken()` on a 401 and re-send). That is a behaviour change to the
media send path and was not in scope for 4.6.

### 4–6. `POST /api/face/*` — EXCEPTION, retirable — **and see §4b**

> **RESOLVED BY DELETION (post-4.6).** Retirement condition (a) was taken:
> `app/face-verify-new-device.tsx`, `app/facescan.tsx` and `services/faceService.ts`
> are deleted, and `isKnownDevice` / `trustCurrentDevice` / `clearDeviceTrust`
> (with `KNOWN_DEVICES_KEY`) are removed from `services/deviceService.ts`.
> No `/api/face/*` call site remains. `getDeviceId` / `getDeviceInfo` were kept.
> The finding below is retained as history.

`app/face-verify-new-device.tsx:61`, `services/deviceService.ts:62`,
`services/deviceService.ts:83`.

**Reason — these routes do not exist.** The `/api` prefix was recorded in §4
as "a different mux". It is not a different mux; it is **no mux**. The Go
backend registers no `/api/*` route anywhere — the only `"/api` literal in
`vaultchat-backend-go` is `nav.go:228`, and that is a string it sends to an
*upstream* Valhalla server. There is no face handler in the backend at all.
The shape these three call is the Express/Firestore sketch in
`FIREBASE_CRUD_FIXES.md:495` (`localhost:5000`), which was never built.

They therefore cannot be "routed through `api()`" in any meaningful sense —
there is nothing at the other end to route to. Routing them would also change
behaviour three ways: `api()` hard-codes `SERVER_URL` while `deviceService`
takes `serverUrl` as a **parameter**; `api()` attaches a Bearer token these
calls do not send today; and `api()` **throws** on a non-2xx, while both
`deviceService` functions swallow the failure in a `catch` and fall back to a
local cache.

**RETIREMENT CONDITION — one of two, and deletion is the cheaper one.**
(a) Delete the three call sites and the screen. `isKnownDevice` has **zero**
callers; `trustCurrentDevice` has exactly one, from a screen that
`lib/orphanRoutes.selftest.ts:150` pins as reachable from **nowhere** and
requires to stay that way (`'/face-verify-new-device': []`), because it is
built on `generateMockFaceVector`. Or (b) implement `/face/*` on the Go backend
under the normal prefix, then route all three through `api()`. Not done in this
wave: the screen and both functions are referenced by three existing selftests,
so deleting them is its own change with its own blast radius, not a side effect
of 4.6.

## 4b. SECURITY FINDING — the face-verification path is a client-side decision against a route that does not exist

> **RESOLVED BY DELETION (post-4.6).** All three call sites and both screens are
> gone; the local `"trusted"` SecureStore marker is no longer written by any code.
> The recommendation below was applied as written. Retained as history.

Raised by Wave 4.6 while resolving bypasses 4–6. **Nothing was changed. This is
for a human to decide.**

Three facts, each verifiable from the source:

1. **`app/face-verify-new-device.tsx:66-75`** posts to a route the backend does
   not serve, reads `data.match` off whatever comes back, and grants access on
   truthiness. A 404 body has no `match`, so today this **always fails closed** —
   correct outcome, for the wrong reason. The authorisation decision is made on
   the client from an unauthenticated response body. If `/api/face/verify` is
   ever implemented, or if anything between the phone and the server can answer
   `{"match":true}`, this is a full account-takeover gate on a **mock** face
   vector (`generateMockFaceVector`, `services/faceService.ts`).
2. **`services/deviceService.ts:83-88`** — `trustCurrentDevice` writes
   `KNOWN_DEVICES_KEY = "trusted"` to SecureStore on the line **after** the
   unawaited-for-success `fetch`, inside the same `try` whose `catch` is empty.
   With the route 404ing, `fetch` resolves (a 404 is not a rejection), so the
   local trust marker is set with no server involvement whatsoever.
3. **`services/deviceService.ts:56-74`** — `isKnownDevice` falls back to that
   same local marker when the server is unreachable, so a device can attest its
   own trust. It has **no callers**, which is the only reason (2) is not live.

None of these is a bypass `api()` would have fixed — `api()` supplies session
auth, not this flow's authorisation logic. The exposure today is **nil**: the
screen is unrouted and guarded as unrouted, and `isKnownDevice` is dead. The
finding is that the code is one route registration away from being a real hole,
and the guard currently holding it shut is a 404.

**Recommendation (not applied):** delete all three, per retirement condition
(a) above. If the flow is wanted, the match decision belongs server-side behind
the normal authenticated prefix, and the local `"trusted"` write must move
inside the success branch.
