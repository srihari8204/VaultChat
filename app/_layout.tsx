// app/_layout.tsx
// Root layout — runs on every app open
//
// Order of operations:
//   1. Buffer polyfill (crypto needs this)
//   2. Sentry init — must happen BEFORE any other code that might throw
//   3. Block screenshots app-wide (FLAG_SECURE)
//   4. Security scan — jailbreak / Frida / root
//      → if threat found → /blocked (keys already wiped)
//   5. Register push notifications (physical device only)
//   6. Wire notification tap listeners → navigate to correct chat
//   7. Handle notification that launched app from killed state

import { BRAND_ACCENT } from '../constants/theme';
import { Buffer } from 'buffer';

import { Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import * as ScreenCapture from 'expo-screen-capture';
import * as SplashScreen from 'expo-splash-screen';
import * as Sentry from '@sentry/react-native';
import { StatusBar } from 'expo-status-bar';
import { View, ActivityIndicator, StyleSheet, Platform, AppState, InteractionManager } from 'react-native';
import notifee, { EventType } from '@notifee/react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useFonts, Sora_700Bold, Sora_800ExtraBold } from '@expo-google-fonts/sora';
import { NunitoSans_400Regular, NunitoSans_600SemiBold, NunitoSans_700Bold } from '@expo-google-fonts/nunito-sans';
import { FontReadyContext } from '../components/ui/Text';
import { ThemeProvider } from '../lib/theme';

import { runSecurityCheck } from '../services/securityService';
import { attachTapHandler } from '../lib/push';
import { notify as notifyMessage, setSelfId } from '../lib/messageNotifications';
import { addPersistentListener, getSocket } from '../lib/socket';
import { registerForCalls, getInitialCallIntent, drainDeclinedCall } from '../lib/CallService';
import { getActiveCall } from '../lib/callState';
import { getRingingPeer, setRingingPeer, consumePendingCall } from '../lib/ringTracker';
import { displayIncomingCall, cancelIncomingCall } from '../lib/callNotification';
import '../lib/callBackground';   // registers notifee bg event + bg notification task
import '../lib/family/background'; // registers the bg-location task — a headless OS
                                   // wake runs ONLY this layout's imports, so without
                                   // this line killed-app Family sharing drops fixes
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
  });
}

