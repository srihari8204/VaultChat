# C1 — LiveKit compatibility spike

**Verdict: GO, but not as one change.** The LiveKit WebRTC fork is a
*replacement* for `react-native-webrtc`, not an addition, so swapping it touches
1:1 calls, the mesh group call and VaultBeam all at once — before a single line
of SFU code exists. Sequence it as two independent changes, not one.

The question this spike had to answer was: *does the LiveKit fork break
VaultBeam's Tier-2 data channels?* Answer: **no**, and the reasoning is below.
A second finding changes the plan more than the first one does.

Evidence is from `@livekit/react-native-webrtc@144.1.2` unpacked and compared
against the installed `react-native-webrtc@124.0.7`. Nothing was installed into
the app; this is a read-only investigation, which is what a spike is for.

---

## 1. It cannot coexist. It replaces.

Both packages ship the **same native classes under the same names**:

| | upstream 124.0.7 | LiveKit fork 144.1.2 |
|---|---|---|
| Java package | `com.oney.WebRTCModule` | `com.oney.WebRTCModule` |
| RN module name | `"WebRTCModule"` | `"WebRTCModule"` |
| iOS sources | `ios/RCTWebRTC/WebRTCModule.h` | `ios/RCTWebRTC/WebRTCModule.h` |
| Pod name | `react-native-webrtc` | `livekit-react-native-webrtc` |

The pod *names* differ, which is why both can appear in a lockfile — but the
classes inside collide. Installing both gives Android two copies of
`com.oney.WebRTCModule.WebRTCModule` (duplicate class at dex time) and iOS two
pods vending the same Objective-C symbols, both registering the same React
Native module name.

So there is no "add LiveKit alongside" option. `react-native-webrtc` comes out,
the fork goes in, and **every** WebRTC path in the app moves with it: the 1:1
calls, the mesh group call, and VaultBeam's direct transfer.

## 2. VaultBeam survives the swap

`lib/vaultBeamDirect.ts` needs a specific, small API surface. All of it is
present, with matching semantics:

| VaultBeam uses | In the fork |
|---|---|
| `createDataChannel('vaultbeam', {ordered:true})` | ✅ `_ordered` honoured, `ordered` getter |
| `dc.send(string)` — JSON control frames | ✅ `send(data: string)` |
| `dc.send(Uint8Array)` — 16 KiB payload frames | ✅ `send(data: ArrayBufferView)`, converted for transport |
| `dc.bufferedAmount` — the 4 MiB backpressure ceiling | ✅ `_bufferedAmount` + getter |
| `pc.ondatachannel` | ✅ event attribute present |
| `RTCPeerConnection` / `RTCIceCandidate` / `RTCSessionDescription` | ✅ all three |

Diffing the two implementations of `RTCDataChannel.ts` and
`RTCPeerConnection.ts` shows the changes are **mechanical, not behavioural**:
the fork vendored `event-target-shim` and replaced `defineEventAttribute` with
explicit getter/setter pairs. Nothing in the data path differs.

The JS API is a strict **superset** of what the app imports today
(`mediaDevices`, `RTCPeerConnection`, `RTCIceCandidate`, `RTCSessionDescription`,
`RTCView`, `RTCRtpSender`, `MediaStream`, `MediaStreamTrack`,
`registerGlobals`). So the swap needs **no import changes anywhere** — it is a
package.json edit plus a rebuild.

Bonus, unrelated to the SFU: the fork ships `ScreenCapturePickerView`, which is
the missing piece for **iOS screen share** — currently Android-only because
`getDisplayMedia` has no iOS path. That gap closes for free.

## 3. The finding that changes the plan: frame-level E2EE

The fork adds seven modules upstream does not have:

```
RTCFrameCryptor.ts          RTCFrameCryptorFactory.ts
RTCKeyProvider.ts           RTCDataPacketCryptor.ts
RTCDataPacketCryptorFactory.ts
AudioDeviceModule.ts        AudioDeviceModuleEvents.ts
```

