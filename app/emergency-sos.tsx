// app/emergency-sos.tsx — Emergency SOS
// Big red SOS button, shake detection, GPS alert to trusted contacts
// Countdown before sending, test mode, history
// Uses expo-location, expo-sensors (Accelerometer)

import { Ionicons } from '@expo/vector-icons';
import { brandAlpha, type Palette } from '../constants/theme';
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  Alert, ActivityIndicator, Vibration, Platform,
  Animated, Easing,
} from 'react-native';
import { useTheme } from '../lib/theme';
import { useRouter, Stack, useFocusEffect } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import * as Location from 'expo-location';
import { Accelerometer } from 'expo-sensors';
import { listTrustedContacts, sendSOS, listSOSHistory, type SOSHistoryItem } from '../lib/chatService';
import { AuroraBackground } from '../components/ui';

type SosContact = { uid: string; name: string; vaultId: string };

function useS() {
  const { colors, scheme } = useTheme();
  return useMemo(() => makeStyles(colors, scheme === 'light'), [colors, scheme]);
}

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
  const styles = useS();
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
  const [shakeEnabled, setShakeEnabled] = useState(true);

  // Animations
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const countdownTimer = useRef<any>(null);
  const shakeRef = useRef({ count: 0, lastShake: 0 });

  // P1.4 (leak fix): the countdown interval was only cleared on natural
  // completion or explicit cancel. Unmounting mid-countdown left it firing
  // setCountdown() on an unmounted screen. Clear it on unmount unconditionally.
  useEffect(() => () => {
    if (countdownTimer.current) { clearInterval(countdownTimer.current); countdownTimer.current = null; }
  }, []);

  // Pulse animation for SOS button
  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.08, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, [pulseAnim]);

  // Load data
  const loadTrustedContacts = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const tc = await listTrustedContacts();
      const contacts = tc.map(c => ({ uid: c.userId, name: c.name || 'Unknown', vaultId: c.vaultId || c.userId.slice(0, 8) }));
      setTrustedContacts(contacts);
      // Keep the user's choices across a refocus: a contact they deselected
      // stays deselected, a newly added one starts selected, a removed one goes.
      const known = knownIds.current;
      setSelectedContacts(prev => contacts.filter(c => !known.has(c.uid) || prev.includes(c.uid)).map(c => c.uid));
      knownIds.current = new Set(contacts.map(c => c.uid));
      setEverLoaded(true);
    } catch {
      setLoadError(true);
    }
    setLoading(false);
  }, []);
  // On focus, not mount: the "Edit" link pushes /trusted-contacts, and the list
  // must reflect what the user changed there when they come back.
  useFocusEffect(useCallback(() => { loadTrustedContacts(); }, [loadTrustedContacts]));
  useEffect(() => { listSOSHistory().then(setHistory).catch(() => {}); }, []);

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

  const triggerSOS = async (isTest: boolean, contactIds: string[] | undefined) => {
    setSending(true);
    try {
      // Location is genuinely best-effort now — sosFix cannot throw, so a failed
      // or slow fix can no longer take the SOS down with it.
      const { lat, lng } = await sosFix();

      // Dispatch via backend — pushes to the selected trusted contacts, or to
      // all of them when the list never loaded (contactIds undefined).
      const res = await sendSOS(lat, lng, isTest, contactIds);

      setNotified(typeof res?.contactsNotified === 'number' ? res.contactsNotified : null);
      setSent(true);
      setSentNoLoc(lat == null);
      Vibration.vibrate([0, 500, 200, 500]);
      try { setHistory(await listSOSHistory()); } catch {}
    } catch {
      Alert.alert('Error', 'Failed to send SOS. Please try again.');
    }
    setSending(false);
  };

  shakeGate.current = { busy: countdown !== null || sending || sent, start: startCountdown };

  const formatTime = (ts: string | null | undefined) => {
    if (!ts) return 'Unknown';
    try {
      const d = new Date(ts);
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch { return 'Unknown'; }
  };

  return (
    <View style={styles.container}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={20} color={colors.accent} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Emergency SOS</Text>
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
              <Text style={styles.sentCheck}>✓</Text>
              <Text style={styles.sentText}>{testMode ? 'Test SOS Sent' : 'SOS Sent!'}</Text>
              <Text style={styles.sentSub}>
                {/* The server's count is who it is ALERTING, not who received it. */}
                {notified == null ? 'Your trusted contacts are being alerted'
                  : notified === 0 ? 'No trusted contacts to alert — add some so an SOS reaches someone.'
                    : `Alerting ${notified} trusted contact${notified === 1 ? '' : 's'}`}
              </Text>
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
                  onAccessibilityAction={() => startCountdown(false)}
                >
                  <LinearGradient colors={['#FF2D2D', '#CC0000']} style={styles.sosGradient}>
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
          <View>
            <Text style={styles.shakeTitle}>Shake Detection</Text>
            <Text style={styles.shakeSub}>Shake 3 times to trigger SOS</Text>
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
        <View style={styles.section}>
          <View style={styles.sectionHead}>
            <Text style={styles.sectionTitle}>SOS Contacts</Text>
            {trustedContacts.length > 0 && (
              <TouchableOpacity
                onPress={() => router.push('/trusted-contacts')}
                accessibilityRole="button"
                accessibilityLabel="Edit trusted contacts"
                hitSlop={12}
              >
                <Text style={styles.editLink}>Edit</Text>
              </TouchableOpacity>
            )}
          </View>
          {loading && !everLoaded ? (
            <ActivityIndicator color={colors.accent} style={{ marginTop: 16 }} />
          ) : loadError && !everLoaded ? (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyText}>
                Couldn&apos;t load your trusted contacts. Check your connection. An SOS still goes to all of them.
              </Text>
              <TouchableOpacity onPress={loadTrustedContacts} style={styles.setupBtn} accessibilityRole="button" accessibilityLabel="Retry loading trusted contacts">
                <Text style={styles.setupBtnText}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : trustedContacts.length === 0 ? (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyText}>No trusted contacts set up</Text>
              <TouchableOpacity onPress={() => router.push('/trusted-contacts')} style={styles.setupBtn} accessibilityRole="button">
                <Text style={styles.setupBtnText}>Set Up Trusted Contacts</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
            {loadError && (
              <Text style={styles.refreshWarn} accessibilityLiveRegion="polite">
                Couldn&apos;t refresh this list — showing the last one loaded.
              </Text>
            )}
            {trustedContacts.map(contact => (
              <TouchableOpacity
                key={contact.uid}
                style={[styles.contactRow, selectedContacts.includes(contact.uid) && styles.contactSelected]}
                onPress={() => toggleContact(contact.uid)}
                // The recipients are fixed when the countdown starts.
                disabled={countdown !== null || sending}
                accessibilityRole="checkbox"
                accessibilityLabel={`${contact.name}, @${contact.vaultId}`}
                accessibilityState={{ checked: selectedContacts.includes(contact.uid), disabled: countdown !== null || sending }}
              >
                <View style={[styles.contactCheck, selectedContacts.includes(contact.uid) && styles.contactCheckActive]}>
                  {selectedContacts.includes(contact.uid) && <Ionicons name="checkmark" size={14} color={colors.accent} />}
                </View>
                <View style={styles.contactInfo}>
                  <Text numberOfLines={1} style={styles.contactName}>{contact.name}</Text>
                  <Text style={styles.contactId}>@{contact.vaultId}</Text>
                </View>
              </TouchableOpacity>
            ))}
            </>
          )}
        </View>

        {/* SOS History */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>History</Text>
          {history.length === 0 ? (
            <Text style={styles.noHistory}>No SOS activations yet</Text>
          ) : (
            history.map(item => (
              <View key={item.id} style={styles.historyRow}>
                <View style={[styles.historyDot, { backgroundColor: item.type === 'test' ? colors.primary : colors.danger }]} />
                <View style={styles.historyInfo}>
                  <Text style={styles.historyType}>
                    {item.type === 'test' ? 'Test SOS' : 'Emergency SOS'}
                  </Text>
                  <Text style={styles.historyTime}>{formatTime(item.createdAt)}</Text>
                </View>
                <Text style={styles.historyContacts}>{item.contactsNotified} alerted</Text>
              </View>
            ))
          )}
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const SOS_SIZE = 160;
const makeStyles = (c: Palette, light: boolean) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8, paddingHorizontal: 16, paddingBottom: 14 },
  backBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: 'rgba(74,159,255,0.08)', justifyContent: 'center', alignItems: 'center' },
  headerTitle: { color: c.text, fontSize: 18, fontWeight: '700' },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16 },

  // SOS Button
  sosSection: { alignItems: 'center', marginVertical: 30 },
  sosHint: { color: c.textDim, fontSize: 14, marginBottom: 20, textAlign: 'center' },
  sosButton: { width: SOS_SIZE, height: SOS_SIZE, borderRadius: SOS_SIZE / 2, overflow: 'hidden', elevation: 10, shadowColor: c.danger, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.5, shadowRadius: 20 },
  sosGradient: { flex: 1, justifyContent: 'center', alignItems: 'center', borderRadius: SOS_SIZE / 2, borderWidth: 4, borderColor: 'rgba(255,45,45,0.5)' },
  sosText: { color: '#FFF', fontSize: 48, fontWeight: '900', letterSpacing: 6 },
  testBtn: { marginTop: 20, paddingHorizontal: 24, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(251,191,36,0.3)', backgroundColor: 'rgba(251,191,36,0.08)' },
  testBtnText: { color: light ? '#B45309' : '#FBBF24', fontSize: 14, fontWeight: '600' },

  // Countdown
  countdownContainer: { alignItems: 'center' },
  countdownLabel: { color: c.danger, fontSize: 18, fontWeight: '600', marginBottom: 10 },
  countdownNumber: { color: c.text, fontSize: 72, fontWeight: '900' },
  countdownTo: { color: c.textDim, fontSize: 14, marginTop: 4, textAlign: 'center' },
  cancelBtn: { marginTop: 20, backgroundColor: 'rgba(255,60,110,0.15)', paddingHorizontal: 40, paddingVertical: 14, borderRadius: 12, borderWidth: 1, borderColor: c.danger },
  cancelBtnText: { color: c.danger, fontSize: 18, fontWeight: '800', letterSpacing: 2 },

  // Sending/Sent
  sendingContainer: { alignItems: 'center', marginVertical: 30 },
  sendingText: { color: c.danger, fontSize: 16, fontWeight: '600', marginTop: 12 },
  sentContainer: { alignItems: 'center', marginVertical: 20 },
  sentCheck: { fontSize: 48, color: c.primary },
  sentText: { color: c.text, fontSize: 22, fontWeight: '700', marginTop: 8 },
  sentSub: { color: c.textDim, fontSize: 14, marginTop: 4 },
  // Wraps and grows: this line is longer than the others and must stay
  // readable at any width or OS font scale.
  sentWarn: { color: light ? '#B45309' : '#FBBF24', fontSize: 13, marginTop: 8, textAlign: 'center', paddingHorizontal: 20 },
  resetBtn: { marginTop: 20, backgroundColor: c.accent, paddingHorizontal: 40, paddingVertical: 10, borderRadius: 8 },
  resetBtnText: { color: '#FFF', fontSize: 15, fontWeight: '700' },

  // Shake
  shakeRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: c.glassSoft, borderRadius: 14, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: 'rgba(74,159,255,0.08)' },
  shakeTitle: { color: c.text, fontSize: 15, fontWeight: '600' },
  shakeSub: { color: c.textDim, fontSize: 12, marginTop: 2 },
  toggleBtn: { paddingHorizontal: 18, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: c.border },
  toggleBtnActive: { borderColor: c.primary, backgroundColor: brandAlpha(0.15) },
  toggleText: { color: c.textDim, fontSize: 13, fontWeight: '700' },
  toggleTextActive: { color: c.primary },

  // Contacts
  section: { marginTop: 20 },
  sectionTitle: { color: c.text, fontSize: 16, fontWeight: '700' },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  editLink: { color: c.accentOn, fontSize: 14, fontWeight: '600' },
  contactRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.glassSoft, borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: 'rgba(74,159,255,0.06)' },
  contactSelected: { borderColor: 'rgba(0,229,255,0.3)', backgroundColor: 'rgba(0,229,255,0.04)' },
  contactCheck: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: c.border, justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  contactCheckActive: { borderColor: c.accent, backgroundColor: 'rgba(0,229,255,0.2)' },
  contactInfo: { flex: 1 },
  contactName: { color: c.text, fontSize: 15, fontWeight: '600' },
  contactId: { color: c.textDim, fontSize: 12, marginTop: 2 },
  emptyCard: { alignItems: 'center', backgroundColor: c.glassSoft, borderRadius: 14, padding: 24, borderWidth: 1, borderColor: 'rgba(74,159,255,0.08)' },
  emptyText: { color: c.textDim, fontSize: 14, marginBottom: 14, textAlign: 'center' },
  refreshWarn: { color: c.textDim, fontSize: 12, marginBottom: 8 },
  setupBtn: { backgroundColor: c.accent, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 },
  setupBtnText: { color: '#FFF', fontSize: 14, fontWeight: '700' },

  // History
  noHistory: { color: c.textDim, fontSize: 13, textAlign: 'center', marginTop: 8 },
  historyRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.glassSoft, borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: 'rgba(74,159,255,0.06)' },
  historyDot: { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
  historyInfo: { flex: 1 },
  historyType: { color: c.text, fontSize: 14, fontWeight: '600' },
  historyTime: { color: c.textDim, fontSize: 12, marginTop: 2 },
  historyContacts: { color: c.textDim, fontSize: 12 },
});
