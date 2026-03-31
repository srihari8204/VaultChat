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

import { Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import * as ScreenCapture from 'expo-screen-capture';
import { StatusBar } from 'expo-status-bar';
import { View, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import auth from '@react-native-firebase/auth';

import { runSecurityCheck } from '../services/securityService';
import { recordLogin } from '../lib/loginTracker';
import {
  registerForPushNotifications,
  setupNotificationListeners,
  handleInitialNotification,
} from '../services/notificationService';
global.Buffer = Buffer;

export default function RootLayout() {
  const router = useRouter();
  const [securityChecked, setSecurityChecked] = useState(false);

  useEffect(() => {
    // ── 1. Block screenshots app-wide (native only) ──────────
    if (Platform.OS !== 'web') {
      ScreenCapture.preventScreenCaptureAsync().catch(() => {});
    }

    // ── 2. Run security scan BEFORE showing any screen ─────────
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

      setSecurityChecked(true);

      // ── 3. Register push notifications (after security cleared) ──
      if (Platform.OS !== 'web') {
        const uid = auth().currentUser?.uid;
        if (uid) {
          recordLogin(uid).catch(() => {});
          registerForPushNotifications().catch(() => {});
        }

        // ── 4. Handle notification that opened app from killed state ──
        handleInitialNotification(router).catch(() => {});
      } else {
        // Web: just mark ready
      }
    };

    runStartup();

    // ── 5. Wire notification tap listeners (native only) ─────
    let cleanupListeners = () => {};
    if (Platform.OS !== 'web') {
      cleanupListeners = setupNotificationListeners(router);
    }

    return () => {
      if (Platform.OS !== 'web') {
        ScreenCapture.allowScreenCaptureAsync().catch(() => {});
      }
      cleanupListeners();
    };
  }, [router]);

  // Show spinner while security check runs
  // Prevents any screen flashing before check completes
  if (!securityChecked) {
    return (
      <View style={styles.loading}>
        <StatusBar style="dark" backgroundColor="#FFFFFF" />
        <ActivityIndicator size="large" color="#4A9FFF" />
      </View>
    );
  }

  return (
    <>
      <StatusBar style="dark" backgroundColor="#FFFFFF" />
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
      </Stack>
    </>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
    alignItems: 'center',
  },
});