`RTCFrameCryptor` is insertable-streams media encryption: frames are encrypted
**before** they reach the SFU and decrypted after they leave it, so the server
forwards media it cannot read. `RTCKeyProvider` carries per-participant keys
with ratcheting — `setKey(participantId, key, keyIndex)`,
`ratchetKey(participantId)`, plus `sharedKey`, `ratchetSalt`,
`ratchetWindowSize`, `failureTolerance` and a `keyRingSize` defaulting to 16.

**This contradicts, in the good direction, the trade-off I described earlier.**
I said an SFU forces a choice between E2EE, server-side recording, and unlimited
HLS audience — pick two. That is still true for *recording and broadcast*, but
it is **not** true for the primary case. A 64-participant group call can be
end-to-end encrypted through the SFU. The server sees ciphertext.

It also fits what this codebase already does. `lib/callCrypto.ts` mints a
per-call 32-byte key wrapped once through the Double Ratchet; that key is
exactly the shape `RTCKeyProvider.setKey` wants. The existing key exchange
carries over — the SFU changes the *transport*, not the key agreement.

## 4. The actual risk: 124 → 144

Not the API. The media stack underneath it.

```
upstream 124.0.7  →  org.jitsi:webrtc:124.+
fork     144.1.2  →  io.github.webrtc-sdk:android:144.7559.05
```

Twenty libwebrtc milestones. That is where ICE behaviour, SDP munging
tolerances, codec negotiation and hardware encoder selection can shift under
you. None of it is visible in a diff, and none of it can be tested in this
container.

It is also why **the swap must not ride along with the SFU feature**. If a call
regresses after a combined change, you cannot tell whether it was the new
library or the new transport. Separated, each has one suspect.

---

## Recommended sequence

**C1a — library swap, no new features.** Replace `react-native-webrtc` with
`@livekit/react-native-webrtc`. No import changes, no flag, no SFU. Then run the
full `docs/CALL_DEVICE_VALIDATION.md` pass — every stage, because this touches
1:1, mesh and VaultBeam alike — plus VaultBeam Tier-2 transfers of a few hundred
MB in both directions, watching for stalls at the 4 MiB backpressure ceiling.

This is the gate. If 144 misbehaves on your OEM matrix, you find out here, with
one variable changed and a one-line rollback.

**C1b — iOS screen share.** Small, self-contained, and now unblocked by
`ScreenCapturePickerView`. Worth taking while the library swap is fresh.

**C3 — token minting.** A Go endpoint issuing scoped LiveKit grants derived from
`call_participants.role`: `canPublish` false for `audience`, true for
`speaker`/`cohost`/`host`. This is pure server work with no client dependency
and **no LiveKit cluster required to write or test** — a LiveKit token is a JWT
with a documented claim shape. It can land before you provision anything.

**C4 — `SfuTransport`.** Behind the engine's transport seam. `lib/call/types.ts`
already has `TransportKind = 'mesh' | 'sfu'` and `calls.transport` already
records which a call used, so this is filling in a shape that exists rather than
reshaping the engine. Screens do not change.

**C5 — scale.** 64 participants, simulcast, active-speaker, pinned and grid
layouts. Needs the cluster.

**C6 — E2EE through the SFU.** Wire `RTCKeyProvider` to the per-call key
`lib/callCrypto.ts` already mints.

## What blocks what

| | Needs a cluster? | Can start now? |
|---|---|---|
| C1a library swap | no | **yes** — but needs the device pass to accept |
| C1b iOS screen share | no | yes, after C1a |
| C3 token minting | no | **yes, today** |
| C4 SfuTransport | to *test*, yes | can be written, not verified |
| C5 scale | yes | no |
| C6 E2EE frames | yes | no |

## What I did not do

Install the package. Swapping the native WebRTC layer cannot be validated in a
container — no device, no camera, no radio — and landing an unverifiable change
to the transport every call depends on is precisely the risk this spike exists
to avoid. The swap is a two-line `package.json` edit whenever you want it; the
device pass is the part that costs something.
