// app/_layout.tsx
// Root layout — runs on every app open
//
// Order of operations:
//   1. Buffer polyfill (crypto needs this)
//   2. Block screenshots app-wide (FLAG_SECURE)
//   3. Security scan — jailbreak / Frida / root
//      → if threat found → /blocked (keys already wiped)
//   4. Register push notifications (physical device only)
//   5. Wire notification tap listeners → navigate to correct chat
//   6. Handle notification that launched app from killed state

import { Buffer } from 'buffer';
global.Buffer = Buffer;

import { Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import * as ScreenCapture from 'expo-screen-capture';
import { StatusBar } from 'expo-status-bar';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import auth from '@react-native-firebase/auth';

import { runSecurityCheck } from '../services/securityService';
import { recordLogin } from '../lib/loginTracker';
import {
  registerForPushNotifications,
  setupNotificationListeners,
  handleInitialNotification,
} from '../services/notificationService';

export default function RootLayout() {
  const router = useRouter();
  const [securityChecked, setSecurityChecked] = useState(false);

  useEffect(() => {
    // ── 1. Block screenshots app-wide ─────────────────────────
    ScreenCapture.preventScreenCaptureAsync();

    // ── 2. Run security scan BEFORE showing any screen ─────────
    const runStartup = async () => {
      try {
        const report = await runSecurityCheck();

        if (!report.clean) {
          // Keys already wiped inside runSecurityCheck()
          // Navigate to blocked screen — user cannot dismiss it
          router.replace({
            pathname: '/blocked',
            params: { threats: JSON.stringify(report.threats) },
          });
          return; // Don't proceed with push registration
        }
      } catch (e) {
        // Security check error — fail open (log but don't block)
        console.warn('[Layout] Security check error:', e);
      } finally {
        setSecurityChecked(true);
      }

      // ── 3. Register push notifications (after security cleared) ──
      // Only register if user is already logged in
      // For new users, registerForPushNotifications() is called
      // from otp.tsx after successful OTP confirm
      const uid = auth().currentUser?.uid;
      if (uid) {
        recordLogin(uid).catch(() => {});
        registerForPushNotifications().catch(e =>
          console.warn('[Layout] Push registration failed:', e)
        );
      }

      // ── 4. Handle notification that opened app from killed state ──
      handleInitialNotification(router).catch(() => {});
    };

    runStartup();

    // ── 5. Wire notification tap listeners ────────────────────────
    // Returns a cleanup function
    const cleanupListeners = setupNotificationListeners(router);

    return () => {
      ScreenCapture.allowScreenCaptureAsync();
      cleanupListeners();
    };
  }, []);

  // Show spinner while security check runs
  // Prevents any screen flashing before check completes
  if (!securityChecked) {
    return (
      <View style={styles.loading}>
        <StatusBar style="light" backgroundColor="#0A0E1A" />
        <ActivityIndicator size="large" color="#00D4AA" />
      </View>
    );
  }

  return (
    <>
      <StatusBar style="light" backgroundColor="#0A0E1A" />
      <Stack screenOptions={{ headerShown: false }}>

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
        <Stack.Screen name="facescan" />
        <Stack.Screen name="biometric-setup" />
        <Stack.Screen name="three-factor-verify" options={{ gestureEnabled: false }} />

        {/* Main app */}
        <Stack.Screen name="chats" />
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
        <Stack.Screen name="status" />
        <Stack.Screen name="calls" />
        <Stack.Screen name="vault" />
        <Stack.Screen name="vaultdrop" />
        <Stack.Screen name="alerts" />
        <Stack.Screen name="profile" />

        {/* Features */}
        <Stack.Screen name="d2de-status" />
        <Stack.Screen name="contacts" />
        <Stack.Screen name="location-sharing" />
        <Stack.Screen name="dark-web-guard" />
        <Stack.Screen name="vault-features" />
        <Stack.Screen name="dashboard" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="breachguard" />
        <Stack.Screen name="deepfake" />
        <Stack.Screen name="trustscore" />
        <Stack.Screen name="vault-id" />
        <Stack.Screen name="meeting-scheduler" />
        <Stack.Screen name="three-factor-verify" />
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
        <Stack.Screen name="in-chat-search" />
        <Stack.Screen name="message-reminder" />
        <Stack.Screen name="contact-info" />
        <Stack.Screen name="chat-wallpaper" />
        <Stack.Screen name="voice-speed" />
        <Stack.Screen name="video-notes" />
        <Stack.Screen name="slideshow" />
        <Stack.Screen name="group-calls" />
      </Stack>
    </>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    backgroundColor: '#0A0E1A',
    justifyContent: 'center',
    alignItems: 'center',
  },
});
