// app/_layout.tsx
// Root layout — runs on every app open
//
// Order of operations:
//   0. LiveKit polyfills (Hermes lacks DOMException)
//   1. Buffer polyfill (crypto needs this)
//   2. Sentry init — must happen BEFORE any other code that might throw
//   3. Block screenshots app-wide (FLAG_SECURE)
//   4. Security scan — jailbreak / Frida / root
//      → if threat found → /blocked (keys already wiped)
//   5. Register push notifications (physical device only)
//   6. Wire notification tap listeners → navigate to correct chat
//   7. Handle notification that launched app from killed state

// MUST BE FIRST — installs DOMException and friends that Hermes does not have.
//
// livekit-client is a browser library and touches those globals at MODULE
// SCOPE, so anything importing it before this line throws
// `ReferenceError: Property 'DOMException' doesn't exist` — which surfaces as a
// WHITE SCREEN with no error of ours in the log, because the module never
// evaluated. Observed exactly that on the Go Live screen.
//
// Placed at the entry point rather than relying on import order inside a
// feature module: any formatter that sorts imports would silently reintroduce
// the crash there. Side-effect import, so it must not be merged with a named
// one or a bundler may hoist it.
// `simple-import-sort/imports` was listed here too, but that plugin is not
// installed — and eslint makes a disable-comment for an unknown rule a hard
// ERROR, which failed `npm run prod:check` on a line whose whole purpose is to
// stop this import being moved. If a sorter is ever added, put the rule back in
// this comment at the same time.
// eslint-disable-next-line import/order
import '@livekit/react-native';

import { BRAND_ACCENT } from '../constants/theme';
import { Buffer } from 'buffer';

