// Runtime feature flags.
//
// E2EE_ENABLED gates the real end-to-end encryption seam in lib/chatService.ts
// (X3DH + Double Ratchet, services/crypto — 47/47 self-tests pass).
//
// ON: direct-chat messages are end-to-end encrypted. The rollout is GRACEFUL —
// if a peer hasn't published a key bundle yet (older app), encryptForChat falls
// back to plaintext for that message, and pre-E2EE history stays readable. So
// turning this on never blocks or breaks messaging.
//
// NOT YET encrypted: group chats (need sender-key/MLS group E2EE — separate
// work) and media payloads. Verify with a two-device round-trip after deploy.
export const E2EE_ENABLED = true;

// E2EE_STRICT hardens the 1:1 seam so it NEVER silently sends plaintext. When a
// direct-chat message can't be encrypted (peer key bundle missing / transient
// session error), the send THROWS instead of falling back to plaintext — so the
// message shows as failed + retries (the retry re-fetches the bundle and almost
// always succeeds), rather than leaking a plaintext body to the server. This is
// the WhatsApp guarantee. Groups stay graceful during the E2EE rollout.
export const E2EE_STRICT = true;

// VAULT_SESSION_SEALED gates #32 Phase A: the real account's session tokens are
// sealed under the unlock PIN (services/security/sessionSeal) instead of sitting
// in plaintext SecureStore, so a duress/decoy PIN cannot reach the real session.
//
// ON as of 2026-09-13 — and it is now OPT-IN AND PIN-GATED, which is the only
// shape in which it is safe. The three prerequisites the previous audit named
// are implemented:
//
//   1. CALLERS. services/security/pinStore is the one place a local PIN is
//      created or removed, and every caller (authService.savePIN,
//      securityService.savePIN, /backup-pin, logout) already routes through it.
//      setPin()   → api.sealCurrentSession(pin)   — seals what already exists
//      clearPin() → api.unsealCurrentSession()    — puts it back in the clear
//      app/app-lock.tsx → api.loadSealedSession(pin) at unlock.
//   2. A LOCAL PIN IN THE BOOT PATH. Still absent for most users — so they are
//      never sealed. sealCurrentSession only ever runs from setPin, so a user
//      who has not deliberately set a device PIN keeps the byte-identical
//      plaintext path: _sealKey stays null, nothing is sealed, nothing to
//      unseal, /app-lock behaves exactly as before (biometric or remote MPIN).
//      A BIOMETRIC-ONLY USER SEES NO CHANGE AT ALL.
//      For a user who HAS set one, app/index.tsx routes on sealedSessionLocked()
//      as well as the MFA flag, so a sealed session always reaches a screen that
//      can ask for the PIN — including via deep link / notification, where
//      doRefresh() now treats "sealed but locked" as transient + /app-lock
//      instead of terminal (terminal ran clearTokens(), which deleted the seal).
//   3. THE RE-LOGIN FALLBACK IS REAL. app-lock's sealed branch reports a wrong
//      PIN, keeps the session, and offers "Forgotten your PIN?" → an explained,
//      user-confirmed sign-in-again. There is no silent bounce to /onboard.
//
// Flip to false to restore the exact prior behaviour for everyone: setTokens /
// getAccessToken / hasSession fall straight through to plaintext SecureStore,
// and the seal/unseal calls all early-return.
//
// STILL REQUIRES A DEVICE PASS: set PIN → kill app → relaunch → unlock, plus
// wrong-PIN → re-login, on a real handset (scrypt timing + SecureStore).
export const VAULT_SESSION_SEALED = true;

