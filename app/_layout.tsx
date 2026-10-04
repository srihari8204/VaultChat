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
//
// Steps 4–7 run in components/root/useBootSequence, with call routing, launch
// intents, the inbound-message ingest, foreground upkeep, the verdict guard and
// the route declarations beside it. The launch gate and the veil stay here.
// Selftests that pin this code read the whole list in scripts/rootLayoutSources.ts.

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
import { useEffect, useRef, useState } from 'react';
import { setSecure } from '../lib/screenGuard';
import { installAlertGuard } from '../lib/alertGuard';
import { loadRemoteFlags } from '../lib/remoteFlags';
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
import { Platform, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { CallBar } from '../components/CallBar';
import { UpdateGate } from '../components/UpdateGate';
import { TermsGate } from '../components/TermsGate';
import { enableFreeze } from 'react-native-screens';
import { FontReadyContext } from '../components/ui/Text';
import { ThemeProvider, useTheme } from '../lib/theme';
import { VisionComfortProvider } from '../lib/visionComfort';

// The root's boot pieces, split out of this file (components/root/).
import { useBootSequence } from '../components/root/useBootSequence';
import { useCallRegistrationRefresh, useScheduledMessages } from '../components/root/useForegroundUpkeep';
import { useVerdictGuard } from '../components/root/useVerdictGuard';
import { ROOT_SCREENS } from '../components/root/rootScreens';
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
import { getLaunchSessionState } from '../lib/api';
import { beginLaunchGate, settleLaunchGate } from '../lib/launchGate';
import { hrefWithQuery, noteAuthEdge, stashLaunchLink } from '../lib/pendingLink';
import { isMfaEnabled } from '../lib/mfa';
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
  const router = useRouter();
  const pathname = usePathname();
  // The launch URL WITH its query: usePathname() drops `?code=` and the like,
  // and a stashed link must replay exactly as it was tapped.
  const globalParams = useGlobalSearchParams();
  const segments = useSegments();
  // Through a ref: the gate effect below runs once per launch (deps [router])
  // and must stash the href of the render it ran after, which is the launch's.
  const launchHrefRef = useRef('');
  launchHrefRef.current = hrefWithQuery(pathname, globalParams, segments);
  /** Current route for the notification-tap gate; the boot sequence (components/root/useBootSequence) outlives renders. */
  const pathRef = useRef(pathname);
  pathRef.current = pathname;
  const [launchGate, setLaunchGate] = useState<'checking' | 'allow' | '/onboard' | '/app-lock'>('checking');
  // Each mount re-decides below, so each mount re-arms the decision that
  // app/index.tsx waits on — in this first render, before any child renders
  // (lib/launchGate "Per root mount").
  useState(beginLaunchGate);

  // The root owns authentication because an initial deep link bypasses `/` and
  // never mounts index.tsx. Keep an opaque veil over the navigator until both
  // the session decision and Android FLAG_SECURE are ready. Authorized links
  // are left untouched; only signed-out/locked launches are redirected.
  useEffect(() => {
    let live = true;
    const launchHref = launchHrefRef.current;
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
          noteAuthEdge('/onboard');
          settleLaunchGate(false);
          setLaunchGate('/onboard');
          router.replace('/onboard');
        } else if (mfaOn || session.sealedLocked) {
          stashLaunchLink(launchHref);
          noteAuthEdge('/app-lock');
          settleLaunchGate(false);
          setLaunchGate('/app-lock');
          router.replace('/app-lock');
        } else {
          noteAuthEdge(null);
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
        noteAuthEdge('/onboard');
        settleLaunchGate(false);
        setLaunchGate('/onboard');
        router.replace('/onboard');
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
  // (onboard → mpin-entry, onboard → phone-verify, app-lock → chats) made the
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

  // A held security verdict owns the screen (components/root/useVerdictGuard).
  useVerdictGuard(launchGate, pathname, router);
  useEffect(() => {
    if (launchReady) SplashScreen.hideAsync().catch(() => {});
  }, [launchReady]);

  // The boot sequence: socket warm-up, the background security scan, sync and
  // outbox drains, deferred maintenance, and notification / call-intent routing
  // (components/root/useBootSequence). Once per mount, after the first render.
  const PdfHost = useBootSequence(router, pathRef);

  useScheduledMessages();
  useCallRegistrationRefresh();

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

        {/* Every other route declaration, in order (components/root/rootScreens). */}
        {ROOT_SCREENS}
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