import { Stack, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { setSecure } from '../lib/screenGuard';
import { installAlertGuard } from '../lib/alertGuard';
import { isSessionEnded } from '../lib/sessionEnded';
import * as SplashScreen from 'expo-splash-screen';
import * as Linking from 'expo-linking';
import * as Sentry from '@sentry/react-native';
import { StatusBar } from 'expo-status-bar';
import { HEADER_TOP, SCREEN_BOTTOM } from '../constants/layout';
import { View, ActivityIndicator, StyleSheet, Platform, AppState, InteractionManager } from 'react-native';
import notifee, { EventType } from '@notifee/react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { PdfThumbnailerHost } from '../components/PdfThumbnailer';
import { CallBar } from '../components/CallBar';
import { UpdateGate } from '../components/UpdateGate';
import { TermsGate } from '../components/TermsGate';
import { enableFreeze } from 'react-native-screens';

// Screens below the top of the stack stay MOUNTED by default, so every one of
// them keeps re-rendering on each context/state change. Measured on-device:
// native View count climbed 757 -> 1308 over 10 navigations and never came
// back, with PSS reaching 359 MB. Freezing suspends offscreen screens without
// unmounting them, so `back` is still instant.
enableFreeze(true);
import { useFonts, Sora_700Bold, Sora_800ExtraBold } from '@expo-google-fonts/sora';
import { NunitoSans_400Regular, NunitoSans_600SemiBold, NunitoSans_700Bold } from '@expo-google-fonts/nunito-sans';
import { FontReadyContext } from '../components/ui/Text';
import { ThemeProvider, useTheme } from '../lib/theme';

import { runSecurityCheck } from '../services/securityService';
import { attachTapHandler } from '../lib/push';
import { notify as notifyMessage, setSelfId } from '../lib/messageNotifications';
import { addPersistentListener, getSocket } from '../lib/socket';
import { registerForCalls, refreshCallRegistration, getInitialCallIntent, drainDeclinedCall } from '../lib/CallService';
import { getActiveCall } from '../lib/callState';
import { getRingingPeer, setRingingPeer, getRingScreenPeer, setRingScreenPeer, consumePendingCall } from '../lib/ringTracker';
import { cancelIncomingCall } from '../lib/callNotification';
import '../lib/callBackground';   // registers notifee bg event + bg notification task
// Registers the VaultChatSync headless task at JS-load time, so a chat push can
// sync and acknowledge delivery while the app is backgrounded or killed. Same
// side-effect-import pattern as callBackground above, for the same reason: the
// registration must exist before any React tree does.
import '../lib/syncBackground';
import '../lib/family/background'; // registers the bg-location task — a headless OS
                                   // wake runs ONLY this layout's imports, so without
                                   // this line killed-app Family sharing drops fixes
import '../lib/lock/background';   // registers the Location Lock geofence task — same
                                   // rule: headless wakes need it defined at load
import { getAccessToken } from '../lib/api';
import { E2EE_ENABLED, SCHEDULED_LOCAL } from '../constants/flags';
import { runDueScheduled, rearmAllTriggers } from '../lib/scheduledRunner';
import { getLocalDb } from '../lib/localDb';
import perf from '../lib/perf';
global.Buffer = Buffer;

// Keep the native splash up until the cold-start router (app/index.tsx) has made
// its auth decision and navigated. This is the WhatsApp trick: no intermediate
// spinner/white-flash between the splash and the chats list — index.tsx hides
// the splash once it has routed. preventAutoHide MUST run at module load, before
// the splash would auto-hide when the JS bundle finishes loading.
SplashScreen.preventAutoHideAsync().catch(() => {});

/**
 * ...AND HIDE IT WHEN A DEEP LINK MEANT app/index.tsx NEVER RUNS.
 *
 * hideAsync() lives in exactly one place: app/index.tsx, the cold-start router
 * at route `/`. A cold start from a deep link — a turn notification, a game
 * invite card, a vaultchat:// or /live/join link — routes STRAIGHT to that
 * screen and never mounts index, so nothing ever hid the splash.
 *
 * The result is not a visible splash. It is worse: the activity window never
 * becomes visible (`mHasSurface=false`), so it is never given an input channel
 * (`dumpsys input` → `FocusedWindows: <none>`), and every touch is dropped
 * until Android raises "isn't responding — Input dispatching timed out
 * (Application does not have a focused window)". The UI renders and the sockets
 * run, which is what makes it look like the app froze rather than failed to
 * start. Reproduced from cold on both test phones, on two Android versions,
 * with a plain VIEW intent, an explicit component, and BROWSABLE+NEW_TASK.
 *
 * Hiding here rather than moving index's call keeps the launcher path exactly
 * as it was: index still covers its own auth read with the splash, so there is
 * no spinner flash on a normal open.
 */
Linking.getInitialURL()
  .then(url => { if (url) SplashScreen.hideAsync().catch(() => {}); })
  .catch(() => { SplashScreen.hideAsync().catch(() => {}); });

// ── Sentry frontend init (Day 16) ──────────────────────────────────
// Reads EXPO_PUBLIC_SENTRY_DSN from EAS env. If unset (dev), Sentry is
// a no-op — events are dropped, no errors. Wrap every screen via the
// HOC at module level so unhandled errors get captured.
const SENTRY_DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;
if (SENTRY_DSN) {
  Sentry.init({
    dsn:                SENTRY_DSN,
    enableAutoSessionTracking: true,
    // Sample rate kept conservative for launch; ratchet down if quota tight.
    tracesSampleRate:   0.2,
    // Sentry captures Hermes JS errors; native crashes via React Native's
    // own native bridge — no extra config needed.
    environment:        process.env.EXPO_PUBLIC_ENV || 'production',
    // A session ending is a normal event, not a crash: api() rejects with it so
    // callers can unwind, and the app is already showing the sign-in screen.
    // Without this filter every expired token becomes an issue in Sentry, and a
    // report full of routine events is a report nobody reads.
    beforeSend: (event, hint) => (isSessionEnded(hint?.originalException) ? null : event),
  });
}

// AUDIT F09 — install the alert boundary before any screen can render.
//
// api() rejects a dead session with a typed SessionEndedError. Roughly twenty
// call sites turn a caught error straight into Alert.alert, which would stack a
// dialog on top of the sign-in screen the redirect just opened. The boundary
// drops that one message and nothing else; see lib/alertGuard.ts for why it
// wraps Alert rather than asking 694 call sites to import a helper.
//
// Module scope, not an effect: a request can fail before the first render.
installAlertGuard();

/**
 * Screens that draw their OWN header and never accounted for the status bar.
 *
 * app.json sets edgeToEdgeEnabled, so a screen with no native header and no
 * inset of its own starts its first row UNDER the clock and the notch — the
 * group-create preview card and the network-test back button were both sitting
 * behind the status icons on a real handset.
 *
 * Listed here rather than patched into twenty-nine screen files because it is
 * one fact about the navigator, not twenty-nine independent layout decisions,
 * and a screen added to this list tomorrow needs no edit of its own.
 *
 * DELIBERATELY ABSENT: screens that already handle the inset (HEADER_TOP,
 * SafeAreaView, or a native header) — they would be padded twice — and the
 * full-bleed ones (media viewer, story viewer, scanner, lock, image editor),
 * which are supposed to run under the status bar.
 *
 * ponytail: contentStyle padding also insets an absolutely-positioned
 * background child, so a screen whose backdrop is <AuroraBackground/> shows
 * colors.bg in that top strip — invisible on the dark ground. A light-gradient
 * screen joining this list wants a real root padding instead.
 */
const INSET_SCREENS = [
  'creator-channels',
  'current-location',
  'd2de-status',
  'decentralized-id',
  'duresspin',
  'emergency-sos',
  'filevault',
  'games',
  'group-calendar',
  'group-chat',
  'group-create',
  'group-insights',
  'group-notes',
  'group-tasks',
  'group-trip',
  'interest-calculator',
  'location-lock',
  'lock-alert',
  'lock-history',
  'lock-settings',
  'navigate',
  'network-test',
  'onboard-mpin',
  'onboard-success',
  'setup-complete',
  'vaultbeam-settings',
  'vaultcheck',
  'voice-effects',
  'voice-speed',
] as const;

function RootLayoutInner() {
  const { colors, scheme } = useTheme();
  /** My user id, for the famEvent ingest below — a ref because the persistent
   *  listener closure outlives any render. */
  const selfIdRef = useRef<string | null>(null);
  const router = useRouter();
  const [securityChecked, setSecurityChecked] = useState(false);
  // U2: load brand fonts (non-blocking — render proceeds on system font, then
  // swaps to Sora/Nunito Sans when ready via FontReadyContext).
  const [fontsReady] = useFonts({
    Sora_700Bold, Sora_800ExtraBold,
    NunitoSans_400Regular, NunitoSans_600SemiBold, NunitoSans_700Bold,
  });

  useEffect(() => {
    // Boot timeline. These marks are what make a startup claim checkable
    // instead of asserted — read them on-device from app/perf-debug.tsx:
    //   boot_effect_start  → this effect begins
    //   db_ready           → op-sqlite open (marked in the promise below)
    //   boot_unblocked     → first render is no longer gated
    //   boot_deferred_start→ the first frame has settled; deferred work begins
    // The gap boot_effect_start → boot_unblocked is cold-start cost the user
    // actually feels; anything after boot_deferred_start is off that path.
    perf.mark('boot_effect_start');

    // START THE SOCKET HANDSHAKE FIRST, but INSIDE the boot sequence.
    //
    // The connection must not wait for the rest of this effect: the TLS +
    // WebSocket + auth round trips are the slowest part of coming online, and
    // kicking them here overlaps them with the render instead of serialising
    // them after it. Fire-and-forget: getSocket() de-duplicates (the persistent
    // listeners armed further down join this same in-flight attempt rather than
    // opening a second socket), it refuses cleanly with "Not signed in" when
    // there is no token yet, and addPersistentListener's own retry ladder still
    // owns recovery. Nothing here changes WHAT connects or with which
    // credentials — only when the attempt starts.
    //
    // It used to sit at MODULE SCOPE, which ran it during bundle evaluation —
    // before React mounted, before boot_effect_start, and racing everything else
    // this effect owns. First line of the controlled sequence gets the same
    // overlap with one ordered timeline instead of two.
    //
    // Safe only because connect() re-applies persistent listeners on the
    // 'connect' event: this warm-up builds the socket before any listener is
    // registered, and without that re-apply an incoming call would attach to
    // nothing. See lib/socket.ts.
    try { void getSocket().catch(() => {}); } catch { /* never block boot */ }

    // ── 0. Warm up the op-sqlite local store (localDb, JSI engine) ──
    // The local-first source of truth for chats/messages. Guarded so a stale
    // binary without the native module can't crash launch.
    if (Platform.OS !== 'web') {
      getLocalDb()
        .then(() => perf.mark('db_ready'))
        .catch((e: any) => console.warn('[db] localDb init failed:', e?.message));
    }

    // ── 1. Block screenshots app-wide (native only) ──────────
    // Through screenGuard.setSecure, not expo-screen-capture directly: that is
    // the one function that knows a dev build must never set FLAG_SECURE (it
    // would blank every screenshot and screen recording of our own UI), and it
    // also drives the native VaultView module when the build has it.
    if (Platform.OS !== 'web') {
      setSecure(true).catch(() => {});
    }

    // ── 2. Google Sign-In is NOT configured here any more ───────
    // It used to be a synchronous require of ./(constants)/authService +
    // configureGoogleSignIn() on every launch, which parsed
    // @react-native-google-signin for users who never sign in with Google.
    // Each SDK entry point now configures itself instead: signInWithGoogle /
    // signOutGoogle (authService), pickGoogleAccount (lib/onboarding) — the
    // pattern lib/googleDrive.ts already used. See the note on
    // configureGoogleSignIn for why repeating it is also the correct fix.

    // ── 3. Security scan runs in the BACKGROUND ─────────────────
    // It used to be awaited before the first paint — and its two localhost
    // Frida probes alone can stall ~1.4s — so cold start felt slow. The scan
    // wipes keys + redirects to /blocked ITSELF if the device is compromised,
    // so running it async (without gating the UI) is safe and WhatsApp-fast.
    if (Platform.OS !== 'web') {
      runSecurityCheck()
        .then(report => {
          if (!report.clean) {
            router.replace({ pathname: '/blocked', params: { threats: JSON.stringify(report.threats) } });
          }
        })
        .catch(() => { /* fail open */ });

      // Passive device-security monitoring (Security Hub). Separate, NON-
      // destructive path: it scores the device, records changes to the audit
      // chain and notifies on worsenings — it never wipes. Throttled by the
      // scan scheduler (a quick relaunch won't re-scan) and fully deferred, so
      // it never gates first paint. Distinct from runSecurityCheck above, which
      // is the boot self-destruct.
      import('../services/security/deviceSecurity/monitorService')
        .then(m => m.runMonitoringScan('launch'))
        .catch(() => { /* best-effort; dashboard still scans on demand */ });

      // Wire passive triggers: re-scan on foreground return (throttled) and on
      // network change (debounced). Covers the while-running case; a periodic
      // scan while KILLED still needs a native background job.
      import('../services/security/deviceSecurity/monitorTriggers')
        .then(m => m.startSecurityMonitoring())
        .catch(() => {});

      // Automatic cache cleanup, if the user enabled it (safe cache only, when
      // due). Deferred + best-effort; never gates the UI.
      import('../services/cache/cacheManager')
        .then(m => m.maybeAutoClean())
        .catch(() => {});
    }

    // Publish this device's E2EE key bundle on startup (lazy, fire-and-forget).
    getAccessToken()
      .then(tok => {
        if (tok && E2EE_ENABLED) {
          import('../services/crypto/e2eeSession.rn').then(m => m.provisionE2EEIdentity()).catch(() => {});
        }
        // Register the native FCM token so calls ring when the app is killed.
        if (tok) registerForCalls();
      })
      .catch(() => {});

    // Unblock the UI immediately — nothing awaited gates the first render now.
    perf.mark('boot_unblocked');
    setSecurityChecked(true);

    // (attachTapHandler is wired below, after the call handlers are defined)
    let cleanupListeners = () => {};

    // Open the in-app ringing screen for a call. `offer` may be empty (push /
    // backgrounded) — incoming-call captures the caller's re-sent offer live.
    const routeToIncoming = (p: { chatId?: string; peerUid: string; peerName: string; type: string; offer?: string; group?: boolean; groupName?: string; waiting?: boolean }) => {
      // ONE RING SCREEN PER CALLER — the guard lives HERE, not at the call sites.
      //
      // This is a router.push, so every invocation stacks another
      // /incoming-call screen. The socket listener checked getRingingPeer()
      // before calling and was fine; the two notification paths
      // (consumeNativeLaunchIntent and the notifee answer/decline handler) did
      // not. Since the caller re-rings every 3s and each ring can produce a
      // notification, tapping them piled ring screens on top of each other —
      // reported as "so many overlays", with answering the in-app overlay
      // directly working normally because that path only ever routes once.
      //
      // Re-entering for a peer we are ALREADY ringing is a no-op: the screen is
      // up, it owns the ringtone, and it is listening for the caller's re-sealed
      // offer. Bringing it forward is what the OS is already doing.
      // Guard on the RING SCREEN, not on ringingPeer: the latter is already set
      // by the time a backgrounded device shows its notification, so using it
      // here refused to open the screen on the tap that was supposed to open it.
      if (getRingScreenPeer() === p.peerUid) {
        cancelIncomingCall();           // the in-app UI owns the ring; drop the OS one
        return;
      }
      cancelIncomingCall();             // clear any OS full-screen call once the in-app UI takes over
      setRingingPeer(p.peerUid);
      setRingScreenPeer(p.peerUid);
      router.push({
        pathname: '/incoming-call' as any,
        params: {
          chatId: p.chatId || '', peerUid: p.peerUid, peerName: p.peerName,
          type: p.type === 'video' ? 'video' : 'audio',
          offer: p.offer || '',
          group: p.group ? '1' : '', groupName: p.groupName ?? '',
          waiting: p.waiting ? '1' : '',
        },
      });
    };

    // ── Incoming-call listener (Socket.IO) ──────────────────────────────
    const onIncoming = (data: any) => {
      if (!data?.from || !data?.chatId) return;

      // WARM THE ICE/TURN FETCH THE MOMENT THE RING ARRIVES.
      //
      // joinCallRoom needs ice servers before it can connect, and asking for
      // them is a network round trip to a server in Germany. Starting it here
      // — while the phone is still ringing and the user has not decided yet —
      // means the answer does not pay for it. getIceServers caches, never
      // throws, and degrades to STUN, so this is free if the user declines.
      //
      // Deliberately NOT a full pre-warm: opening the call session early would
      // create the call_participants row before the user answered, and the
      // CALLER would see them as joined while the phone was still ringing.
      // Slow is better than lying about who is on the call.
      void import('../lib/iceConfig').then(m => m.getIceServers()).catch(() => {});
      const active = getActiveCall();
      if (active && active.peerUid === data.from && !data.group) return;   // call-waiting same peer
      if (getRingingPeer() === data.from) return;                          // de-dupe repeated rings
      setRingingPeer(data.from);
      // EMPTY, not the placeholder string, when the signal carries no name.
      //
      // The call screens resolve a blank peerName via getChat(chatId) — but the
      // guard is `if (peerName || !chatId) return`, so handing them the literal
      // 'VaultChat user' looks like a REAL name, skips the lookup, and pins the
      // placeholder on screen for the whole call. That is the reported
      // "usernames not getting displayed, instead getting VaultChat user": the
      // fallback was being injected upstream as data rather than rendered
      // downstream as a last resort.
      const name = data.group ? (data.groupName || 'Group call') : (data.callerName ?? data.fromName ?? '');
      const type = (data.type === 'video' || data.video === '1') ? 'video' : 'audio';
      // App in the FOREGROUND (or a group call) → show the in-app screen.
      // App BACKGROUNDED with a live socket → raise the OS full-screen call UI
      // (lock screen). Answering it routes into the app via the notifee events.
      if (AppState.currentState === 'active' || data.group) {
        routeToIncoming({ chatId: data.chatId, peerUid: data.from, peerName: name, type, offer: data.offer ? JSON.stringify(data.offer) : '', group: !!data.group, groupName: data.groupName, waiting: !!active });
      }
      // NOT backgrounded → do NOT raise a notifee ring here.
      //
      // The native VaultCallMessagingService owns every OS ring (it is the only
      // one that can ring a killed app, and it carries the caller's photo). Two
      // owners is what produced the second, avatar-less notification on channel
      // "calls". The server now pushes on every call rather than guessing from
      // hasLiveSocket, and the native side stays silent while we are foreground,
      // so exactly one of us rings in every state.
    };
    const cleanupCallListener = addPersistentListener('call_incoming', onIncoming);

    // E2EE Stage-2 auto-recovery: a peer that couldn't decrypt us asks us to
    // reset our session so our next message re-runs X3DH (persistent so it
    // survives socket reconnects, like the call listener).
    const cleanupRekey = addPersistentListener('e2ee_rekey', (data: any) => {
      const from = data?.from ?? data?.fromUid;
      // `force` marks a peer whose CALL setup failed — honoured immediately
      // rather than being held back by the anti-thrash window.
      //
      // `epoch` identifies WHICH breakage the peer is reporting, so a repeat of
      // a complaint we have already acted on can be recognised and dropped
      // instead of tearing down the session we rebuilt for it. Left undefined
      // by peers on older builds, which falls back to the timer alone.
      const epoch = typeof data?.epoch === 'number' ? data.epoch : undefined;
      if (from) import('../lib/chatService').then(m => m.handleRekeyRequest(String(from), data?.force === true, epoch)).catch(() => {});
    });

    // ── Boot work that the user is WAITING for ─────────────────────────
    // These four decide what the first screen shows, so they start now:
    // catch-up on messages missed while offline, re-flush dropped receipts,
    // resume interrupted media sends, and drain the text outbox.
    import('../lib/syncEngine').then(m => m.initSync()).catch(() => {});
    import('../lib/receipts').then(m => m.initReceipts()).catch(() => {});
    import('../lib/mediaOutbox').then(m => m.initMediaOutbox()).catch(() => {});
    // The TEXT outbox belongs here for the same reason the media one does, and
    // it was the only one missing. Its sole other caller is the chat screen's
    // mount effect, so until some individual chat was opened there was no boot
    // drain, no NetInfo reconnect flush and no periodic tick — queue messages
    // offline, restart, stop at the chat list, regain network, and nothing sent.
    // It also left `online` stale-true, since only initQueue's listener writes it.
    import('../lib/messageQueue').then(m => m.initQueue()).catch(() => {});

    // ── Boot work that can wait for the first frame ────────────────────
    // Neither of these changes anything the user can see on the chat list, and
    // both are I/O heavy at exactly the wrong moment: resumePendingSends reads
    // transfer state and re-opens uploads, and sweepMediaCache walks the media
    // cache directory. Running them during the first render competes with the
    // JS thread for no visible benefit.
    //
    // runAfterInteractions defers to after the initial render/animation settles
    // — NOT a fixed timeout, so on a slow device it waits longer and on a fast
    // one it barely waits at all. Both remain fire-and-forget and keep their own
    // error handling, so a deferred failure is still contained.
    const deferred = InteractionManager.runAfterInteractions(() => {
      perf.mark('boot_deferred_start');
      // VaultBeam: resume any relay upload interrupted by an app kill (the
      // recipient resumes symmetrically via the server bitmask).
      import('../lib/vaultBeamController').then(m => m.resumePendingSends()).catch(() => {});
      // Bound the re-derivable media cache (safe: never touches the user's library).
      import('../lib/mediaCacheGC').then(m => m.sweepMediaCache()).catch(() => {});
      // One-time: drain the legacy external media tree
      // (/Android/media/<pkg>/VaultChat) into the private sandbox, then delete
      // it. That tree is the reason media used to survive uninstall. Self-gating
      // (no-ops once complete), resumable, and never fatal — see lib/mediaMigration.
      import('../lib/mediaMigration').then(m => m.migrateLegacyMedia()).catch(() => {});
    });

    // No-GMS background delivery (Phase 4): raise a local notification for each
    // inbound message. Global + persistent so it fires while the app is
    // backgrounded-but-alive (foreground-service connection). notify() self-gates
    // (skips push-capable devices, foregrounded app, own echo, duplicates).
    import('./(constants)/authService').then(m => m.getCurrentUserAsync().then((u: any) => {
      setSelfId(u?.id ?? null);
      selfIdRef.current = u?.id != null ? String(u.id) : null;   // famEvent ingest skips my own events
    })).catch(() => {});
    const cleanupMsgNotif = addPersistentListener('new_message', (m: any) => {
      // famEvent envelopes ride `system`-type messages, and `type` is a
      // plaintext DB column — only `content` is E2EE (group chats default to
      // GROUP_E2EE=true). So `m.content` here is CIPHERTEXT for any encrypted
      // group, and a plain string match against it can never see the marker.
      // Found by review: the very first shipped version of this check tested
      // ciphertext and therefore never fired — every crossing kept buzzing the
      // phone as "new message" and the alerts inbox never filled remotely.
      //
      // Only `system`-type messages pay the decrypt cost here; every ordinary
      // text/media message skips straight to notifyMessage below, unchanged —
      // this does not weaken "never decrypt in the background" for the common
      // case. decryptFromChat self-routes on the envelope prefix and passes
      // plaintext/legacy content through untouched, so this is safe even for
      // a real (non-famEvent) system message like "X was added to the group".
      //
      // THE MESSAGE ID IS LOAD-BEARING, and it arrives as a STRING.
      // chatsPublicMsg emits `ID string` (fmt.Sprintf("%d")) — an in-repo
      // comment claiming the socket delivers a number is wrong. Getting this
      // wrong is not cosmetic: groupDecryptMessage only writes the plaintext
      // cache `if (messageId > 0)`, while the sender-key ratchet advances
      // UNCONDITIONALLY and does not retain the consumed iteration as a
      // skipped key (senderKey.ts: "too old / already used"). So decrypting
      // here without a real id would consume the ratchet step and cache
      // nothing — and the chat thread's own later decrypt of that same
      // message would throw, leaving EVERY group system message permanently
      // unreadable. With the real id, the plaintext is cached and the thread
      // gets a cache hit instead of a second ratchet step.
      const msgId = Number(m?.id);
      // No usable id → do NOT decrypt at all. Falling through to a plain
      // notification is the old behaviour (a famEvent may buzz once); a
      // corrupted ratchet is not recoverable.
      if (m?.type === 'system' && typeof m?.content === 'string' && m?.chatId
          && Number.isFinite(msgId) && msgId > 0) {
        Promise.all([import('../lib/chatService'), import('../lib/family/alerts')])
          .then(async ([cs, a]) => {
            const plain = await cs.decryptFromChat(
              String(m.chatId), String(m.senderId ?? ''), m.content, msgId);
            if (a.isFamEvent(m.type, plain)) {
              a.ingestFamEvent(String(m.chatId), plain, String(selfIdRef.current ?? ''));
              return; // muted — the alerts badge is this message's surface, not a banner
            }
            notifyMessage(m).catch(() => {});
          })
          // Decrypt/import itself failed (not "not a famEvent" — parseFamEvent
          // already returns null for that) — fail OPEN to a notification. A
          // spurious "New message" banner is recoverable; a silently dropped
          // real message is not.
          .catch(() => { notifyMessage(m).catch(() => {}); });
        return;
      }
      notifyMessage(m).catch(() => {});
      // VaultBeam auto-download (flag-gated; no-op when off / not a vaultbeam msg).
      if (m?.meta?.vaultbeam) import('../lib/vaultBeamIngest').then(v => v.onIncomingVaultbeamMessage(m)).catch(() => {});
    });

    // ── native launch intent (message tap / call tap) ────────────────────
    //
    // MUST BE RE-READ ON RESUME, NOT ONLY AT MOUNT.
    //
    // MainActivity is launchMode="singleTask", so when the app is already in
    // memory — the normal case — a notification tap is delivered to
    // onNewIntent, which calls setIntent() so getIntent() is current. But this
    // block used to run once inside the mount effect, and nothing read the
    // intent again afterwards. The extras arrived and were simply never
    // consumed: the app came to the foreground on whatever screen it was
    // already showing, so tapping a message notification opened the chat LIST
    // instead of the chat.
    //
    // Verified on the Redmi: `am start` with the notification's own extras
    // reported "intent has been delivered to currently running top-most
    // instance" and the screen stayed on the list. It only ever worked from a
    // COLD start, where the notification intent happens to BE the launch
    // intent this effect reads.
    //
    // So the consumer is named and also fired on AppState 'active', which is
    // exactly when a tap brings the app forward. getInitialCallIntent clears
    // the extras as it reads them, so an ordinary resume with no pending tap
    // reads null and does nothing — no navigation, no visual change.
    const consumeNativeLaunchIntent = async () => {
      try {
        const ci = await getInitialCallIntent();
        if (ci?.action === 'open_chat' && ci.chatId) {
          // Native message-notification tap (F2 content-free doorbell).
          router.push({ pathname: '/chat', params: { id: ci.chatId } } as any);
        } else if (ci?.action === 'open_game') {
          // VaultGames turn/invite tap. game+room are carried through so the
          // WebView opens the exact table the push was about — landing on the
          // hub instead would make the player hunt for their own game.
          router.push({ pathname: '/games', params: { game: ci.game ?? '', room: ci.room ?? '' } } as any);
        } else if (ci?.callId && ci.action !== 'open_calls') {
          // A GROUP ring answered from the lock screen must open the GROUP call.
          //
          // Every field here is shaped for 1:1 — peerUid is the caller, and the
          // 1:1 screens would place a call to THAT PERSON rather than joining the
          // group call the notification was about. `isGroup` rides the intent
          // from VaultCallMessagingService and defaults false, so a 1:1 ring and
          // any intent built by an older native build behave exactly as before.
          const to = ci.action === 'answer' ? routeToCall : routeToIncoming;
          to({
            // Blank, not the placeholder — see the note on the socket ring above.
            // peerUid stays the CALLER even for a group: it is the de-dupe key
            // both routers guard on, and an empty one would collide with "no
            // ring on screen" and silently refuse to open the ring screen. The
            // `group` flag is what decides the destination, not this.
            chatId: ci.callId, peerUid: ci.callerId || '',
            peerName: ci.callerName || '',
            type: ci.isVideo ? 'video' : 'audio', offer: '',
            group: !!ci.isGroup, groupName: ci.callerName || '',
          });
        }
      } catch {}
    };
    const launchIntentSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') consumeNativeLaunchIntent();
    });

    // ── Notifee full-screen call events (foreground) ────────────────────
    // ANSWERED FROM THE OS — go straight into the call.
    //
    // The OS ring IS the ring. Routing an explicit Answer through the in-app
    // ring screen made the user accept twice: the notification's Answer, then
    // a second full-screen overlay that appeared on top of it. Reported on
    // device exactly that way.
    //
    // Safe now because the call screen no longer needs the caller's envelope to
    // answer — the chat identifies the call (see engine.acceptIncoming).
    // ONE CALL SCREEN PER ANSWER.
    //
    // routeToCall is reachable from FOUR places: the native answer intent
    // (consumeNativeLaunchIntent) and three notifee handlers — the foreground
    // event, the initial notification, and the background handler. More than one
    // firing for a single answer is NORMAL, not exceptional, and each did its
    // own router.push. Two pushes mount two call screens, and each screen's
    // effect starts its own session — the second replacing the first via
    // bootstrap's hangUp('replaced').
    //
    // That is the "it makes too many calls" report: two call ids seconds apart
    // on one chat, ringing the callee twice. The engine now holds a setup claim
    // too (lib/call/engine.ts); stopping it here means the duplicate screen is
    // never mounted at all.
    //
    // Keyed by peer+kind and TIME-BOXED, so a genuine second call to the same
    // person a minute later still opens a screen.
    const routedCalls = new Map<string, number>();
    // 2s, not 10s. The duplicate handlers fire within MILLISECONDS of each
    // other (same answer event, several listeners), so a short window collapses
    // them just as well. Ten seconds was over-aggressive: answer, hang up, and
    // answer again inside that window and the second call screen would never
    // open — a worse bug than the one being fixed.
    const ROUTE_DEDUPE_MS = 2_000;
    const routeToCall = (p: { chatId?: string; peerUid: string; peerName: string; type: string; group?: boolean; groupName?: string }) => {
      const dedupeKey = `${p.peerUid}|${p.type}|${p.group ? 'g' : 'd'}`;
      if (Date.now() - (routedCalls.get(dedupeKey) ?? 0) < ROUTE_DEDUPE_MS) return;
      routedCalls.set(dedupeKey, Date.now());
      cancelIncomingCall();
      // CLAIM the ring, do not release it.
      //
      // Clearing these was a bug I introduced with this route: the caller keeps
      // re-ringing every 3s until the call connects, and routeToIncoming's
      // guard is exactly `getRingScreenPeer() === peerUid`. With it cleared,
      // the next ring opened the in-app ring screen ON TOP of the call the user
      // had just answered — the overlay that survived the first fix.
      //
      // Claiming it means "this peer's ring is already being handled here". The
      // call screens release it when they unmount.
      setRingingPeer(p.peerUid);
      setRingScreenPeer(p.peerUid);
      if (p.group) {
        router.push({ pathname: '/group-call-active' as any,
          params: { chatId: p.chatId || '', video: p.type === 'video' ? '1' : '0', name: p.groupName || p.peerName } });
        return;
      }
      router.push({
        pathname: (p.type === 'video' ? '/videocall' : '/voicecall') as any,
        params: { chatId: p.chatId || '', peerUid: p.peerUid, peerName: p.peerName, isIncoming: 'true' },
      });
    };

    const onNotifeeAnswerOrDecline = (action: string, data: any) => {
      if (data?.type !== 'call' || !data?.fromUid) return;
      cancelIncomingCall();
      if (action === 'decline') {
        setRingingPeer(null);
        getSocket().then(s => s.emit('webrtc_end', { to: data.fromUid, chatId: data.chatId })).catch(() => {});
        return;
      }
      routeToCall({ chatId: data.chatId, peerUid: data.fromUid, peerName: data.callerName || '', type: data.callType });
    };
    const notifeeFg = notifee.onForegroundEvent(({ type, detail }) => {
      // Scheduled-message trigger fired (#73) → send any due items.
      if (detail?.notification?.data?.type === 'scheduled_fire') { runDueScheduled(); return; }
      if (type !== EventType.ACTION_PRESS && type !== EventType.PRESS) return;
      onNotifeeAnswerOrDecline(detail?.pressAction?.id === 'decline' ? 'decline' : 'answer', detail?.notification?.data);
    });

    // App launched/woken BY a call notification → act on it once up.
    (async () => {
      try {
        const initial = await notifee.getInitialNotification();
        if (initial?.notification?.data?.type === 'call') {
          onNotifeeAnswerOrDecline(initial.pressAction?.id === 'decline' ? 'decline' : 'answer', initial.notification.data);
        }
      } catch {}
      const pending = consumePendingCall();   // chosen from a bg notification action
      if (pending) onNotifeeAnswerOrDecline(pending.action, pending.data);

      // Native full-screen-intent (FCM) launch → open the in-app ringing screen.
      // The caller re-emits the offer over the socket; incoming-call captures it live.
      await consumeNativeLaunchIntent();

      // A decline tapped on the killed lock-screen notification → stop the caller's ring.
      try {
        const declined = await drainDeclinedCall();
        if (declined) getSocket().then(s => s.emit('webrtc_end', { chatId: declined })).catch(() => {});
      } catch {}
    })();

    // Expo notification tap / actions (heads-up call push fallback).
    const onCallNotification = (data: any, action: string) =>
      onNotifeeAnswerOrDecline(action === 'decline' ? 'decline' : 'answer', { ...data, type: 'call' });

    if (Platform.OS !== 'web') {
      cleanupListeners = attachTapHandler(
        (chatId) => { router.push({ pathname: '/chat', params: { id: chatId } } as any); },
        onCallNotification,
        // Membership pushes: an accepted member lands in the space, an invitee
        // lands on the invitation itself — never in a chat they cannot open.
        (event, chatId) => {
          if (event === 'member_approved' && chatId) {
            router.push({ pathname: '/family', params: { groupId: chatId } } as any);
          } else {
            router.push('/group-invitations' as any);
          }
        },
        // A games turn push: land ON the table, not on the hub. An unknown game
        // or a blank room opens the hub, which is what /games does with params
        // it does not recognise anyway.
        (game, room) => {
          router.push({ pathname: '/games', params: game && room ? { game, room } : {} } as any);
        },
      );
    }

    return () => {
      if (Platform.OS !== 'web') {
        setSecure(false).catch(() => {});
      }
      deferred.cancel();   // don't run deferred boot work after unmount
      launchIntentSub.remove();
      cleanupListeners();
      cleanupCallListener();
      cleanupRekey();
      cleanupMsgNotif();
      notifeeFg();
    };
  }, [router]);

  // Scheduled messages (#73): fire due items on start + every foreground, and
  // re-arm OS triggers (some OEMs clear alarms on force-stop). Sends fail-soft
  // if not signed in yet and retry on the next sweep.
  useEffect(() => {
    if (!SCHEDULED_LOCAL) return;
    runDueScheduled();
    rearmAllTriggers();
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') runDueScheduled(); });
    return () => sub.remove();
  }, []);

  // KEEP THE CALL DOORBELL ALIVE.
  //
  // registerForCalls() runs once at boot, and that is not enough: FCM rotates
  // tokens (reinstall, data clear, restore, expiry), a phone can boot before its
  // network is up, and a user can sign in after launch. In all three the server
  // ends up holding a token that no longer reaches this device, so it stops
  // ringing while killed — silently, and until the next cold start.
  //
  // refreshCallRegistration is cheap: it reads the current token locally and
  // returns without any network request unless the token actually changed or the
  // last attempt did not succeed, which is the case on essentially every
  // foreground. Registered here rather than inside the boot effect so it keeps
  // running for the whole life of the process.
  useEffect(() => {
    void refreshCallRegistration().catch(() => {});
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void refreshCallRegistration().catch(() => {});
    });
    return () => sub.remove();
  }, []);

  // Show spinner while security check runs
  // Prevents any screen flashing before check completes
  if (!securityChecked) {
    return (
      <GestureHandlerRootView style={[styles.loading, { backgroundColor: colors.bg }]}>
        <StatusBar style={scheme === 'light' ? 'dark' : 'light'} />
        <ActivityIndicator size="large" color={BRAND_ACCENT} />
      </GestureHandlerRootView>
    );
  }

  return (
    <FontReadyContext.Provider value={fontsReady}>
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar style={scheme === 'light' ? 'dark' : 'light'} />
      {/* The version floor wraps EVERYTHING below it. A build under the
          server's minimum cannot be allowed to reach the navigator at all:
          this app's formats are versioned (envelopes, sender keys, backups)
          and an out-of-date client misreads rather than failing loudly. It
          renders its children untouched in the normal case, so this costs a
          passing build nothing. */}
      <UpdateGate>
      {/* INSIDE the version gate, not outside: a client below the minimum build
          must be told to update before it is asked to accept anything, because
          what it would be accepting is whatever an out-of-date build knows how
          to display. Fails open on every uncertain path — offline, an outage,
          no configured version, not signed in — so it costs a normal launch
          nothing and can never strand anyone (audit F10). */}
      <TermsGate>
      {/* ABOVE the navigator, so it survives every screen change. A call used
          to take the whole app hostage: the engine owned the call outside
          React, but the call screen's unmount said "hang up", so navigating
          anywhere ended it. The bar is the way back — and the only way to end
          a call you have stepped away from. It renders nothing when no call is
          live, and hides itself on the call screens. */}
      <CallBar />
      {/* The navigator's own ground stays OPAQUE at the aurora base. A
          transparent contentStyle would let the previous screen show through a
          native-stack push, so the blooms are mounted per screen instead (each
          screen root is transparent with an <AuroraBackground /> behind it). */}
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>

        {/* Status-bar inset for the screens that draw their own header. */}
        {INSET_SCREENS.map(name => (
          <Stack.Screen
            key={name}
            name={name}
            options={{ contentStyle: {
              backgroundColor: colors.bg,
              paddingTop: HEADER_TOP,
              // Edge-to-edge cuts the bottom too: group-create's last icon row
              // sat under the gesture bar. Padding the screen container shrinks
              // the scroll viewport, so the final row can be scrolled clear.
              paddingBottom: SCREEN_BOTTOM,
            } }}
          />
        ))}

        {/* Security — gesture disabled so user can't swipe back */}
        <Stack.Screen name="blocked" options={{ gestureEnabled: false }} />

        {/* Auth flow */}
        <Stack.Screen name="index" />
        <Stack.Screen name="security-questions" />
        <Stack.Screen name="facescan" />
        <Stack.Screen name="biometric-setup" />
        {/* Main app — 6-tab navigation */}
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="chat" />
        <Stack.Screen name="join/[code]" options={{ headerShown: false }} />
        {/* Private Live invitation redeem — the /live/join/<code> link the host
            copies, and vaultchat://live/join/<code>. */}
        <Stack.Screen name="live/join/[code]" options={{ headerShown: false }} />
        <Stack.Screen name="videocall" />
        <Stack.Screen name="voicecall" />
        <Stack.Screen name="qr-contact" />
        <Stack.Screen name="add/[...segments]" options={{ headerShown: false }} />
        <Stack.Screen name="file-preview" />
        <Stack.Screen name="voice-transcribe" />
        <Stack.Screen name="lock" />
        <Stack.Screen name="media-viewer" />
        <Stack.Screen name="whiteboard" />
        <Stack.Screen name="bookmarks" />
        <Stack.Screen name="receipt-control" />
        <Stack.Screen name="chat-themes" />
        <Stack.Screen name="chat-wallpaper" />
        <Stack.Screen name="chat-export" />
        <Stack.Screen name="in-chat-search" />
        <Stack.Screen name="message-reminder" />
        <Stack.Screen name="contact-info" />
        <Stack.Screen name="stickers" />
        <Stack.Screen name="create-poll" />
        <Stack.Screen name="schedule-message" />
        <Stack.Screen name="broadcast" />
        <Stack.Screen name="media-gallery" />
        <Stack.Screen name="invite-link" />
        <Stack.Screen name="trusted-contacts" />
        <Stack.Screen name="login-history" />
        <Stack.Screen name="decoy-chats" />
        <Stack.Screen name="decoy-chat" />
        <Stack.Screen name="hidden-chats" />
        <Stack.Screen name="camera" options={{ headerShown: false, presentation: 'modal' }} />
        {/* status, calls now in (tabs) */}
        <Stack.Screen name="vault" />
        <Stack.Screen name="vaultdrop" />
        {/* alerts, profile now in (tabs) */}

        {/* Features */}
        <Stack.Screen name="contacts" />
        <Stack.Screen name="location-sharing" />
        <Stack.Screen name="vault-features" />
        <Stack.Screen name="dashboard" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="story-viewer" />
        <Stack.Screen name="meeting-scheduler" />
        <Stack.Screen name="finance" options={{ headerShown: false }} />
        <Stack.Screen name="email-bridge" />
        <Stack.Screen name="group-admin" />
        <Stack.Screen name="call-recording" />
        <Stack.Screen name="app-lock-chats" />
        <Stack.Screen name="privacy-dashboard" />
        <Stack.Screen name="storage-manager" />
        <Stack.Screen name="chat-backup" />
        <Stack.Screen name="last-seen-privacy" />
        <Stack.Screen name="offline-mode" />
        <Stack.Screen name="image-editor" />
        <Stack.Screen name="file-viewer" />
        <Stack.Screen name="reader" options={{ presentation: 'modal' }} />
        <Stack.Screen name="split" />
        <Stack.Screen name="shelf" />
        <Stack.Screen name="archive-viewer" />
        <Stack.Screen name="video-player" />
        <Stack.Screen name="slideshow" />
        <Stack.Screen name="group-calls" />
        <Stack.Screen name="group-info" />

        {/* Auth extras */}
        <Stack.Screen name="face-verify-new-device" />

        {/* Security & Privacy */}
        <Stack.Screen name="ghost-mode" />
        <Stack.Screen name="chat-code" />
        <Stack.Screen name="restore-backup" options={{ gestureEnabled: false }} />
        <Stack.Screen name="delete-account" />
        <Stack.Screen name="aiguardian" />
        <Stack.Screen name="backup-pin" />
        <Stack.Screen name="permissions" />
        <Stack.Screen name="memoryshield" />

        {/* Social & Contacts */}
        <Stack.Screen name="contact" />
        <Stack.Screen name="communities" />
        <Stack.Screen name="sync-contact" />
        <Stack.Screen name="msgrequests" />
        <Stack.Screen name="create-group" />

        {/* Utility */}
        <Stack.Screen name="search" />
        <Stack.Screen name="scheduled" />
        <Stack.Screen name="perf-debug" />
        <Stack.Screen name="scanner" />
        <Stack.Screen name="docscanner" />
        <Stack.Screen name="notifications" />
        <Stack.Screen name="location" />
        <Stack.Screen name="vaultid" />

        {/* Mini Apps destinations */}
        <Stack.Screen name="encrypted-notes" />
      </Stack>
    </TermsGate>
    </UpdateGate>
      {/* Offscreen, renders nothing the user sees: the only canvas on the
          device, so a PDF can be turned into a bubble preview.
          Mounted here but INERT until the first thumbnail is requested — it
          used to build a WebView on every cold start, which meant every user
          paid to instantiate Chromium and load pdf.js whether or not they ever
          opened a document. See components/PdfThumbnailer.tsx. */}
      <PdfThumbnailerHost />
    </GestureHandlerRootView>
    </FontReadyContext.Provider>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    // Ground colour is applied inline from the active palette; this is only the
    // pre-theme fallback for the split second before the provider resolves.
    backgroundColor: '#0A0810',   // theme-exempt: pre-provider fallback, overridden inline
    justifyContent: 'center',
    alignItems: 'center',
  },
});

// Sentry.wrap forwards refs + injects a top-level error boundary that
// reports to Sentry before re-throwing. No-op when Sentry isn't init'd.
function RootLayout() {
  return (
    <ThemeProvider>
      <RootLayoutInner />
    </ThemeProvider>
  );
}

export default SENTRY_DSN ? Sentry.wrap(RootLayout) : RootLayout;
