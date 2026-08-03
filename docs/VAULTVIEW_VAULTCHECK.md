# VaultView & VaultCheck — what is built, and what it actually promises

Two features for protected media and media authenticity. This document records
what the code does, what it deliberately does not do, and which claims are safe
to put in front of a user.

The audience for these features is people sharing images they cannot afford to
have leaked, and people being attacked with fabricated ones. Overstating the
protection is not a marketing choice here — it changes what someone risks. Every
limit below belongs in onboarding copy, not just in this file.

---

## VaultView — protected media

### What's enforced

| Protection | Android | iOS | Where |
|---|---|---|---|
| Screenshot / recording blocked | **Yes** — `FLAG_SECURE`, OS-enforced, capture renders black | **No** — Apple provides no equivalent | `lib/screenGuard.ts`, `plugins/android/VaultViewModule.kt` |
| Screen recording detected | n/a (blocked outright) | **Yes** — `UIScreen.isCaptured`; refuses to decrypt while active | `plugins/vaultview-ios/VaultViewGuard.swift` |
| Screenshot detected → sender alerted | Android 14+ | **Yes** | `app/media-viewer.tsx`, `POST /chats/:id/screenshot-captured` |
| External display / mirroring blocked | Yes | Yes | `ProtectedMediaView` refuses to render |
| Dynamic watermark (viewer name, number, live timestamp) | Yes | Yes | `components/ProtectedMediaView.tsx` |
| Steganographic tracking ID | Yes | Yes | `lib/trackingId.ts` + native codecs |
| Remote revoke | Yes | Yes | `POST /uploads/:id/revoke` |
| View-once, server-enforced | Yes | Yes | migration `014`, `routes/uploads.js` |
| Media encrypted at rest, key never on server | Yes | Yes | `lib/mediaCrypto.ts`, `MEDIA_E2EE` |

### The platform asymmetry is real and must be surfaced

Android can block capture; iOS cannot. `capabilities()` in `lib/screenGuard.ts`
reports which posture is in force, and `ProtectedMediaView` renders a different
status line per platform. **Do not write one marketing sentence that covers
both.** On iOS the honest promise is "the sender is told", not "screenshots are
blocked".

When the native module is missing (Expo Go, or a build predating
`plugins/withVaultView.js`) the guard reports `available: false` and the UI says
protection is limited. It never silently degrades to a no-op that still shows
the protected badge.

### Remote revoke semantics

Sender-only, irreversible, no time window (unlike "Delete for everyone", which
is capped at 2d12h and removes the *message*).

1. `revoked_at` stamped → every later `GET` returns 410, including the sender's.
2. Stored bytes deleted from the object store / disk.
3. `media_revoked` broadcast → recipients destroy the **media key first**, then
   all decrypted copies.

The key-first ordering is deliberate: with `MEDIA_E2EE` on, a device holding
ciphertext and no key has nothing recoverable, so a wipe interrupted halfway
still succeeded at the part that matters.

An offline recipient converges without the broadcast — the next fetch returns
410 with `{ revoked: true }`, and `lib/protectedMedia.handleFetchStatus()` runs
the same wipe. Socket delivery is not load-bearing.

### The tracking ID: what it survives

Pair-wise block-mean luminance modulation, 16px blocks, 48-bit token + CRC-16,
payload repeated across the whole image and majority-voted on extraction.

- **Survives:** JPEG re-encode (q≥60), brightness/contrast/gamma, moderate
  noise, cropping.
- **Does not survive:** rescaling, rotation, heavy blur.

A rescaled leak reports `found: false` — the same answer as an unmarked image.
The codec cannot distinguish those two cases and does not guess. The CRC gate
means a degraded image will not produce a *wrong* token, which matters because
this output names a person.

**Group limit:** one marked copy is uploaded per message, so in a group the
token identifies the message, not which member leaked it. Per-member tracing
would need one upload per member. Direct chats are unambiguous.

**Token privacy:** the embedded value is a random per-message token, not a user
id. The token → recipient mapping lives only on the sender's device
(`lib/trackingId.ts`), so nobody who finds a leaked image — including us — can
reverse it into an account.

