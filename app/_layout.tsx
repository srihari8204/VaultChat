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

import { Buffer } from 'buffer';

import { Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import * as ScreenCapture from 'expo-screen-capture';
import * as Sentry from '@sentry/react-native';
import { StatusBar } from 'expo-status-bar';
import { View, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useFonts, Sora_700Bold, Sora_800ExtraBold } from '@expo-google-fonts/sora';
import { NunitoSans_400Regular, NunitoSans_600SemiBold, NunitoSans_700Bold } from '@expo-google-fonts/nunito-sans';
import { FontReadyContext } from '../components/ui/Text';
import { ThemeProvider } from '../lib/theme';

import { runSecurityCheck } from '../services/securityService';
import { attachTapHandler } from '../lib/push';
import { getSocket } from '../lib/socket';
import { getAccessToken } from '../lib/api';
import { E2EE_ENABLED } from '../constants/flags';
global.Buffer = Buffer;

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
    // ── 1. Block screenshots app-wide (native only) ──────────
    if (Platform.OS !== 'web') {
      ScreenCapture.preventScreenCaptureAsync().catch(() => {});
    }

    // ── 2. Configure Google Sign-In ────────────────────────────
    try {
      const { configureGoogleSignIn } = require('./(constants)/authService');
      configureGoogleSignIn();
    } catch {}

    // ── 3. Run security scan BEFORE showing any screen ─────────
    const runStartup = async () => {
      // Skip security checks on web — they require native APIs
      if (Platform.OS !== 'web') {
        try {
          const report = await runSecurityCheck();

          if (!report.clean) {
            router.replace({
              pathname: '/blocked',
              params: { threats: JSON.stringify(report.threats) },
            });
            return;
          }
        } catch {
          // Security check error — fail open
        }
      }

      // The cold-start launch gate now lives in app/index.tsx: a signed-in user
      // with device MFA enabled is routed to /app-lock (biometric or MPIN); the
      // old per-launch PIN gate (/enter-mpin) is retired with the legacy auth flow.
      try {
        const tok = await getAccessToken();
        // Publish this device's E2EE key bundle on startup so peers can open
        // encrypted sessions with us immediately. Gated + lazy + fire-and-forget.
        if (tok && E2EE_ENABLED) {
          import('../services/crypto/e2eeSession.rn')
            .then(m => m.provisionE2EEIdentity())
            .catch(() => {});
        }
      } catch { /* don't block startup on an unexpected error */ }

      setSecurityChecked(true);
      // Push token registration happens on the chats-screen mount
      // (lib/push.ts:registerPushToken) — needs a valid JWT, which we
      // only have after sign-in.
    };

    runStartup();

    // ── Notification tap → open the chat. Survives across screens. ──
    let cleanupListeners = () => {};
    if (Platform.OS !== 'web') {
      cleanupListeners = attachTapHandler((chatId) => {
        router.push({ pathname: '/chat', params: { id: chatId } } as any);
      });
    }

    // ── Incoming-call listener (Socket.IO). Pushes to the full-screen
    //    accept/decline overlay while the app is open. (When the app is
    //    closed, the existing push-notification arrives and tapping it
    //    opens the chat — full lock-screen call UI is a Phase-7 polish
    //    that needs a Notifee high-importance fullscreen intent.)
    let cleanupCallListener: () => void = () => {};
    (async () => {
      try {
        const s = await getSocket();
        const onIncoming = (data: any) => {
          if (!data?.from || !data?.chatId) return;
          router.push({
            pathname: '/incoming-call' as any,
            params: {
              chatId:   data.chatId,
              peerUid:  data.from,
              peerName: data.callerName ?? 'VaultChat user',
              type:     data.type === 'video' ? 'video' : 'audio',
              offer:    data.offer ? JSON.stringify(data.offer) : '',
            },
          });
        };
        s.on('call_incoming', onIncoming);
        cleanupCallListener = () => { try { s.off('call_incoming', onIncoming); } catch {} };
      } catch { /* not signed-in yet — listener will arm when chats mounts */ }
    })();

    return () => {
      if (Platform.OS !== 'web') {
        ScreenCapture.allowScreenCaptureAsync().catch(() => {});
      }
      cleanupListeners();
      cleanupCallListener();
    };
  }, [router]);

  // Show spinner while security check runs
  // Prevents any screen flashing before check completes
  if (!securityChecked) {
    return (
      <GestureHandlerRootView style={styles.loading}>
        <StatusBar style="light" />
        <ActivityIndicator size="large" color="#10B981" />
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
        <Stack.Screen name="split-key-backup" options={{ headerShown: false }} />
        <Stack.Screen name="file-preview" />
        <Stack.Screen name="vaultbeam" />
        <Stack.Screen name="transfers" />
        <Stack.Screen name="voice-transcribe" />
        <Stack.Screen name="tone-detector" />
        <Stack.Screen name="group-chat" />
        <Stack.Screen name="lock" />
        <Stack.Screen name="ai-assistant" />
        <Stack.Screen name="ai-chat-bot" />
        <Stack.Screen name="chat-summary" />
        <Stack.Screen name="translate" />
        <Stack.Screen name="media-viewer" />
        <Stack.Screen name="whiteboard" />
        <Stack.Screen name="bookmarks" />
        <Stack.Screen name="receipt-control" />
        <Stack.Screen name="voice-effects" />
        <Stack.Screen name="auto-reply" />
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
        <Stack.Screen name="dark-web-guard" />
        <Stack.Screen name="vault-features" />
        <Stack.Screen name="dashboard" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="story-viewer" />
        <Stack.Screen name="breachguard" />
        <Stack.Screen name="trustscore" />
        <Stack.Screen name="meeting-scheduler" />
        <Stack.Screen name="three-factor-verify" options={{ gestureEnabled: false }} />
        <Stack.Screen name="decentralized-id" />
        <Stack.Screen name="bot-api" />
        <Stack.Screen name="mini-apps" />
        <Stack.Screen name="email-bridge" />
        <Stack.Screen name="creator-channels" />
        <Stack.Screen name="group-admin" />
        <Stack.Screen name="call-recording" />
        <Stack.Screen name="app-lock-chats" />
        <Stack.Screen name="privacy-dashboard" />
        <Stack.Screen name="storage-manager" />
        <Stack.Screen name="chat-backup" />
        <Stack.Screen name="last-seen-privacy" />
        <Stack.Screen name="offline-mode" />
        <Stack.Screen name="image-editor" />
        <Stack.Screen name="emergency-sos" />
        <Stack.Screen name="network-test" />
        <Stack.Screen name="file-viewer" />
        <Stack.Screen name="video-player" />
        <Stack.Screen name="voice-speed" />
        <Stack.Screen name="video-notes" />
        <Stack.Screen name="slideshow" />
        <Stack.Screen name="group-calls" />
        <Stack.Screen name="group-info" />

        {/* Auth extras */}
        <Stack.Screen name="setup-complete" />
        <Stack.Screen name="face-verify-new-device" />
        <Stack.Screen name="secret-code" />

        {/* Security & Privacy */}
        <Stack.Screen name="ghost-mode" />
        <Stack.Screen name="aiguardian" />
        <Stack.Screen name="backup-pin" />
        <Stack.Screen name="behavioral" />
        <Stack.Screen name="duresspin" />
        <Stack.Screen name="stealth" />
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
        <Stack.Screen name="starred" />
        <Stack.Screen name="scheduled" />
        <Stack.Screen name="scanner" />
        <Stack.Screen name="docscanner" />
        <Stack.Screen name="notifications" />
        <Stack.Screen name="location" />
        <Stack.Screen name="filevault" />
        <Stack.Screen name="vaultid" />
        <Stack.Screen name="testconsole" />

        {/* Mini Apps destinations */}
        <Stack.Screen name="encrypted-notes" />
        <Stack.Screen name="screen-share" />
        <Stack.Screen name="current-location" />
        <Stack.Screen name="game-lobby" />
        <Stack.Screen name="game-play" />
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