// VAULT_CACHE_ENCRYPTED gates #32 Phase B: the local SQLite message cache
// (lib/localDb) holds message bodies in plaintext today. With this ON, the
// sensitive columns (messages.content, messages.meta, chats.data) are sealed at
// rest with AES-256-GCM under a random Data Encryption Key (DEK) that is itself
// envelope-sealed under the unlock PIN (lib/cacheCrypto). The DEK is loaded into
// memory only after a successful unlock, so a duress/decoy PIN or a seized device
// cannot read cached message bodies.
//
// DEFAULT OFF — when off (or before unlock), the field codecs are pass-through, so
// localDb behaves byte-identically to before. Rows carry an `enc:v1:` prefix when
// sealed, so old plaintext rows and new encrypted rows coexist (lazy migration);
// nothing is bulk-rewritten and the cache can never brick. Indexed/queried columns
// (ids, chat_id, timestamps, deleted_at) stay cleartext — only message bodies are
// sealed.
//
// ⚠️ STAYS OFF — but for a DIFFERENT reason than before (2026-09-13). The
// wiring prerequisite is now met: VAULT_SESSION_SEALED is on and pinStore.setPin
// → sealCurrentSession → provisionCacheKey, app-lock → loadSealedSession →
// unlockCacheKey, so flipping this WOULD genuinely seal message bodies for a
// PIN'd user. It is off because of the OTHER half — key loss:
//
//   The DEK envelope is sealed under the PIN key. Change the PIN or remove it
//   (pinStore.clearPin → api.unsealCurrentSession) and the old DEK is gone,
//   while the rows sealed under it are still in SQLite. decField degrades them
//   to raw ciphertext — it never crashes, but the user would see `enc:v1:…`
//   where their messages were. That is a data-visible regression, and fixing it
//   means a row rewrite (decrypt-all on PIN change / purge the cache), which is
//   real migration work, not a flag flip.
//
// So: turning this on today no longer makes the flag LIE, it makes it BITE
// someone who changes their PIN. Before it can ship it needs (a) that rewrite
// in unsealCurrentSession/sealCurrentSession, and (b) the device test below.
// cacheCrypto.selftest asserts the coupling to VAULT_SESSION_SEALED and fails if
// this is flipped while no caller of the seal seam exists. Verify with a
// two-device set-PIN → send → reload → unlock → CHANGE-PIN round-trip.
export const VAULT_CACHE_ENCRYPTED = false;

// MEDIA_E2EE gates W6 media-at-rest: in DIRECT chats, attachment bytes (photo,
// video, voice, file) are encrypted with a fresh per-file AES-256-GCM key before
// upload — the server stores opaque ciphertext only. The key rides to the
// recipient inside the E2E message envelope (lib/mediaAttachments), never in
// plaintext meta, so it requires E2EE_ENABLED and a direct (1:1) chat.
//
// DEFAULT OFF — when off, media uploads behave exactly as before (plaintext bytes
// on the server). The receive/render path is always tolerant: an attachment with
// no local key falls back to the direct URL, so legacy/plaintext and group media
// keep rendering. Group chats stay plaintext until group E2EE (W5) lands. Verify
// with a two-device direct-chat photo/voice/file round-trip before enabling.
export const MEDIA_E2EE = true;   // enabled 2026-06-28 — VERIFY two-device direct-chat photo/voice/file round-trip after deploy

// STORY_E2EE gates W7 per-viewer story encryption: a story's media is uploaded as
// opaque AES-256-GCM ciphertext and its single content key is wrapped SEPARATELY
// for each authorized viewer via the author↔viewer E2EE session (reuses the proven
// per-peer Double Ratchet). The server stores only opaque ciphertext + opaque
// per-viewer wrapped keys — it can never read a story. Requires E2EE_ENABLED.
//
// DEFAULT OFF — when off, stories post/render exactly as before (plaintext media).
// The viewer is tolerant: `story.encrypted` decides the path, so plaintext and
// encrypted stories coexist. Viewers who weren't in the audience at post time have
// no wrapped key and cannot decrypt (correct for an ephemeral, audience-scoped
// post). Verify with a two-device round-trip before enabling.
export const STORY_E2EE = true;   // enabled 2026-06-28 — VERIFY two-device story round-trip after deploy

// GROUP_E2EE gates W5 group chat encryption via Sender Keys (Signal-style). Each
// member encrypts with their own hash-ratchet sender key (services/crypto/senderKey,
// 9/9 self-tests) and distributes it to other members over the pairwise Double
// Ratchet (services/crypto/groupSession). The server stores only ciphertext +
// opaque distribution blobs. Sender keys rotate automatically on membership change.
//
// DEFAULT OFF — when off, group messages are plaintext exactly as before. The
// rollout is GRACEFUL: decrypt detects a group envelope (GSK1: prefix), and
// pre-E2EE / plaintext history stays readable; a member without a sender key yet
// falls back so messaging never breaks. Requires E2EE_ENABLED. Verify with a
// 3-device group round-trip (incl. add/remove member) before enabling.
export const GROUP_E2EE = true;   // enabled 2026-06-28 — needs migration 040; VERIFY 3-device group round-trip (incl add/remove) after deploy