### What VaultView does not do

- Does not stop a second phone photographing the screen. Nothing can. The
  watermark and token make it attributable, not impossible.
- Does not defeat a rooted/jailbroken device with a debugger attached.
- Cannot recover anything leaked before it was used.
- Cannot block screenshots on iOS. Apple's rule.

---

## VaultCheck — media authenticity

Three layers were designed. **Two are built.**

| Layer | Status | Notes |
|---|---|---|
| C2PA / Content Credentials | **Built** — JPEG + PNG | Manifest parse, hard-binding hash, ES256 signature verification |
| rPPG heartbeat | **Built** — video | CHROM projection, adaptive-threshold spectral analysis |
| Learned deepfake detector | **Not built — deliberately** | See below |

### The detector slot is empty on purpose

`lib/vaultcheck/detector.ts` contains no detection logic and returns
`available: false`.

This repo previously shipped a "World-First AI" deepfake detector whose score
was JPEG base64 character-code variance plus `Math.random() * 7`
(`constants/deepfakeDetection.ts`, deleted; recorded in
`docs/FEATURE_GAP_MATRIX.md:54`). It produced confident percentages that meant
nothing.

For a feature whose purpose is telling someone whether an intimate image of them
is fabricated, a fabricated answer is worse than no answer. **Do not add
heuristics to fill this gap.** Compression artefacts, EXIF absence and file-size
ratios are not deepfake detection.

Landing a real model requires: redistributable weights with measured accuracy, a
runtime (`onnxruntime-react-native` or `react-native-fast-tflite`, neither
currently a dependency), download-on-first-use delivery with a signature check,
and a published operating point with its false-positive rate.

### C2PA scope

Verified: manifest structure, declared actions, hard binding (asset hashed with
the manifest excluded — catches "signed, then edited"), and COSE ES256 signature
against the embedded leaf certificate.

**Not verified: the certificate chain.** We do not bundle the C2PA trust list,
so the result always reports `issuer: 'unverified'`. The signature being
mathematically valid says the file is unaltered since signing; it does not say
the signer is who they claim. The UI states this on every result.

Video containers (MP4/BMFF) are not supported yet and are reported as
"not checked" rather than "no manifest".

### rPPG scope

A found pulse is decent evidence of a live human. **A missing pulse is weak
evidence of nothing** — poor lighting, camera motion, compression, or a small or
turned face all destroy the signal. The verdict distinguishes `pulse` /
`no-pulse` / `inconclusive` and the combiner never converts `no-pulse` into
"likely fake".

The SNR threshold adapts to clip length. It has to: periodogram noise peaks grow
as `ln(n) + γ` with the number of independent frequency bins, so a fixed
threshold reports heartbeats on noise for long clips. An earlier revision did
exactly that — pure noise scored 4.2 against a fixed 4.0 — which the self-test
now guards against across eight seeds and two clip lengths.

### Verdict combination is asymmetric

Only one route reaches `likely-fake`: a C2PA **hard-binding mismatch**, which is
a fact (the bytes no longer hash to what was signed), not an inference.
Everything else lands in `unknown`, and the UI says "could not verify" rather
than implying innocence or guilt. That is the honest output of a two-layer
system.

---

## Tests

```bash
npm run test:vaultcheck    # CBOR, JUMBF, rPPG DSP — 29 assertions, runs under node
npm run typecheck
```

The native modules (screen guard, stego codec, frame sampling) have **no
automated coverage** — they need a device. Before shipping, verify by hand:

1. Android: send a view-once photo, screenshot it → image is black.
2. iOS: start a screen recording, open a view-once photo → refuses to render.
3. Either: plug into a TV → refuses to render.
4. Revoke a sent photo from the sender → recipient's bubble becomes a tombstone
   and the local file is gone; repeat with the recipient offline at revoke time.
5. Embed and extract a tracking ID across platforms (Android → iOS and back).
6. Verify a C2PA-signed image from a real camera or Adobe export.
7. rPPG on a real 10s face video vs a still image held in frame.
