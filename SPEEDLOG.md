# SPEEDLOG — VaultChat messaging performance

Before/after numbers from the Task 1 instrumentation (`lib/perf.ts`). Capture
on the primary device (GMS Android). Read them off the hidden **Diagnostics**
screen (Profile → long-press "VaultChat 1.1.1") or from logcat:

```
adb logcat | grep -E "SEND|socket_connect|db_ready"
```

Each send prints:
```
SEND id=<id> tap→encrypt=<A>ms encrypt→ack=<B>ms total=<A+B>ms transport=websocket
```
- **tap→encrypt** — E2EE encryption time (X3DH bundle fetch on first message to a
  peer, then Double-Ratchet). Large values here = the key-bundle round-trip is
  the bottleneck, NOT the network POST.
- **encrypt→ack** — the HTTP POST round-trip to the server.

> Note on architecture: VaultChat sends messages by **HTTP POST**, not a socket
> emit. The socket carries receive/presence/typing/calls. So the spec's
> `socket_emit → server_ack` is realised here as `encrypt → http_ack`.

---

## Baseline — measured

Two of the four send-path segments can be measured off-device and are filled in
below. The remaining rows need a handset and are marked as such — they are the
only ones still unknown.

### Crypto (`tap→encrypt`, minus the bundle-fetch RTT)

`npm run bench:e2ee` — the app's own `services/crypto/e2ee.ts` (pure `@noble`,
identical code path in Hermes). Ranges are across runs on an otherwise busy box.

| Metric | Value | Measured on |
|---|---|---|
| X3DH initiator — first message to a NEW peer | **9–12 ms** | 2026-08-08, node 24 / win32-x64 |
| X3DH responder — first inbound from a new peer | **5–8 ms** | ” |
| `ratchetEncrypt` — warm session | **0.07 ms** (~14,000/s) | ” |
| `ratchetDecrypt` — warm session | **0.06 ms** (~17,000/s) | ” |
| 1,000 warm encrypts | **70–76 ms** | ” |

Device caveat: a mid-range Android under Hermes runs roughly 3–5× slower than
this desktop, so expect ~40–60 ms for the X3DH step and ~0.3 ms per warm
message. Crypto is **not** the send-path bottleneck at any load this app sees —
a warm send spends ~0.1 ms encrypting against a ~40 ms server round-trip. If a
device shows seconds on `tap→encrypt`, it is the key-bundle fetch RTT (which
this bench excludes), not the maths.

### Server (`encrypt→ack`)

From `vaultchat-backend/loadtest/REPORT.md` (2026-07-26, compose stack on a
Docker Desktop VM — a weaker box than prod, so these are upper bounds):

| Metric | Value |
|---|---|
| `POST /chats/:id/messages` p95 @ ≤50 msg/s | **41–46 ms** |
| `/chats` (authed) p50 / p95 / p99 @ 100 VUs | **11 / 33 / 52 ms** |
| Socket delivery p50 / p95 @ 2,500 deliveries/s | **21 / 54 ms** |
| Single-process fan-out knee | **~3,000 deliveries/s** |
| Idle sockets held (5,000 target) | **5,000, 0 drops, ~20 KB each** |

### Still device-only — FILL IN

Read from the hidden Diagnostics screen (Profile → long-press "VaultChat 1.1.1")
or `adb logcat | grep -E "SEND|socket_connect|db_ready"`.

| Metric | Value |
|---|---|
| First message to a NEW peer — tap→encrypt (incl. bundle fetch RTT) | ___ ms |
| Subsequent message (warm session) — tap→encrypt | ___ ms (expect ~0.3) |
| Socket transport at steady state | ___ (expect: websocket) |
| Chat-list cold-open render (spinner visible?) | ___ |
| Chat-screen open render (spinner visible?) | ___ |
| Reconnect time after airplane-mode toggle | ___ s |

## After migration (op-sqlite + outbox + FlashList) — FILL IN

| Metric | Value |
|---|---|
| Optimistic bubble appears | 0 ms (renders from DB before any network) |
| First message to a NEW peer — encrypt→ack | ___ ms |
| Subsequent message — encrypt→ack | ___ ms |
| Chat-list cold-open render | instant (from `chatRepo`) |
| Chat-screen open render (500 msgs) | instant (from `messageRepo`) |
| Airplane-mode send → tick on reconnect | ___ s (no user action) |

---

## Interpretation guide
- If **tap→encrypt** dominates (e.g. >3s on first message): the fix is warming
  the E2EE session (prefetch the peer key bundle when the chat opens, before the
  user hits send), not the outbox. Optimistic UI still hides it, but the tick
  will lag until the session is warm.
- If **encrypt→ack** dominates: server/network POST latency — the outbox +
  optimistic UI make it invisible (bubble at 0ms, tick when the ack lands).
