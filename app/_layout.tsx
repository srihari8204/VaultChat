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

// MUST BE FIRST — installs DOMException that Hermes does not have.
//
// livekit-client is a browser library and touches those globals at MODULE
// SCOPE, so anything importing it before this line throws
// `ReferenceError: Property 'DOMException' doesn't exist` — which surfaces as a
// WHITE SCREEN with no error of ours in the log, because the module never
// evaluated. Observed exactly that on the Go Live screen.
//
// Placed at the entry point rather than relying on import order inside feature
// modules. Importing @livekit/react-native here pulled the whole call stack into
// every cold start; this local module provides only the global LiveKit needs.
import '../lib/domExceptionPolyfill';

import { Buffer } from 'buffer';

import { Stack, useGlobalSearchParams, usePathname, useRouter, useSegments } from 'expo-router';
import { type ComponentType, useEffect, useRef, useState } from 'react';
import { setSecure } from '../lib/screenGuard';
import { installAlertGuard } from '../lib/alertGuard';
import { loadRemoteFlags } from '../lib/remoteFlags';
import { primeChats } from '../lib/chatsPrefetch';
import { initFeatureFlags } from '../lib/featureFlags';
import { registerMessageActions } from '../lib/notificationActions';
import { initLang } from '../lib/i18n';
import { attachUsageFlush, initUsageCounter } from '../lib/usageCounter';
import { purgeRetiredKeys } from '../lib/retiredKeys';
import { UsageCounter } from '../components/UsageCounter';
import { ResumeLock } from '../components/ResumeLock';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { useSpaceDeviceAgent } from '../lib/spaces/deviceAgent';
import { isSessionEnded } from '../lib/sessionEnded';
import * as SplashScreen from 'expo-splash-screen';
import * as Sentry from '@sentry/react-native';
import { StatusBar } from 'expo-status-bar';
import { HEADER_TOP, SCREEN_BOTTOM } from '../constants/layout';
import { Platform, AppState, InteractionManager, View } from 'react-native';
import notifee, { EventType } from '@notifee/react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { CallBar } from '../components/CallBar';
import { UpdateGate } from '../components/UpdateGate';
import { TermsGate } from '../components/TermsGate';
import { enableFreeze } from 'react-native-screens';
import { FontReadyContext } from '../components/ui/Text';
import { ThemeProvider, useTheme } from '../lib/theme';
import { VisionComfortProvider } from '../lib/visionComfort';

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
import { getAccessToken, getLaunchSessionState } from '../lib/api';
import { launchAllowed, settleLaunchGate } from '../lib/launchGate';
import { deliverTap, hrefWithQuery, onDeliveredTap, openWhenUnlocked, stashLaunchLink } from '../lib/pendingLink';
import { holdSecurityVerdict, securityVerdict } from '../lib/securityVerdict';
import { isMfaEnabled } from '../lib/mfa';
import { E2EE_ENABLED, SCHEDULED_LOCAL } from '../constants/flags';
import { mark } from '../lib/perf';
global.Buffer = Buffer;

// Screens below the top of the stack stay MOUNTED by default, so every one of
// them keeps re-rendering on each context/state change. Measured on-device:
// native View count climbed 757 -> 1308 over 10 navigations and never came
// back, with PSS reaching 359 MB. Freezing suspends offscreen screens without
// unmounting them, so `back` is still instant.
enableFreeze(true);

// Keep the native splash up until the cold-start router (app/index.tsx) has made
// its auth decision and navigated. This is the WhatsApp trick: no intermediate
// spinner/white-flash between the splash and the chats list — index.tsx hides
// the splash once it has routed. preventAutoHide MUST run at module load, before
// the splash would auto-hide when the JS bundle finishes loading.
SplashScreen.preventAutoHideAsync().catch(() => {});

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

// AUDIT F11 — pull the kill switches at boot.
//
// Not awaited, and nothing waits on it: until it resolves, every flag reads as
// whatever the build intends, which is the correct behaviour at every instant.
// It applies the persisted answer within milliseconds, so a feature switched
// off yesterday stays off through a cold start with no network — the case that
// matters most, since a feature bad enough to disable is usually bad on a bad
// connection too.
loadRemoteFlags().catch(() => {});