// Scheduled messages (#73): local encrypted on-device queue (send at time) vs
// the legacy server-side queue (scheduled_messages table + 30s sweep). Local is
// the differentiator — nothing waits on a server; encrypted at send time.
// FALSE = reliable server-side delivery (E2E-encrypted on-device before upload;
// the server forwards ciphertext at send time — fires even if the app is killed).
// TRUE = on-device queue, but best-effort timing on Android (Doze/OEM kills).
export const SCHEDULED_LOCAL = false;

// UPLOAD_PROGRESS gates sender-side upload progress reporting. The attachment
// already appears instantly and already uploads in the background (mediaOutbox);
// this only makes that upload VISIBLE — "Preparing…" while the file is
// encrypted, then 0→100% while the ciphertext goes up.
//
// OFF → uploadAttachment takes the original `fetch` branch and mediaOutbox emits
// no 'progress' events, so bubbles fall back to the static pending clock. There
// is no data, message, encryption or R2 implication either way: progress is a
// byte counter over bytes that were already being sent.
export const UPLOAD_PROGRESS = true;

// VB_AUTODOWNLOAD gates VaultBeam auto-download (UITE F2 Phase A): incoming
// large-file transfers can be accepted automatically per the user's settings
// (lib/vaultBeamSettings) instead of requiring a manual Accept tap.
//
// DEFAULT OFF — when off, VaultBeam behaves exactly as today: every incoming
// transfer waits for a manual Accept. When on, the policy engine
// (lib/vaultBeamAutoDownload) decides per transfer; the user's default settings
// are still conservative (Wi-Fi + trusted-only + 500 MB). The 2.5 GB ceiling
// below is enforced independently of settings — files ≥ 2.5 GB ALWAYS require a
// manual Accept (up to the existing 12 GB hard cap).
export const VB_AUTODOWNLOAD = false;

// Hard ceiling for auto-download, enforced by the engine regardless of user
// settings and re-checked at dequeue. Manual Accept still works up to 12 GB.
export const VB_AUTO_MAX_BYTES = 2.5 * 1024 ** 3; // 2,684,354,560 bytes

// CALL_ENGINE_V2 gates the consolidated call engine (lib/call/*): one headless
// engine + a pure, self-tested state machine, with the call screens reduced to
// renderers. It replaces three near-identical copies of the WebRTC pipeline that
// each re-implemented getUserMedia, TURN fetch, peer connection, offer/answer/ICE,
// the signalling cipher, audio routing, teardown and call logging.
//
// ON as of 2026-08-08 (owner-approved). The WIRE IS IDENTICAL either way (same
// events, same payload fields, same re-send cadences, same E2EE envelope), so an
// engine build and a legacy build call each other correctly and this can be
// flipped per-release rather than per-fleet.
//
// ROLLBACK IS THIS ONE CONSTANT: set to false and the screens run their original
// code path unchanged. The legacy bodies stay in the tree until the OEM matrix
// below has passed on hardware — do not delete them yet.
//
// ⚠️ STILL OUTSTANDING: the hardware gate in CALLS_README.md has NOT been run.
// WebRTC cannot be validated any other way. Before shipping a release with this
// on, do a two-device pass covering: background audio, ring while the app is
// KILLED, and lock-screen ring on MIUI / ColorOS / Vivo / Honor / Samsung /
// stock Android.
export const CALL_ENGINE_V2 = true;

// VB_RELIABILITY_FIXES gates the relay-receive companions (UITE): a no-progress
// watchdog (fails a stuck "Downloading 0%" transfer cleanly instead of forever)
// and recipient on-disk resume (seeds already-written blocks so a dropped
// download doesn't restart from 0). DEFAULT ON — both only skip re-work or fail
// a genuine multi-minute stall; flip OFF to restore the exact prior relay path.
export const VB_RELIABILITY_FIXES = true;

// VB_SEAMLESS_RESUME gates the transport-independent transfer session
// (openspec/changes/vaultbeam-seamless-resume): one canonical logical chunk
// identity across LAN/P2P/relay, the PeerHave+R2Have bitmap pair, and resume
// without restarting when a transport changes.
//
// DEFAULT OFF — when off, new transfers build a v1 (legacy) segment plan and use
// the legacyOffset chunk-identity scheme, which is byte-identical to today. When
// ON, plans are v2 and chunks are sealed with the canonical scheme (id = global
// logical index), which is a BREAKING wire change on the relay tier — the
// manifest version bump makes old<->new a clean reject, never a corrupt decrypt.
// Readers accept BOTH schemes, so a transfer started before an app update still
// completes (relay objects expire in 24 h, so the window need only exceed a day).
export const VB_SEAMLESS_RESUME = false;

