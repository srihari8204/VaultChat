# Backlog remainder — Channels and real video-call beautify

Two items were deferred from the WhatsApp-UI-tail backlog as "too large".
This is what they actually cost, measured against this repo on
`hetzner-deploy`, 2026-09-13. Every claim below has a file path behind it.

Both backlog notes turned out to be **wrong about the shape of the work** —
in opposite directions. Channels is far smaller than recorded. Beautify is a
different job than recorded (the path recommended in the memory note cannot
work here at all, for a reason nobody had checked).

---

## Item 1 — Channels

### Verdict

**Neither backend-missing nor UI-missing. Channels is already built,
deployed, and reachable.** The backlog entry — "a whole channels feature
(channel model, follow, feed). Not a restyle." — describes work that was
finished some time ago and never struck off the list.

### What exists today

**Database — deployed.** `vaultchat-backend/migrations/026_channels.sql`
creates `channels`, `channel_subscribers`, `channel_posts`, plus
`idx_channel_subs_user` and `idx_channel_posts_channel(channel_id, id DESC)`.
Prod was measured at migration **115** on 2026-08-24
(`memory/prod_state_verified.md`), so 026 has been live for a long time.

**Backend — 550 lines of Go, registered in the running binary.**
`vaultchat-backend-go/internal/routes/channels.go`, wired at
`vaultchat-backend-go/cmd/api/main.go:198`. Five endpoints:

| Endpoint | Behaviour |
|---|---|
| `GET /channels` | channels you admin or subscribe to, ordered by `last_post_at`, with `subscriber_count` |
| `POST /channels` | create; generates an unambiguous 8-char invite code (`ABCD-2F9K`), auto-subscribes the creator, in one transaction |
| `POST /channels/join` | subscribe by code |
| `GET /channels/{id}/posts` | keyset-paginated (`before`, `limit`, capped 100), 403 if not subscribed |
| `POST /channels/{id}/posts` | admin-only, 4000-UTF-16-unit cap, updates `last_post`/`last_post_at` transactionally |

It is not a stub. Author names are decrypted through `vault.IdentityFromRow`
(the encrypted-PII path). New posts fan out over Socket.IO to room
`channel:<id>` via `emitx.ToRooms`, and a background goroutine sends a
**content-free** Expo push to every subscriber — batched at 100, 3 retries
with backoff, 4xx not retried, and dead `DeviceNotRegistered` tokens pruned
from `devices`.

**Realtime handler exists:** `vaultchat-backend-go/internal/realtime/handlers.go:92`
handles `channel_join`.

**Client API layer exists:** `lib/chatService.ts:1261-1300` — `Channel` and
`ChannelPost` interfaces plus `listChannels`, `createChannel`, `joinChannel`,
`listChannelPosts`, `postToChannel`.

**Client screen exists:** `app/broadcast.tsx`, 327 lines. A complete two-level
screen — channel list, channel detail with inverted post feed, create modal,
join-by-code modal, admin-only composer with a read-only banner for
subscribers, `Share.share` invite, offline paint from
`readCache('broadcasts')`, and a live subscription that joins the
`channel_post` socket room on open and leaves it on close.

**It is already reachable.** `app/(tabs)/chats.tsx:529` — the megaphone icon
in the Chats header pushes `/broadcast`. `app/creator-channels.tsx` is a
17-line redirect into the same screen, added deliberately so there is exactly
one channels surface.

### What is genuinely missing

Only two things, and they are different sizes.

**(a) The Status-tab entry point.** `app/(tabs)/status.tsx` renders one
`FlatList` of stories (line 488) with a `ListHeaderComponent` for "My status"
and a `ListFooterComponent` for muted updates. There is no Channels section.
WhatsApp puts Channels in the Updates tab; VaultChat puts it behind a
megaphone icon in Chats. That is a discoverability difference, not a missing
feature.

**(b) WhatsApp-parity channel features.** If the goal is genuine parity
rather than a section header, these are absent:

| Gap | Where the work lands |
|---|---|
| Posts are text-only | `channel_posts` needs a media column; reuse the existing `/uploads/multipart/*` path |
| Discovery is invite-code-only — no directory, no search | new table + `GET /channels/search`; also a product/moderation decision |
| No reactions on posts | new table + endpoint + UI |
| No unread badge per channel | needs a per-subscriber read cursor (`channel_subscribers.last_read_id`) |
| No mute | `channel_subscribers.muted` + push filter |
| No forward-to-chat | client-only |

### Size

**(a) Status-tab section: ~half a day.** It reuses everything. Call
`listChannels()` (already exported), paint from `readCache('broadcasts')` —
the cache `app/broadcast.tsx` already writes, so it is warm — render rows in
`status.tsx`'s `ListFooterComponent` next to the existing MUTED UPDATES
block, `router.push('/broadcast')` on tap. Roughly 40 lines in one file. The
existing `S.sectionLabel` / `S.row` styles cover the look.

**(b) Parity features: 5-8 days.** Reasoning: media posts ~2d (schema +
upload wiring + render), unread cursor ~1d (one column, one endpoint, badge),
mute ~0.5d (one column, one push filter), reactions ~1.5d, discovery
directory ~2d plus an unresolved moderation question. No single item is hard;
there are just six of them and each touches migration + Go + TS + UI.

### Recommendation before this week's launch

**Do (a). Skip (b).** Half a day buys WhatsApp-shaped placement of a feature
that already works, with no migration and no backend deploy. (b) is real
product work that should not be started on launch week, and none of it is
needed for channels to function — a user can create, share, join, post, and
receive live + push updates today.

---

## Item 2 — Real video-call beautify

### The stated blocker: confirmed, but for a stronger reason than recorded

`app/videocall.tsx:57` says `<RTCView>` is a SurfaceView/TextureView and not
a raster `<Image>`, so a `<ColorMatrix>` wrapper cannot reach inside it. That
is correct — `RTCView` is backed by a native WebRTC renderer surface, and
React Native's image-filter libraries only wrap `<Image>` children.

But the comment at `app/videocall.tsx:72` — "`react-native-color-matrix-image-filters`
is installed but not imported here" — **is stale and wrong.**

```
$ grep -n "color-matrix" package.json      -> no match
$ ls node_modules/react-native-color-matrix-image-filters
  No such file or directory
$ git log -S"react-native-color-matrix-image-filters" -- package.json
  6e3e586 08072026- op sqlite      <- removed here
  0c4db09 04062026                 <- added here
```