// §21 (P2) — load what the rollout flag needs, before the first getSocket().
//
// Module scope and NOT awaited, for the same reason as the line above: nothing
// may wait on it. Until it resolves there is no install id, so every flag reads
// OFF and the app uses the realtime transport it uses today — which is also
// what it does if this never resolves at all. It cannot reject (initFeatureFlags
// swallows everything); the .catch is there so a future edit cannot make an
// unhandled rejection out of it. See docs/ROLLOUT_TRANSPORT.md.
initFeatureFlags().catch(() => {});

// AUDIT F6 — attach Reply and Mark as read to message notifications.
//
// Module scope and not awaited: the category must exist before the first
// notification arrives, which can be before any screen has mounted, and a
// device that refuses it simply shows the notification without buttons — the
// behaviour before this existed.
registerMessageActions().catch(() => {});

// AUDIT F8 — load the saved language (or the device's) before the first screen.
//
// Not awaited: t() answers in English until this resolves, which is the correct
// default at every instant and takes one AsyncStorage read to correct. Gating
// render on it would trade a correct first paint for a blank one.
initLang().catch(() => {});

// AUDIT F9 — read the usage-counter preference before anything can be counted.
//
// Order matters: countScreen() checks the flag, and the flag defaults to ON, so
// a preference read that landed AFTER the first navigation would have counted a
// screen for someone who had switched counting off. One AsyncStorage read at
// module scope closes that window.
initUsageCounter().catch(() => {});
attachUsageFlush();

// Delete storage belonging to features that no longer exist — see
// lib/retiredKeys.ts for what and why. Fire-and-forget at module scope
// deliberately: nothing waits on it, nothing reads what it deletes, and a
// device whose keystore is locked at launch simply finishes the job next time.
purgeRetiredKeys().catch(() => {});

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
// REMOVED from this list: the eleven screens that now render a NATIVE header
// (they declare headerShown:true in their own Stack.Screen options). A native
// header already owns the status-bar inset, so leaving them here padded them a
// second time — the exact double-inset this list's own note warns about.
const INSET_SCREENS = [
  'emergency-sos',
  'lock-alert',
  'network-test',
  'onboard-mpin',
  'onboard-success',
  'settings',
  'vaultbeam-settings',
  'vision-comfort',
  'eye-check',
] as const;

