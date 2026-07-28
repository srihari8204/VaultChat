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

## Baseline (before) — FILL IN from device

| Metric | Value |
|---|---|
| First message to a NEW peer — tap→encrypt | ___ ms |
| First message to a NEW peer — encrypt→ack | ___ ms |
| Subsequent message (warm session) — tap→encrypt | ___ ms |
| Subsequent message (warm session) — encrypt→ack | ___ ms |
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