// CALL_SESSIONS gates the server-side call record (migration 066 +
// /calls/* in the Go backend). With it ON, starting or joining a call also
// opens a session row, so a call gains a real identity: history syncs across a
// user's devices and survives a reinstall, instead of living only in the 300-
// entry AsyncStorage log on the handset that made it. It is also the table a
// role — and therefore a future SFU publish grant — is read from.
//
// It had to stay off until migration 066 was actually applied to the server
// this build talks to. It now IS — verified against production on 2026-08-12,
// not assumed:
//
//   calls + call_participants tables .. present
//   indexes .......................... 6
//   vc_is_call_host / vc_call_role_guard  present
//   call_participants_role_guard trigger  present
//   RLS policies ..................... 6
//   existing rows .................... 0 / 0   (a clean first write)
//
// and LiveKit answers RoomService.CreateRoom with 200, so the SFU path this
// unlocks has somewhere to go.
//
// Even when ON, the session request is fire-and-forget and never blocks media:
// a 404 (server not migrated), a timeout or an offline device costs the call
// nothing and simply leaves that call without a server-side id — it still logs
// locally, exactly as before. Call setup must never depend on a REST round trip.
// engine.ts calls it as `void openCallSession(...).catch(() => {})`, so the
// worst case of this flag being wrong is the behaviour we already had.
//
// Turning it on is what gives a call a server-side identity, and therefore what
// lets a group larger than the mesh cap reach the SFU instead of being refused
// with call_full.
export const CALL_SESSIONS = true;

// LOCATION_LOCK gates the Location Lock utility inside the Navigate mini-app
// (openspec change: location-lock): lock a point + radius, on-device geofence
// with warning/at-limit/outside zones, multi-channel alarm, kill-safe
// background monitoring, navigate-back, local-only history. Everything is
// on-device — the only network calls are the existing /nav/route proxy.
//
// ON for development/field-testing. The production release gate is tasks.md
// 6.3 (two-device field test: arm → walk out → alarm in background → navigate
// back → auto-stop → history correct) — flip OFF for store builds until then.
export const LOCATION_LOCK = true;

// NAV_MAP_3D swaps NavMap's Leaflet (2D) engine for MapLibre GL: real 3D pitch,
// heading-up basemap rotation, and follow/north/overview camera modes. Reuses
// the same Carto raster tiles (no MapTiler key, no vector tiles). Defaults ON;
// a device that can't init WebGL/worker auto-falls-back to Leaflet at runtime,
// so this is safe to ship on — but it wants a real-device pass (WebGL perf on
// low-end handsets) before it's considered proven. Flip OFF to force Leaflet.
export const NAV_MAP_3D = true;

// FAMILY_MAP_3D does for the FAMILY map what NAV_MAP_3D did for Navigate: swaps
// components/family/FamilyMap's Leaflet page for MapLibre GL, giving the family
// map real pitch, heading-up rotation and follow/north/overview cameras. Both
// pages expose the identical JS API, so the screens using FamilyMap are
// unchanged, and a device that cannot init WebGL/worker downgrades to Leaflet at
// runtime before first paint. Tiles still come from lib/map/tileProvider (raster
// today) — this flag is about the ENGINE, not the tile source. Defaults ON;
// wants a real-device pass on a low-end handset. Flip OFF to force Leaflet.
export const FAMILY_MAP_3D = true;

// STREETVIEW_API_KEY enables the maplibre-pegman Street View control on the
// family map. EMPTY BY DEFAULT, and that default is a decision, not an
// oversight: Street View sends the viewed coordinate to Google, which puts a
// commercial third party in the location path of an app whose stated rule is
// that positions and saved places do not leave without a reason. The library is
// bundled and ready; set a key here (or wire one from config) to switch it on
// deliberately. With no key the control is simply never added.
export const STREETVIEW_API_KEY = '';

export default { E2EE_ENABLED, VAULT_SESSION_SEALED, VAULT_CACHE_ENCRYPTED, MEDIA_E2EE, STORY_E2EE, GROUP_E2EE, SCHEDULED_LOCAL, UPLOAD_PROGRESS, VB_AUTODOWNLOAD, VB_AUTO_MAX_BYTES, VB_RELIABILITY_FIXES, VB_SEAMLESS_RESUME, CALL_ENGINE_V2, CALL_SESSIONS, LOCATION_LOCK, NAV_MAP_3D, FAMILY_MAP_3D };
