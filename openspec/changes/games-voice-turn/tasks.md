# Tasks

## 1. Feed VaultChat's TURN into game table voice

- [x] 1.1 Import `getIceServers` from `lib/iceConfig` into `lib/games/useTableVoice.ts`.
- [x] 1.2 In the existing ICE `useEffect`, call `getIceServers()` alongside the
      `/config.js` fetch. Each source applies independently; neither blocks nor
      rejects the other, and both remain best-effort.
- [x] 1.3 Merge into `iceServers.current` as a union deduped on
      `JSON.stringify(urls)`, keeping the games server's entries rather than
      replacing them.
- [x] 1.4 Guard both with the existing `ok` liveness flag so a resolve after
      unmount does not write to the ref.
- [x] 1.5 Confirm the consumer is unchanged — `new RTC.RTCPeerConnection({ iceServers: iceServers.current })`
      is still the single read.

## 2. Prove the wiring holds

- [x] 2.1 Add `lib/games/turnWiring.selftest.ts`, modelled on
      `lib/golive/turnWiring.selftest.ts`: assert `useTableVoice.ts` imports
      `getIceServers` from `../iceConfig` and uses it inside the ICE effect.
- [x] 2.2 Assert `DEFAULT_ICE` still exists as the first-frame fallback, so a
      failed fetch cannot leave the list empty.

## 3. Prove the mesh covers a full table

- [x] 3.1 In `lib/games/voiceMesh.selftest.ts`, add a **6-peer rummy** roster:
      every pair has exactly one initiator, nobody dials themselves, all five
      peers are reachable from each seat.
- [x] 3.2 Add the same at **4 peers for ludo**.
- [x] 3.3 Assert `rosterFrom` drops bots and self from a mixed 6-seat table, so
      bot seats are never dialled.

## 4. Verify

- [x] 4.1 `npm run test:games` passes — capture the real exit code to a log, do
      not read a piped tail.
- [x] 4.2 `npx tsc --noEmit` clean for the touched files.
- [x] 4.3 Build the arm64 APK and confirm `GRADLE_EXIT=0` from the log plus a
      fresh APK mtime.
- [x] 4.4 Install to both phones and verify by **md5**, not timestamp.

## 5. Device verification (owner-gated — cannot be closed from here)

- [ ] 5.1 Two accounts, two phones, same table: confirm each hears the other.
      Blocked today — the Redmi's account fails `409 User has no VaultID` and
      MIUI refuses adb input.
- [ ] 5.2 Confirm a relay candidate is actually selected on a network that
      blocks direct P2P (mobile data, not shared wifi).
- [ ] 5.3 Watch coturn load while a table is up, to answer the capacity
      question in design.md.