function RootLayoutInner() {
  const { colors, scheme } = useTheme();
  // Spaces > Devices: heartbeat + command collector. Idle unless this phone was
  // registered as a space device (lib/spaces/deviceAgent.ts).
  useSpaceDeviceAgent();
  /** My user id, for the famEvent ingest below — a ref because the persistent
   *  listener closure outlives any render. */
  const selfIdRef = useRef<string | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  // The launch URL WITH its query: usePathname() drops `?code=` and the like,
  // and a stashed link must replay exactly as it was tapped.
  const globalParams = useGlobalSearchParams();
  const segments = useSegments();
  const launchHref = hrefWithQuery(pathname, globalParams, segments);
  /** Current route for the notification-tap gate; the boot effect outlives renders. */
  const pathRef = useRef(pathname);
  pathRef.current = pathname;
  const [launchGate, setLaunchGate] = useState<'checking' | 'allow' | '/onboard' | '/app-lock'>('checking');
  const [PdfHost, setPdfHost] = useState<ComponentType | null>(null);

  // The root owns authentication because an initial deep link bypasses `/` and
  // never mounts index.tsx. Keep an opaque veil over the navigator until both
  // the session decision and Android FLAG_SECURE are ready. Authorized links
  // are left untouched; only signed-out/locked launches are redirected.
  useEffect(() => {
    let live = true;
    const secure = Platform.OS === 'web' ? Promise.resolve(false) : setSecure(true);
    // WHERE THIS LAUNCH WAS TRYING TO GO, captured before anything redirects.
    //
    // Every branch below except 'allow' calls router.replace, and a replace
    // discards the deep link for good -- nothing else in the app remembered it.
    // So a link into a signed-out or locked app was silently dropped: tap link,
    // get the lock screen, unlock, land on Chats, never learn the link existed.
    // Found via vaultchat://emergency-sos, but SOS was never special -- an
    // invite, a chat and a call all died the same way.
    //
    // `pathname`, NOT expo-linking's initial-URL read. Two guards forbid that
    // call here by NAME, matching on the raw file text -- so this comment must
    // not spell it either.
    // (lib/startupColdPath.selftest.ts:40, lib/games/gamesNative.selftest.ts:520)
    // because the splash must be hidden on `launchReady` and nothing else, and
    // an await on the URL is how that property gets quietly broken. It is also
    // unnecessary: expo-router has ALREADY routed the initial URL by the time
    // this effect runs -- effects fire after the first render -- so pathname is
    // that destination, with no new import on the cold-start path.
    //
    // Stashed only on the redirecting branches. A launch that is allowed
    // through needs no help; it is already where it was going. `launchHref` is
    // pathname plus query (lib/pendingLink.hrefWithQuery), so a broadcast
    // invite's `?code=` survives the unlock.
    Promise.all([secure, getLaunchSessionState(), isMfaEnabled()])
      .then(([, session, mfaOn]) => {
        if (!live) return;
        if (!session.signedIn) {
          stashLaunchLink(launchHref);
          settleLaunchGate(false);
          setLaunchGate('/onboard');
          router.replace('/onboard' as any);
        } else if (mfaOn || session.sealedLocked) {
          stashLaunchLink(launchHref);
          settleLaunchGate(false);
          setLaunchGate('/app-lock');
          router.replace('/app-lock' as any);
        } else {
          settleLaunchGate(true);
          setLaunchGate('allow');
        }
      })
      .catch(() => {
        if (!live) return;
        // The catch redirects too, so it must stash too. This branch is not
        // theoretical: a SecureStore read that throws lands here, and on some
        // Android skins that is the common cold-start failure.
        stashLaunchLink(launchHref);
        settleLaunchGate(false);
        setLaunchGate('/onboard');
        router.replace('/onboard' as any);
      });
    return () => { live = false; };
  }, [router]);

  // THE VEIL LATCHES DOWN ONCE THE REDIRECT HAS LANDED.
  //
  // `launchGate === pathname` exists to bridge the frames between the decision
  // above and its router.replace() landing, so a signed-out deep link never
  // flashes protected content. It was being re-evaluated on EVERY navigation
  // after that, and the effect above runs once per launch (deps [router]) so
  // launchGate never moves again — meaning the first step INSIDE the auth flow
  // (onboard → mpin-entry, onboard → email-verify, app-lock → chats) made the
  // two unequal and put the veil back up over a screen the user was typing
  // into. Observed on a device 2026-09-19 as a blank page with the keyboard up:
  // white in the light theme, black in dark, because the veil is colors.bg.
  //
  // Once the redirect target has been on screen, the veil's job is done for
  // this launch: the user is on an unprotected auth route and can only reach
  // protected content by authenticating. So remember that it landed.
  const [landed, setLanded] = useState(false);
  useEffect(() => {
    if (launchGate !== 'checking' && launchGate === pathname) setLanded(true);
    // The security verdict replaces onto /blocked AFTER the gate's redirect,
    // possibly before that redirect was seen here. /blocked shows no account
    // content, so it lands the veil too rather than wedging it up.
    if (launchGate !== 'checking' && pathname === '/blocked') setLanded(true);
  }, [launchGate, pathname]);
  const launchReady = launchGate === 'allow' || landed || launchGate === pathname;

  // A HELD SECURITY VERDICT OWNS THE SCREEN. Taps are already held while
  // /blocked is up (lib/pendingLink), but a deep link that expo-router opens
  // itself never passes through that gate, so it could stack a chat on top of
  // the verdict. Any route other than /blocked goes back to it — except the
  // call screens, which stay answerable as they are from the OS lock screen.
  useEffect(() => {
    if (launchGate === 'checking' || pathname === '/blocked' || !securityVerdict()) return;
    if (/^\/(incoming-call|voicecall|videocall|group-call-active)(\/|$)/.test(pathname)) return;
    router.replace('/blocked' as any);
  }, [launchGate, pathname, router]);
  useEffect(() => {
    if (launchReady) SplashScreen.hideAsync().catch(() => {});
  }, [launchReady]);

  useEffect(() => {
    // Boot timeline. These marks are what make a startup claim checkable
    // instead of asserted — read them on-device from app/perf-debug.tsx:
    //   boot_effect_start  → this effect begins
    //   db_ready           → op-sqlite open (marked in the promise below)
    //   boot_unblocked     → first render is no longer gated
    //   boot_deferred_start→ the first frame has settled; deferred work begins
    // The gap boot_effect_start → boot_unblocked is cold-start cost the user
    // actually feels; anything after boot_deferred_start is off that path.
    mark('boot_effect_start');

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
        .then(async report => {
          if (!report.clean) {
            // /blocked reads the verdict from here, not from its params, so a
            // crafted link cannot fake one (lib/securityVerdict.ts). `level`
            // matters to the copy: only a `wipe` verdict destroyed keys.
            holdSecurityVerdict(report);
            // AFTER the launch gate: its replace('/onboard' | '/app-lock') would
            // otherwise land on top of the verdict and hide it.
            await launchAllowed;
            router.replace('/blocked' as any);
          }
        })
        .catch(() => { /* fail open */ });

    }

    // Publish this device's E2EE key bundle on startup (lazy, fire-and-forget).
    getAccessToken()
      .then(tok => {
        // FIRST, and before the crypto work below: this is a network request
        // whose answer the Chats screen will block on in a few hundred ms, and
        // everything after it here is local. See lib/chatsPrefetch.ts for the
        // measurements — the request used to be dispatched at +395ms simply
        // because that is when the screen mounted.
        if (tok) primeChats();
        if (tok && E2EE_ENABLED) {
          import('../services/crypto/e2eeSession.rn').then(m => m.provisionE2EEIdentity()).catch(() => {});
        }
        // Register the native FCM token so calls ring when the app is killed.
        if (tok) registerForCalls();
      })
      .catch(() => {});

    // Nothing in this effect gates the first render.
    mark('boot_unblocked');

    // (attachTapHandler is wired below, after the call handlers are defined)
    let cleanupListeners = () => {};

    // A NOTIFICATION TAP NEVER OPENS A SCREEN OVER THE LOCK.
    //
    // These taps used to router.push() as soon as they fired, racing the
    // launch gate's replace('/app-lock' | '/onboard') on a cold start and
    // ResumeLock's push('/app-lock') on resume — a chat could land ON TOP of
    // the lock, and a cold-start push could keep the veil from ever latching
    // down. Now they wait for the gate and any resume-lock decision, and are
    // held for replay after unlock when either is locking (lib/pendingLink).
    // Call routes are deliberately NOT gated: a ring must be answerable from
    // the lock screen, as the OS full-screen call already is.
    const openHref = (href: string) => {
      void openWhenUnlocked(href, launchAllowed, () => pathRef.current,
        (h) => router.push(h as any)).catch(() => {});
    };
    const openLink = ({ pathname: path, params }: { pathname: string; params?: Record<string, string> }) =>
      openHref(hrefWithQuery(path, params));
    // Taps from notifee's background handler (lib/callBackground) — a family
    // alert pressed while the app was backgrounded, or before this mounted.
    const offDeliveredTap = onDeliveredTap(openHref);

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

    // ── Incoming-call listener (realtime) ──────────────────────────────
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
      // 'crazzychat user' looks like a REAL name, skips the lookup, and pins the
      // placeholder on screen for the whole call. That is the reported
      // "usernames not getting displayed, instead getting crazzychat user": the
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
      mark('boot_deferred_start');
      // VaultBeam: resume any relay upload interrupted by an app kill (the
      // recipient resumes symmetrically via the server bitmask).
      import('../lib/vaultBeamController').then(m => m.resumePendingSends()).catch(() => {});
      // Bound the re-derivable media cache (safe: never touches the user's library).
      import('../lib/mediaCacheGC').then(m => m.sweepMediaCache()).catch(() => {});
      // One-time: drain the legacy external media tree
      // (/Android/media/<pkg>/crazzychat) into the private sandbox, then delete
      // it. That tree is the reason media used to survive uninstall. Self-gating
      // (no-ops once complete), resumable, and never fatal — see lib/mediaMigration.
      import('../lib/mediaMigration').then(m => m.migrateLegacyMedia()).catch(() => {});
      // One-time: delete the abandoned 'vc_pending_signup' record. On old builds
      // it sat in AsyncStorage IN THE CLEAR, and it contains two account-recovery
      // answers — the credential /auth/security-questions/verify trades for a
      // session. The signup flow that wrote it is gone, so nothing will ever read
      // it again; boot is the only place left that can reach the plaintext.
      import('./(constants)/authService').then(m => m.purgeLegacyPendingSignup()).catch(() => {});
      import('../components/PdfThumbnailer').then(m => setPdfHost(() => m.PdfThumbnailerHost)).catch(() => {});
      if (Platform.OS !== 'web') {
        // Warm up the local message store after the first frame; screens that
        // need it still open it directly if the user gets there first.
        // db_open_start/db_ready are marked inside getLocalDb itself — this
        // warm-up usually observes a promise index.tsx already resolved.
        import('../lib/localDb')
          .then(m => m.getLocalDb())
          .catch((e: any) => console.warn('[db] localDb init failed:', e?.message));
        // Passive monitoring and cache maintenance have no first-frame output.
        // Their native/headless registrations remain module-scope imports above.
        import('../services/security/deviceSecurity/monitorService')
          .then(m => m.runMonitoringScan('launch')).catch(() => {});
        import('../services/security/deviceSecurity/monitorTriggers')
          .then(m => m.startSecurityMonitoring()).catch(() => {});
        import('../services/cache/cacheManager')
          .then(m => m.maybeAutoClean()).catch(() => {});
      }
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
          openLink({ pathname: '/chat', params: { id: ci.chatId } });
        } else if (ci?.action === 'open_game') {
          // VaultGames turn/invite tap. game+room are carried through so the
          // WebView opens the exact table the push was about — landing on the
          // hub instead would make the player hunt for their own game.
          openLink({ pathname: '/games', params: { game: ci.game ?? '', room: ci.room ?? '' } });
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
      if (detail?.notification?.data?.type === 'scheduled_fire') {
        import('../lib/scheduledRunner').then(m => m.runDueScheduled()).catch(() => {});
        return;
      }
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
        // A family alert tapped while the app was killed opens that circle's
        // alerts, as a foreground tap does (lib/push.ts attachTapHandler).
        // deliverTap, not openLink: the background handler may already have
        // delivered this same press, and it de-duplicates.
        else if (initial?.notification?.data?.type === 'family-alert') {
          deliverTap(hrefWithQuery('/family-alerts', { circleId: String(initial.notification.data.circleId ?? '') }));
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
        (chatId) => { openLink({ pathname: '/chat', params: { id: chatId } }); },
        onCallNotification,
        // Membership pushes: an accepted member lands in the space, an invitee
        // lands on the invitation itself — never in a chat they cannot open.
        (event, chatId) => {
          if (event === 'member_approved' && chatId) {
            openLink({ pathname: '/family', params: { groupId: chatId } });
          } else {
            openLink({ pathname: '/group-invitations' });
          }
        },
        // A games turn push: land ON the table, not on the hub. An unknown game
        // or a blank room opens the hub, which is what /games does with params
        // it does not recognise anyway.
        (game, room) => {
          openLink({ pathname: '/games', params: game && room ? { game, room } : {} });
        },
        // A family alert tapped while the app is open waits for any lock, like the rest.
        (circleId) => { openLink({ pathname: '/family-alerts', params: { circleId } }); },
      );
    }

    return () => {
      if (Platform.OS !== 'web') {
        setSecure(false).catch(() => {});
      }
      deferred.cancel();   // don't run deferred boot work after unmount
      launchIntentSub.remove();
      cleanupListeners();
      offDeliveredTap();
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
    import('../lib/scheduledRunner')
      .then(m => { m.runDueScheduled(); m.rearmAllTriggers(); })
      .catch(() => {});
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') import('../lib/scheduledRunner').then(m => m.runDueScheduled()).catch(() => {});
    });
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

  return (
    <FontReadyContext.Provider value={true}>
    <GestureHandlerRootView
      style={{ flex: 1, backgroundColor: colors.bg }}
      accessibilityElementsHidden={!launchReady}
      importantForAccessibility={launchReady ? 'auto' : 'no-hide-descendants'}
    >
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
      {/* Renders nothing. One observer for every screen, instead of a call at
          the top of 195 of them (audit F9). */}
      <UsageCounter />
      {/* Renders nothing. Relocks the app after the configured idle timeout
          when it returns from the background (services/lockService.ts). */}
      <ResumeLock />
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
        <Stack.Screen name="media-viewer" />
        <Stack.Screen name="whiteboard" />
        <Stack.Screen name="bookmarks" />
        {/* NOT declared here: `emergency-sos` is already registered by the
            INSET_SCREENS map above. A SECOND <Stack.Screen> with the same name
            throws "Screen names must be unique" out of expo-router's
            withLayoutContext on every non-production build, and in production
            silently logs `No route named "emergency-sos" exists` because the
            first declaration has already consumed the route. */}
        <Stack.Screen name="receipt-control" />
        <Stack.Screen name="chat-themes" />
        <Stack.Screen name="chat-wallpaper" />
        <Stack.Screen name="chat-export" />
        <Stack.Screen name="in-chat-search" />
        <Stack.Screen name="message-reminder" />
        <Stack.Screen name="contact-info" />
        <Stack.Screen name="create-poll" />
        <Stack.Screen name="schedule-message" />
        <Stack.Screen name="broadcast" />
        <Stack.Screen name="media-gallery" />
        <Stack.Screen name="invite-link" />
        <Stack.Screen name="trusted-contacts" />
        <Stack.Screen name="login-history" />
        <Stack.Screen name="hidden-chats" />
        <Stack.Screen name="camera" options={{ headerShown: false, presentation: 'modal' }} />
        {/* status, calls now in (tabs) */}
        <Stack.Screen name="vault" />
        {/* alerts, profile now in (tabs) */}

        {/* Features */}
        <Stack.Screen name="contacts" />
        <Stack.Screen name="vault-features" />
        <Stack.Screen name="dashboard" />
        {/* The settings screen is NOT declared here — INSET_SCREENS above
            already registers it, and that is the declaration carrying the
            status-bar padding it needs. It was declared in both places, which
            made expo-router throw "Screen names must be unique" out of
            useFilterScreenChildren. That error is FATAL: the app rendered a
            red error screen instead of booting, on every route. A bare second
            declaration adds nothing the map has not already done. */}
        <Stack.Screen name="story-viewer" />
        <Stack.Screen name="finance" options={{ headerShown: false }} />
        <Stack.Screen name="group-admin" />
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
        <Stack.Screen name="group-calls" />
        <Stack.Screen name="group-info" />

        {/* Security & Privacy */}
        <Stack.Screen name="ghost-mode" />
        <Stack.Screen name="chat-code" />
        <Stack.Screen name="restore-backup" options={{ gestureEnabled: false }} />
        <Stack.Screen name="delete-account" />
        <Stack.Screen name="aiguardian" />
        <Stack.Screen name="backup-pin" />
        <Stack.Screen name="permissions" />

        {/* Social & Contacts */}
        <Stack.Screen name="communities" />
        <Stack.Screen name="create-group" />

        {/* Utility */}
        <Stack.Screen name="search" />
        <Stack.Screen name="scheduled" />
        <Stack.Screen name="perf-debug" />
        <Stack.Screen name="docscanner" />
        <Stack.Screen name="notifications" />
        <Stack.Screen name="location" />

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
      {PdfHost ? <PdfHost /> : null}
      {!launchReady && (
        <View
          style={{
            position: 'absolute', top: 0, right: 0, bottom: 0, left: 0,
            zIndex: 100000, backgroundColor: colors.bg,
          }}
        />
      )}
    </GestureHandlerRootView>
    </FontReadyContext.Provider>
  );
}

// Sentry.wrap forwards refs + injects a top-level error boundary that
// reports to Sentry before re-throwing. No-op when Sentry isn't init'd.
function RootLayout() {
  // Our own boundary at the root, so a render crash shows a recoverable screen
  // even in builds without a Sentry DSN (Sentry.wrap below only runs with one).
  // It depends on no provider, so it sits outside them all.
  return (
    <ErrorBoundary screen="root">
      <VisionComfortProvider>
        <ThemeProvider>
          <RootLayoutInner />
        </ThemeProvider>
      </VisionComfortProvider>
    </ErrorBoundary>
  );
}

export default SENTRY_DSN ? Sentry.wrap(RootLayout) : RootLayout;