function RootLayout() {
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

    // ── 0. Warm up the op-sqlite local store (localDb, JSI engine) ──
    // The local-first source of truth for chats/messages. Guarded so a stale
    // binary without the native module can't crash launch.
    if (Platform.OS !== 'web') {
      getLocalDb()
        .then(() => perf.mark('db_ready'))
        .catch((e: any) => console.warn('[db] localDb init failed:', e?.message));
    }

    // ── 1. Block screenshots app-wide (native only) ──────────
    if (Platform.OS !== 'web') {
      ScreenCapture.preventScreenCaptureAsync().catch(() => {});
    }

    // ── 2. Configure Google Sign-In ────────────────────────────
    try {
      const { configureGoogleSignIn } = require('./(constants)/authService');
      configureGoogleSignIn();
    } catch {}

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
      cancelIncomingCall();             // clear any OS full-screen call once the in-app UI takes over
      setRingingPeer(p.peerUid);
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
      const active = getActiveCall();
      if (active && active.peerUid === data.from && !data.group) return;   // call-waiting same peer
      if (getRingingPeer() === data.from) return;                          // de-dupe repeated rings
      setRingingPeer(data.from);
      const name = data.group ? (data.groupName || 'Group call') : (data.callerName ?? data.fromName ?? 'VaultChat user');
      const type = (data.type === 'video' || data.video === '1') ? 'video' : 'audio';
      // App in the FOREGROUND (or a group call) → show the in-app screen.
      // App BACKGROUNDED with a live socket → raise the OS full-screen call UI
      // (lock screen). Answering it routes into the app via the notifee events.
      if (AppState.currentState === 'active' || data.group) {
        routeToIncoming({ chatId: data.chatId, peerUid: data.from, peerName: name, type, offer: data.offer ? JSON.stringify(data.offer) : '', group: !!data.group, groupName: data.groupName, waiting: !!active });
      } else {
        displayIncomingCall({ fromUid: data.from, callerName: name, callType: type, chatId: data.chatId });
      }
    };
    const cleanupCallListener = addPersistentListener('call_incoming', onIncoming);

    // E2EE Stage-2 auto-recovery: a peer that couldn't decrypt us asks us to
    // reset our session so our next message re-runs X3DH (persistent so it
    // survives socket reconnects, like the call listener).
    const cleanupRekey = addPersistentListener('e2ee_rekey', (data: any) => {
      const from = data?.from ?? data?.fromUid;
      if (from) import('../lib/chatService').then(m => m.handleRekeyRequest(String(from))).catch(() => {});
    });

    // ── Boot work that the user is WAITING for ─────────────────────────
    // These three decide what the first screen shows, so they start now:
    // catch-up on messages missed while offline, re-flush dropped receipts, and
    // resume interrupted media sends.
    import('../lib/syncEngine').then(m => m.initSync()).catch(() => {});
    import('../lib/receipts').then(m => m.initReceipts()).catch(() => {});
    import('../lib/mediaOutbox').then(m => m.initMediaOutbox()).catch(() => {});

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
    import('./(constants)/authService').then(m => m.getCurrentUserAsync().then((u: any) => setSelfId(u?.id ?? null))).catch(() => {});
    const cleanupMsgNotif = addPersistentListener('new_message', (m: any) => {
      notifyMessage(m).catch(() => {});
      // VaultBeam auto-download (flag-gated; no-op when off / not a vaultbeam msg).
      if (m?.meta?.vaultbeam) import('../lib/vaultBeamIngest').then(v => v.onIncomingVaultbeamMessage(m)).catch(() => {});
    });

    // ── Notifee full-screen call events (foreground) ────────────────────
    const onNotifeeAnswerOrDecline = (action: string, data: any) => {
      if (data?.type !== 'call' || !data?.fromUid) return;
      cancelIncomingCall();
      if (action === 'decline') {
        setRingingPeer(null);
        getSocket().then(s => s.emit('webrtc_end', { to: data.fromUid, chatId: data.chatId })).catch(() => {});
        return;
      }
      routeToIncoming({ chatId: data.chatId, peerUid: data.fromUid, peerName: data.callerName || 'VaultChat user', type: data.callType, offer: '' });
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
      try {
        const ci = await getInitialCallIntent();
        if (ci?.action === 'open_chat' && ci.chatId) {
          // Native message-notification tap (F2 content-free doorbell).
          router.push({ pathname: '/chat', params: { id: ci.chatId } } as any);
        } else if (ci?.callId && ci.action !== 'open_calls') {
          routeToIncoming({
            chatId: ci.callId, peerUid: ci.callerId || '', peerName: ci.callerName || 'VaultChat user',
            type: ci.isVideo ? 'video' : 'audio', offer: '',
          });
        }
      } catch {}

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
      );
    }

    return () => {
      if (Platform.OS !== 'web') {
        ScreenCapture.allowScreenCaptureAsync().catch(() => {});
      }
      deferred.cancel();   // don't run deferred boot work after unmount
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

  // Show spinner while security check runs
  // Prevents any screen flashing before check completes
  if (!securityChecked) {
    return (
      <GestureHandlerRootView style={styles.loading}>
        <StatusBar style="light" />
        <ActivityIndicator size="large" color={BRAND_ACCENT} />
      </GestureHandlerRootView>
    );
  }

  return (
    <ThemeProvider>
    <FontReadyContext.Provider value={fontsReady}>
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#0A0A0F' } }}>

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
        <Stack.Screen name="videocall" />
        <Stack.Screen name="voicecall" />
        <Stack.Screen name="qr-contact" />
        <Stack.Screen name="add/[...segments]" options={{ headerShown: false }} />
        <Stack.Screen name="file-preview" />
        <Stack.Screen name="voice-transcribe" />
        <Stack.Screen name="group-chat" />
        <Stack.Screen name="lock" />
        <Stack.Screen name="media-viewer" />
        <Stack.Screen name="whiteboard" />
        <Stack.Screen name="bookmarks" />
        <Stack.Screen name="receipt-control" />
        <Stack.Screen name="voice-effects" />
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
        <Stack.Screen name="camera" options={{ headerShown: false }} />
        {/* status, calls now in (tabs) */}
        <Stack.Screen name="vault" />
        <Stack.Screen name="vaultdrop" />
        {/* alerts, profile now in (tabs) */}

        {/* Features */}
        <Stack.Screen name="d2de-status" />
        <Stack.Screen name="contacts" />
        <Stack.Screen name="location-sharing" />
        <Stack.Screen name="vault-features" />
        <Stack.Screen name="dashboard" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="story-viewer" />
        <Stack.Screen name="meeting-scheduler" />
        <Stack.Screen name="decentralized-id" />
        <Stack.Screen name="finance" options={{ headerShown: false }} />
        <Stack.Screen name="email-bridge" />
        <Stack.Screen name="creator-channels" />
        <Stack.Screen name="group-admin" />
        <Stack.Screen name="call-recording" />
        <Stack.Screen name="app-lock-chats" />
        <Stack.Screen name="privacy-dashboard" />
        <Stack.Screen name="storage-manager" />
        <Stack.Screen name="vaultbeam-settings" />
        <Stack.Screen name="chat-backup" />
        <Stack.Screen name="last-seen-privacy" />
        <Stack.Screen name="offline-mode" />
        <Stack.Screen name="image-editor" />
        <Stack.Screen name="emergency-sos" />
        <Stack.Screen name="network-test" />
        <Stack.Screen name="file-viewer" />
        <Stack.Screen name="video-player" />
        <Stack.Screen name="voice-speed" />
        <Stack.Screen name="slideshow" />
        <Stack.Screen name="group-calls" />
        <Stack.Screen name="group-info" />

        {/* Auth extras */}
        <Stack.Screen name="setup-complete" />
        <Stack.Screen name="face-verify-new-device" />

        {/* Security & Privacy */}
        <Stack.Screen name="ghost-mode" />
        <Stack.Screen name="aiguardian" />
        <Stack.Screen name="backup-pin" />
        <Stack.Screen name="duresspin" />
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
        <Stack.Screen name="filevault" />
        <Stack.Screen name="vaultid" />

        {/* Mini Apps destinations */}
        <Stack.Screen name="encrypted-notes" />
        <Stack.Screen name="current-location" />
      </Stack>
    </GestureHandlerRootView>
    </FontReadyContext.Provider>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    backgroundColor: '#0A0A0F',
    justifyContent: 'center',
    alignItems: 'center',
  },
});

// Sentry.wrap forwards refs + injects a top-level error boundary that
// reports to Sentry before re-throwing. No-op when Sentry isn't init'd.
export default SENTRY_DSN ? Sentry.wrap(RootLayout) : RootLayout;
