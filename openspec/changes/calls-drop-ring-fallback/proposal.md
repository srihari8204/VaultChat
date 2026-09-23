## Why

`calls-64-participant` task 4.5 shipped the group ring with a deliberate safety
net: the client calls `ringCallGroup` (`POST /calls/{id}/ring`), and on any
failure **except 429** it falls back to the per-`to` socket loop
(`signal.ringPeers`). That fallback existed because the endpoint was new and
unproven on prod — if the binary carrying it had not actually been live, a group
call would have rung nobody at all.

That risk is now spent. The endpoint was deployed and hash-verified on
2026-08-31 (`call_sessions.go`, md5 `eb602bfd…`), and the 8.1 fix on top of it
(md5 `4ed5fd76…`) is live as well. `POST /calls/{id}/ring` answers 401 through
the public chain, so it is routed and reachable.

Keeping the fallback past that point is not free:

- **It is a second ring path.** Task 4.3 removed `ring_group`/`ring_group_ok`
  from `handlers.go` specifically so there would be ONE. The client fallback
  quietly reintroduces a second one, with different semantics — the socket loop
  emits only, so it cannot wake a dozing phone (7.1). A partial endpoint failure
  therefore degrades to the exact behaviour 7.1 was written to fix, silently.
- **It spends the ring budget differently.** One endpoint call is one unit
  whatever the call size; the loop is one per recipient. A transient 5xx on a
  64-seat call turns one unit into 63.
- **It hides a real outage.** If the endpoint starts failing, the fallback masks
  it and nobody sees the regression until the budget runs out.

## What Changes

- Remove the `signal.ringPeers` fallback from `ringCallGroup` in
  `lib/callSession.ts`. A failed ring surfaces as a failed ring.
- Keep the 429 branch as it already behaves (no fallback), since that path is
  already correct and its reasoning is unchanged.
- Keep `signal.ringPeers` itself if the 1:1 path still uses it; this change
  removes only the group fallback, not the function.

## Blocked on

`calls-64-participant` task **5.6** — two 64-member group calls started inside
one rate-limit window must both ring everyone, on real devices. Until the
endpoint is proven under its own budget on hardware, the fallback is still
earning its place. Do not land this change before 5.6 passes.

## Not doing

Removing the mesh topology fallback. That is a separate question, gated on
`calls-64-participant` task 5.8 (the OEM matrix), and it protects against SFU
unavailability rather than against an unproven endpoint.
