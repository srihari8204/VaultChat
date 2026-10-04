// app/emergency-sos.tsx — Emergency SOS
// Big red SOS button, shake detection, GPS alert to trusted contacts
// Countdown before sending, test mode, history
// Uses expo-location, expo-sensors (Accelerometer)

import { Ionicons } from '@expo/vector-icons';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView,
  Alert, ActivityIndicator, Vibration, Platform,
  Animated, Easing, AccessibilityInfo,
} from 'react-native';
import { useTheme } from '../lib/theme';
import { useRouter, Stack, useFocusEffect } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import * as Location from 'expo-location';
import { Accelerometer } from 'expo-sensors';
import { listTrustedContacts, sendSOS, listSOSHistory, type SOSHistoryItem } from '../lib/chatService';
import { AuroraBackground } from '../components/ui';
import SosContacts, { type SosContact } from '../components/sos/SosContacts';
import SosHistory from '../components/sos/SosHistory';
import { useSosStyles } from '../components/sos/sosStyles';
import { useReducedMotion } from '../lib/useReducedMotion';
import { SOS_BUTTON } from '../constants/sosPalette';
// Shared with app/notifications.tsx, so both SOS screens word a result the same way.
import { sosCountdownAnnouncement, sosReachedOf, sosSentAnnouncement, sosSentLine } from '../lib/sosReachCopy';

/**
 * Best-effort position for an SOS. NEVER throws, NEVER blocks the send.
 *
 * Both trigger paths had the same three bugs (2026-09-17):
 *  - getCurrentPositionAsync() sat INSIDE the caller's try, alongside sendSOS.
 *    A rejected GPS call — an indoor timeout is enough — skipped sendSOS
 *    ENTIRELY and showed "Failed to send SOS". An emergency in a basement sent
 *    NOTHING. That is strictly worse than sending without coordinates, and the
 *    button path's comment claimed the opposite.
 *  - the OS's cached fix was ignored, though a ten-minute-old position beats
 *    none. getLastKnownPositionAsync reads that cache with no GPS fix and no
 *    power cost; family-map.tsx and navigate.tsx already use it.
 *  - a high-accuracy fix can take tens of seconds, which is not a wait an
 *    emergency can afford.
 *
 * A null result is a legitimate answer — sendSOS takes `number | null` — and the
 * caller tells the sender their location did not go.
 *
 * ponytail: 6s is a hand-set ceiling, not a measurement. Tune on-device.
 */
const FIX_TIMEOUT_MS = 6000;
async function sosFix(): Promise<{ lat: number | null; lng: number | null }> {
  const none = { lat: null, lng: null };
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return none;
    const live = Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    const loc =
      (await Promise.race([live, new Promise<null>((r) => setTimeout(() => r(null), FIX_TIMEOUT_MS))]).catch(() => null))
      ?? (await Location.getLastKnownPositionAsync().catch(() => null));
    return loc ? { lat: loc.coords.latitude, lng: loc.coords.longitude } : none;
  } catch { return none; }
}

