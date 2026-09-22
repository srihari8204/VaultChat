# Implementation plan — drop the group-ring socket fallback

Gated: **do not start until `calls-64-participant` task 5.6 passes on devices.**

- [ ] 1.1 Confirm 5.6 passed and record where — **device-verified**
- [ ] 1.2 Remove the `signal.ringPeers` fallback branch from `ringCallGroup`
      (`lib/callSession.ts`); leave the 429 branch as it is — **written**
- [ ] 1.3 Confirm `signal.ringPeers` still has a caller (the 1:1 path). If it
      does not, delete it too rather than leaving a dead export — **written**
- [ ] 1.4 A failed ring must reach the user as a failed ring, not a silent
      no-op: check what `group-calls.tsx` renders when `ringCallGroup` throws — **written**
- [ ] 1.5 `npx tsc --noEmit` clean and the call selftests still pass — **written**
- [ ] 1.6 Start a group call with the endpoint reachable: everyone rings — **device-verified**
- [ ] 1.7 Start one with the endpoint forced to fail: the caller sees a failure,
      and no phone is rung twice by a second path — **device-verified**