It was removed in `6e3e586`, consistent with the Windows MAX_PATH build fix
recorded in `memory/backlog_local_android_toolchain.md` ("remove color-matrix
lib"). So the "Real pixel-level color transform on every Image-rendered
surface" claim in the same comment block is false in two ways: the library is
gone, and `app/videocall.tsx` renders no `<Image>` at all (the ringing/ended
fallback is `<Text>` initials).

**Everything the user sees today is the tint overlay** — `matrixToOverlay()`
at `app/videocall.tsx:141`, a flat `backgroundColor` + `opacity` `<View>`
derived from the matrix diagonal. There is no pixel-level filter anywhere in
the app.

### What is actually installed

| Package | State |
|---|---|
| `@livekit/react-native-webrtc` | **^144.1.2, installed** |
| `react-native-vision-camera` | ^4.7.3, installed — used only as a feature probe in `lib/compat.ts:88` |
| `react-native-reanimated` | ~4.1.1 |
| `react-native-worklets` | 0.5.1 |
| `react-native-worklets-core` | **NOT installed** (`lib/compat.ts:95` probes for it and gets `false`) |
| `@shopify/react-native-skia` | **NOT installed** |
| `react-native-color-matrix-image-filters` | **NOT installed** (removed in `6e3e586`) |

### The critical question: can a processed frame reach the outgoing track?

**Yes. The installed WebRTC package already ships the exact hook, and nobody
had looked.**

`MediaStreamTrack` exposes `_setVideoEffects(names: string[])`
(`node_modules/@livekit/react-native-webrtc/lib/typescript/MediaStreamTrack.d.ts`).
The chain, end to end:

```
JS   MediaStreamTrack._setVideoEffects([...])        lib/module/MediaStreamTrack.js:100
 ->  WebRTCModule.mediaStreamTrackSetVideoEffects    WebRTCModule.java:987
 ->  GetUserMediaImpl.setVideoEffects                GetUserMediaImpl.java:440
 ->  ProcessorProvider.getProcessor(name)            ProcessorProvider.java:15
 ->  videoSource.setVideoProcessor(...)              GetUserMediaImpl.java:464
```

`setVideoProcessor` installs on the **VideoSource**, upstream of the encoder.
`VideoEffectProcessor.onFrameCaptured` (VideoEffectProcessor.java:45) receives
each captured frame, runs it through the processor chain, and hands the
*processed* frame to `mSink.onFrame(...)`. That sink feeds the encoder and the
local renderer both.

**So the far side sees the effect, and so does the local preview. Outbound
beautify is not blocked by the media stack.** The same API exists on iOS
(`ios/RCTWebRTC/WebRTCModule+RTCMediaStream.m:498`, via `ProcessorProvider` +
`capturer.delegate`), though this repo has no `ios/` directory today so that
is currently moot.

The catch: `ProcessorProvider`'s map starts **empty**. Nothing is registered,
so `_setVideoEffects(['soft'])` today logs `no videoFrameProcessor associated
with this name` and no-ops. The processor must be native Kotlin implementing
`VideoFrameProcessor.process(VideoFrame, SurfaceTextureHelper)` and registered
via `ProcessorProvider.addProcessor(name, factory)` at app start.

That is well-trodden ground in this repo, not a new capability.
`android/app/src/main/java/com/vaultchat/app/` already carries seven custom
Kotlin modules (`calls`, `golive`, `vaultbeam`, `vaultshield`, `vaultview`),
registered in `MainApplication.kt:28-33` and injected by config plugins in
`plugins/` (`withVaultView.js`, `withVaultShield.js`, ...).

### Why the recorded path 2 cannot work here

`memory/backlog_real_beautify.md` proposes "`react-native-vision-camera`
frame processor + `@shopify/react-native-skia` shaders ... pipe processed
frames into the outgoing WebRTC track via a custom MediaStreamTrack". Three
problems, any one of which is fatal:

1. **Camera ownership.** VisionCamera opens the camera through CameraX
   (`node_modules/react-native-vision-camera/android/build.gradle:189-193`).
   WebRTC opens it through `Camera1Capturer`/`Camera2Capturer`
   (`CameraCaptureController.java:14-16`). Android hands the camera device to
   one client at a time. During a call WebRTC holds it, so VisionCamera
   cannot open it to run a frame processor.
2. **Frame processors do not work in this build.** VisionCamera 4.x needs
   `react-native-worklets-core`, which is not installed — `lib/compat.ts:95`
   already reports `WORKLETS_AVAILABLE === false`.
3. **No JS -> VideoSource path.** Even with frames in a worklet, this package
   exposes no way to push a frame back into a WebRTC `VideoSource` from JS.
   The only frame hook it exports is `RTCFrameCryptor`, which operates on
   **encoded** frames for E2EE — it cannot do pixel work.

Skia and VisionCamera are the right answer for a *camera* screen. They are
the wrong answer for a *call* screen. The right answer was already in the box.

### Size

**Android outbound colour filters: 2-3 days.** Not a week, and no new
dependency.

- **Kotlin `VideoFrameProcessor`, ~200 lines.** Frames from `Camera2Capturer`
  arrive as a `TextureBuffer`; `SurfaceTextureHelper` is passed into
  `process()` precisely so you can render into a new texture. You do not write
  EGL from scratch — `org.webrtc` already ships `GlShader`, `GlUtil`,
  `GlRectDrawer`, `GlTextureFrameBuffer`, `YuvConverter` and
  `TextureBufferImpl`. The fragment shader is one
  `mat4 * texture2D(...) + offset`, which is exactly the 4x5 matrices already
  sitting in `app/videocall.tsx:92-135`. **Those matrices carry over
  unchanged**, which is the one thing path 1 genuinely bought.
- **Registration, ~30 lines.** A `ReactPackage` calling
  `ProcessorProvider.addProcessor("soft", ...)` for the six filters, added to
  `MainApplication.kt` alongside the existing six, plus a
  `plugins/withBeautify.js` copied from `withVaultView.js`.
- **TS wiring, ~10 lines.** Add `setVideoEffect(stream, name)` to
  `lib/call/media.ts` right next to `flipCamera` at line 98 — that function
  already calls the sibling underscore-private API `t._switchCamera?.()`, so
  the precedent is established. Then one `useEffect` in `app/videocall.tsx`
  keyed on `filter`.
- **Delete** `matrixToOverlay` and all four overlay `<View>`s.

**Real skin smoothing: +1-2 days** on top. Same shader slot, a separable
Kawase or bilateral blur pass mixed back by luma. No face detection needed for
a whole-frame smooth.

**iOS: 0 today, +2 days when iOS ships.** No `ios/` directory exists. The ObjC
`ProcessorProvider` API is the same shape, so the design transfers.

**Unknown:** whether GL frame processing costs enough battery and thermal
budget to matter on low-end devices at 720p30. To find out: build the shader
with an identity matrix, run a 10-minute call on a mid-range Android device,
and compare `adb shell dumpsys batterystats` and frame-drop counters against
the same call with the processor off. I would not commit to shipping beautify
on-by-default before that measurement.

### The cheaper honest win — and a real defect found

**The beautify overlay is currently applied to the *remote* video as well as
your own.** `app/videocall.tsx:411-412` and `:932-935` render the tint inside
the full-screen remote `<View style={S.remote}>`; `:452-453` and `:968-971`
render it again over the local preview. So turning on "Glow" tints the other
person's face on your screen.

No messaging app does this. A beautify filter means *make me look better*, not
*put a colour wash over the person I am talking to*. Deleting the two
remote-side overlay blocks is roughly four lines and makes the feature honest:
the filter then affects only your own preview, which matches the memory note's
own description ("local-only, the other side sees the raw stream").

**Do not re-add the colour-matrix library for a stills path.** It was removed
to fix a Windows MAX_PATH build failure, there is no `<Image>` on the call
screen to apply it to, and its five transitive deps needed `--legacy-peer-deps`.
It would buy nothing and re-break local builds.

### Recommendation before this week's launch

**Do the four-line remote-overlay deletion. Defer the rest.** Two to three days
of Kotlin and a shader, plus an unmeasured battery risk, is not launch-week
work — but it is a genuinely achievable follow-up and should be re-filed with
the corrected approach, because the version currently in the backlog would send
someone down a VisionCamera + Skia path that cannot work.

Also correct the stale comment at `app/videocall.tsx:72` and the status line in
`memory/backlog_real_beautify.md`; both currently claim an installed library
that is not installed.

---

## If only one

**Channels — item 1(a).** It is half a day against two-to-three days, it
carries no native code, no migration, no backend deploy, and no battery risk,
and it is the one where the gap between what is built and what a user can find
is largest: a complete, deployed, realtime, push-enabled broadcast feature is
sitting behind a megaphone glyph nobody will read as "Channels". Beautify by
contrast already presents *something* on screen — it is misleading rather than
absent, and the honest fix for that (deleting the remote-side tint) is small
enough to do regardless of which item wins. Channels is the one where a small
amount of work unlocks a large amount of already-paid-for engineering.
