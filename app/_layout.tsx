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

import { runSecurityCheck } from '../services/securityService';
import { attachTapHandler } from '../lib/push';
import { getSocket } from '../lib/socket';
import { getAccessToken } from '../lib/api';
import { hasPIN } from './(constants)/authService';
import { isUnlocked } from '../lib/sessionLock';
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

      // ── MPIN gate ──────────────────────────────────────────────
      // Signed-in users who have set an MPIN must unlock on every cold
      // start (the unlocked flag resets on full reload). Fail open on error.
      try {
        const tok = await getAccessToken();
        if (tok && !isUnlocked() && (await hasPIN())) {
          router.replace('/enter-mpin' as any);
        }
      } catch { /* don't lock users out on an unexpected error */ }

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
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#0A0A0F' } }}>

        {/* Security — gesture disabled so user can't swipe back */}
        <Stack.Screen name="blocked" options={{ gestureEnabled: false }} />

        {/* Auth flow */}
        <Stack.Screen name="index" />
        <Stack.Screen name="login" />
        <Stack.Screen name="signup" />
        <Stack.Screen name="profile-setup" />
        <Stack.Screen name="security-questions" />
        <Stack.Screen name="pinentry" />
        <Stack.Screen name="otp" />
        <Stack.Screen name="set-mpin" options={{ gestureEnabled: false }} />
        <Stack.Screen name="enter-mpin" options={{ gestureEnabled: false }} />
        <Stack.Screen name="facescan" />
        <Stack.Screen name="biometric-setup" />
        {/* Main app — 6-tab navigation */}
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="chat" />
        <Stack.Screen name="videocall" />
        <Stack.Screen name="voicecall" />
        <Stack.Screen name="qr-contact" />
        <Stack.Screen name="file-preview" />
        <Stack.Screen name="vaultbeam" />
        <Stack.Screen name="voice-transcribe" />
        <Stack.Screen name="smart-notifications" />
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
        <Stack.Screen name="deepfake" />
        <Stack.Screen name="trustscore" />
        <Stack.Screen name="vault-id" />
        <Stack.Screen name="meeting-scheduler" />
        <Stack.Screen name="three-factor-verify" options={{ gestureEnabled: false }} />
        <Stack.Screen name="zero-knowledge" />
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
        <Stack.Screen name="digital-wellbeing" />
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
        <Stack.Screen name="welcome" />
        <Stack.Screen name="phone" />
        <Stack.Screen name="register" />
        <Stack.Screen name="forgot" />
        <Stack.Screen name="recovery" />
        <Stack.Screen name="setup-complete" />
        <Stack.Screen name="face-verify" />
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
        <Stack.Screen name="family" />
        <Stack.Screen name="create-group" />

        {/* Utility */}
        <Stack.Screen name="search" />
        <Stack.Screen name="starred" />
        <Stack.Screen name="scheduled" />
        <Stack.Screen name="scanner" />
        <Stack.Screen name="docscanner" />
        <Stack.Screen name="notifications" />
        <Stack.Screen name="location" />
        <Stack.Screen name="modal" />
        <Stack.Screen name="filevault" />
        <Stack.Screen name="vaultid" />
        <Stack.Screen name="testconsole" />

        {/* Mini Apps destinations */}
        <Stack.Screen name="encrypted-notes" />
        <Stack.Screen name="watch-together" />
        <Stack.Screen name="screen-share" />
        <Stack.Screen name="current-location" />
        <Stack.Screen name="game-lobby" />
        <Stack.Screen name="game-play" />
      </Stack>
    </GestureHandlerRootView>
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