export default function EmergencySOSScreen() {
  const { colors } = useTheme();
  const styles = useSosStyles();
  const router = useRouter();

  // State
  const [trustedContacts, setTrustedContacts] = useState<SosContact[]>([]);
  const [selectedContacts, setSelectedContacts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  // A failed load is NOT "no contacts": in an emergency that copy sends the
  // user off to set contacts up instead of retrying. Kept separate on purpose.
  const [loadError, setLoadError] = useState(false);
  // Whether the list has loaded at least once. Until it has, the client knows
  // nothing about who the contacts are, so an SOS goes to ALL of them (the
  // server's default when no subset is sent) instead of being blocked.
  const [everLoaded, setEverLoaded] = useState(false);
  /** Contacts seen by the last successful load, to tell new ones from deselected ones. */
  const knownIds = useRef<Set<string>>(new Set());
  /** The server's own count of contacts it pushed to — not our selection size. */
  const [notified, setNotified] = useState<number | null>(null);
  /** How many of them the push provider accepted it for; null = server doesn't say. */
  const [reached, setReached] = useState<number | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  // An SOS that went without coordinates is still worth sending — but the
  // sender has to know, because the whole point of the alert is "come find me".
  const [sentNoLoc, setSentNoLoc] = useState(false);
  const [testMode, setTestMode] = useState(false);
  /** Recipients fixed at countdown start: undefined = all trusted contacts. */
  const [sendTo, setSendTo] = useState<string[] | undefined>(undefined);
  const [history, setHistory] = useState<SOSHistoryItem[]>([]);
  /** History could not be read: not the same as "No SOS activations yet". */
  const [historyFailed, setHistoryFailed] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [shakeEnabled, setShakeEnabled] = useState(true);

  // Animations
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const reduceMotion = useReducedMotion();
  const shakeRef = useRef({ count: 0, lastShake: 0 });
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  // P1.4 (leak fix): the countdown interval was only cleared on natural
  // completion or explicit cancel. Unmounting mid-countdown left it firing
  // setCountdown() on an unmounted screen. Clear it on unmount unconditionally.
  useEffect(() => () => {
    if (countdownTimer.current) { clearInterval(countdownTimer.current); countdownTimer.current = null; }
  }, []);

  // Pulse animation for SOS button
  // Reduce Motion: the button stays still at rest size; nothing else changes.
  useEffect(() => {
    if (reduceMotion) { pulseAnim.setValue(1); return; }
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.08, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, [pulseAnim, reduceMotion]);

  // Load data
  const loadTrustedContacts = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const tc = await listTrustedContacts();
      if (!mounted.current) return;
      const contacts = tc.map(c => ({ uid: c.userId, name: c.name || 'Unknown', vaultId: c.vaultId || c.userId.slice(0, 8) }));
      setTrustedContacts(contacts);
      // Keep the user's choices across a refocus: a contact they deselected
      // stays deselected, a newly added one starts selected, a removed one goes.
      const known = knownIds.current;
      setSelectedContacts(prev => contacts.filter(c => !known.has(c.uid) || prev.includes(c.uid)).map(c => c.uid));
      knownIds.current = new Set(contacts.map(c => c.uid));
      setEverLoaded(true);
    } catch {
      if (!mounted.current) return;
      setLoadError(true);
    }
    setLoading(false);
  }, []);
  // On focus, not mount: the "Edit" link pushes /trusted-contacts, and the list
  // must reflect what the user changed there when they come back.
  useFocusEffect(useCallback(() => { loadTrustedContacts(); }, [loadTrustedContacts]));
  const loadHistory = useCallback(() => {
    setHistoryLoading(true);
    listSOSHistory()
      .then((h) => { if (mounted.current) { setHistory(h); setHistoryFailed(false); } })
      .catch(() => { if (mounted.current) setHistoryFailed(true); })
      .finally(() => { if (mounted.current) setHistoryLoading(false); });
  }, []);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  // The shake listener reads the latest state through refs, so it subscribes
  // once per focus instead of on every countdown tick, and it shares the button
  // path's startCountdown instead of keeping a second copy of it.
  const shakeGate = useRef({ busy: false, start: (_isTest: boolean) => {} });

  // Shake detection — only while this screen is focused. With /trusted-contacts
  // pushed on top, three shakes used to start a countdown nobody could see.
  useFocusEffect(useCallback(() => {
    if (!shakeEnabled || Platform.OS === 'web') return;
    const SHAKE_THRESHOLD = 1.8;
    const subscription = Accelerometer.addListener(({ x, y, z }) => {
      const magnitude = Math.sqrt(x * x + y * y + z * z);
      const now = Date.now();
      if (magnitude > SHAKE_THRESHOLD) {
        if (now - shakeRef.current.lastShake < 1000) {
          shakeRef.current.count += 1;
        } else {
          shakeRef.current.count = 1;
        }
        shakeRef.current.lastShake = now;

        if (shakeRef.current.count >= 3 && !shakeGate.current.busy) {
          shakeRef.current.count = 0;
          Vibration.vibrate([0, 200, 100, 200]);
          shakeGate.current.start(false);
        }
      }
    });
    Accelerometer.setUpdateInterval(100);
    return () => subscription.remove();
  }, [shakeEnabled]));

  const toggleContact = (uid: string) => {
    setSelectedContacts(prev =>
      prev.includes(uid) ? prev.filter(u => u !== uid) : [...prev, uid]
    );
  };

  /**
   * Who the SOS goes to: `undefined` = every trusted contact (the server's
   * default), else the selected subset. An EMPTY array must never be sent — the
   * server reads it as "no subset" and alerts everyone the user just deselected.
   */
  const recipients = (): { ids: string[] | undefined } | 'none-set-up' | 'none-selected' => {
    if (!everLoaded) return { ids: undefined };
    if (trustedContacts.length === 0) return 'none-set-up';
    const ids = selectedContacts.filter(uid => trustedContacts.some(c => c.uid === uid));
    return ids.length ? { ids } : 'none-selected';
  };
  const startCountdown = (isTest: boolean) => {
    const to = recipients();
    if (to === 'none-set-up') {
      Alert.alert('No trusted contacts', 'Add at least one trusted contact so an SOS reaches someone.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Set up', onPress: () => router.push('/trusted-contacts') },
      ]);
      return;
    }
    if (to === 'none-selected') {
      Alert.alert('No contacts selected', 'Select at least one trusted contact to send the SOS to.');
      return;
    }
    setSendTo(to.ids);
    setTestMode(isTest);
    setCountdown(5);
    setSent(false);
    // The number's live region is Android-only: VoiceOver heard nothing for
    // 5 s and was never told about Cancel. The start is announced on both
    // platforms; each later second on iOS only (TalkBack has the live region).
    AccessibilityInfo.announceForAccessibility(sosCountdownAnnouncement(isTest, 5, true));

    let count = 5;
    countdownTimer.current = setInterval(() => {
      count -= 1;
      if (count <= 0) {
        clearInterval(countdownTimer.current);
        setCountdown(null);
        triggerSOS(isTest, to.ids);
      } else {
        setCountdown(count);
        Vibration.vibrate(100);
        if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(sosCountdownAnnouncement(isTest, count, false));
      }
    }, 1000);
  };

  const cancelCountdown = () => {
    if (countdownTimer.current) {
      clearInterval(countdownTimer.current);
      countdownTimer.current = null;
    }
    setCountdown(null);
  };

  // The Sending and Sent faces replace the countdown with no live region, so
  // both are announced: a screen-reader user must hear the SOS result.
  const triggerSOS = async (isTest: boolean, contactIds: string[] | undefined) => {
    setSending(true);
    AccessibilityInfo.announceForAccessibility(isTest ? 'Sending test SOS.' : 'Sending SOS.');
    try {
      // Location is genuinely best-effort now — sosFix cannot throw, so a failed
      // or slow fix can no longer take the SOS down with it.
      const { lat, lng } = await sosFix();

      // Dispatch via backend — pushes to the selected trusted contacts, or to
      // all of them when the list never loaded (contactIds undefined).
      const res = await sendSOS(lat, lng, isTest, contactIds);
      // The SOS went out; only this screen's display is skipped if it closed.
      if (!mounted.current) return;

      const n = typeof res?.contactsNotified === 'number' ? res.contactsNotified : null;
      const r = sosReachedOf(res);
      setNotified(n);
      setReached(r);
      setSent(true);
      setSentNoLoc(lat == null);
      Vibration.vibrate([0, 500, 200, 500]);
      AccessibilityInfo.announceForAccessibility(sosSentAnnouncement(isTest, n, r, lat == null));
      loadHistory();
    } catch {
      // A failed SOS offers the retry right here (same recipients) instead of
      // sending the person back through the 5 s countdown.
      if (mounted.current) setSending(false);
      Alert.alert(isTest ? 'Test SOS not sent' : 'SOS not sent',
        'Check your connection and try again. If you are in danger, call your local emergency number.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Retry', onPress: () => { triggerSOS(isTest, contactIds); } },
        ]);
      return;
    }
    if (mounted.current) setSending(false);
  };

  // Written after each commit, not during render.
  useEffect(() => {
    shakeGate.current = { busy: countdown !== null || sending || sent, start: startCountdown };
  });

  // The last send's result, in the wording app/notifications.tsx uses too.
  const reach = sosSentLine(notified, reached);

  return (
    <View style={styles.container}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} hitSlop={8} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={20} color={colors.accent} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} accessibilityRole="header">Emergency SOS</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>

        {/* SOS Button */}
        <View style={styles.sosSection}>
          {countdown !== null ? (
            // Countdown state
            <View style={styles.countdownContainer}>
              <Text style={styles.countdownLabel}>{testMode ? 'TEST ' : ''}SOS in</Text>
              <Text
                style={styles.countdownNumber}
                accessibilityLiveRegion="assertive"
                accessibilityLabel={`${testMode ? 'Test ' : ''}SOS sends in ${countdown} seconds`}
              >{countdown}</Text>
              <Text style={styles.countdownTo}>
                {sendTo === undefined
                  ? 'To all your trusted contacts'
                  : `To ${sendTo.length} trusted contact${sendTo.length === 1 ? '' : 's'}`}
              </Text>
              <TouchableOpacity
                onPress={cancelCountdown}
                style={styles.cancelBtn}
                accessibilityRole="button"
                accessibilityLabel="Cancel SOS"
              >
                <Text style={styles.cancelBtnText}>CANCEL</Text>
              </TouchableOpacity>
            </View>
          ) : sending ? (
            // Sending state
            <View style={styles.sendingContainer}>
              <ActivityIndicator size="large" color={colors.danger} />
              <Text style={styles.sendingText}>Sending SOS...</Text>
            </View>
          ) : sent ? (
            // Sent state
            <View style={styles.sentContainer}>
              <Text style={styles.sentCheck} accessibilityElementsHidden importantForAccessibility="no">✓</Text>
              <Text style={styles.sentText}>{testMode ? 'Test SOS Sent' : 'SOS Sent!'}</Text>
              {/* contactsNotified is who the alert was ADDRESSED to; contactsReached
                  (when the server sends it) is who the push provider accepted it
                  for — still not proof a phone showed it, so "reached", not "saw". */}
              <Text style={styles.sentSub}>{reach.line}</Text>
              {!!reach.warn && <Text style={styles.sentWarn}>{reach.warn}</Text>}
              {sentNoLoc && (
                <Text style={styles.sentWarn}>
                  Sent without your location — turn on location access so your contacts can find you.
                </Text>
              )}
              <TouchableOpacity onPress={() => setSent(false)} style={styles.resetBtn} accessibilityRole="button">
                <Text style={styles.resetBtnText}>OK</Text>
              </TouchableOpacity>
            </View>
          ) : (
            // Default state — big SOS button
            <>
              <Text style={styles.sosHint}>Press and hold or shake 3 times</Text>
              <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
                <TouchableOpacity
                  onLongPress={() => startCountdown(false)}
                  delayLongPress={500}
                  style={styles.sosButton}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel="Send emergency SOS"
                  accessibilityHint="Double-tap and hold to start a 5 second countdown"
                  // A screen-reader user may not be able to perform a hold:
                  // the activate/longpress actions start the same countdown.
                  accessibilityActions={[{ name: 'activate' }, { name: 'longpress' }]}
                  onAccessibilityAction={(e) => {
                    const n = e.nativeEvent.actionName;
                    if (n === 'activate' || n === 'longpress') startCountdown(false);
                  }}
                >
                  <LinearGradient colors={SOS_BUTTON.gradient} style={styles.sosGradient}>
                    <Text style={styles.sosText}>SOS</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </Animated.View>
              <TouchableOpacity onPress={() => startCountdown(true)} style={styles.testBtn} accessibilityRole="button">
                <Text style={styles.testBtnText}>Send Test SOS</Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* Shake detection toggle */}
        <View style={styles.shakeRow}>
          <View style={{ flex: 1, marginRight: 12 }}>
            <Text style={styles.shakeTitle}>Shake Detection</Text>
            <Text style={styles.shakeSub}>Shake 3 times to trigger SOS while this screen is open. Turns back on each visit.</Text>
          </View>
          <TouchableOpacity
            style={[styles.toggleBtn, shakeEnabled && styles.toggleBtnActive]}
            onPress={() => setShakeEnabled(!shakeEnabled)}
            accessibilityRole="switch"
            accessibilityLabel="Shake detection"
            accessibilityState={{ checked: shakeEnabled }}
          >
            <Text style={[styles.toggleText, shakeEnabled && styles.toggleTextActive]}>
              {shakeEnabled ? 'ON' : 'OFF'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Trusted Contacts for SOS */}
        <SosContacts
          contacts={trustedContacts} selected={selectedContacts} onToggle={toggleContact}
          locked={countdown !== null || sending} loading={loading} everLoaded={everLoaded}
          loadError={loadError} onRetry={loadTrustedContacts}
        />

        {/* SOS History */}
        <SosHistory history={history} failed={historyFailed} loading={historyLoading} onRetry={loadHistory} />

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}
