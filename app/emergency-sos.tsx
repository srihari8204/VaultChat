// app/emergency-sos.tsx — Emergency SOS
// Big red SOS button, shake detection, GPS alert to trusted contacts
// Countdown before sending, test mode, history
// Uses expo-location, expo-sensors (Accelerometer)

import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  Alert, ActivityIndicator, Vibration, Platform,
  Animated, Easing,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import * as Location from 'expo-location';
import { Accelerometer } from 'expo-sensors';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';

const C = { bg: '#FFFFFF', accent: '#4A9FFF', cyan: '#4A9FFF', card: '#F9FAFB', danger: '#FF3C6E', green: '#10B981', text: '#FFFFFF', muted: '#8A9BBF', red: '#FF2D2D' };

const SOS_MESSAGE = (name: string, lat: number, lng: number) =>
  `\u{1F6A8} EMERGENCY: ${name} needs help. Location: https://maps.google.com/?q=${lat},${lng}`;

const TEST_MESSAGE = (name: string, lat: number, lng: number) =>
  `[TEST] \u{1F6A8} SOS Test from ${name}. Location: https://maps.google.com/?q=${lat},${lng} — This is a test, no emergency.`;

export default function EmergencySOSScreen() {
  const router = useRouter();
  const myUid = auth().currentUser?.uid || '';

  // State
  const [trustedContacts, setTrustedContacts] = useState<any[]>([]);
  const [selectedContacts, setSelectedContacts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const [history, setHistory] = useState<any[]>([]);
  const [shakeEnabled, setShakeEnabled] = useState(true);

  // Animations
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const countdownTimer = useRef<any>(null);
  const shakeRef = useRef({ count: 0, lastShake: 0 });

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
  useEffect(() => {
    const loadTrustedContacts = async () => {
      setLoading(true);
      try {
        const snap = await firestore().collection('users').doc(myUid).get();
        const ids: string[] = snap.data()?.trustedContacts || [];
        const contacts: any[] = [];
        for (const uid of ids) {
          try {
            const uSnap = await firestore().collection('users').doc(uid).get();
            const d = uSnap.data();
            contacts.push({ uid, name: d?.name || 'Unknown', vaultId: d?.vaultId || uid.slice(0, 8) });
          } catch {}
        }
        setTrustedContacts(contacts);
        setSelectedContacts(contacts.map(c => c.uid));
      } catch {}
      setLoading(false);
    };
    const loadHistory = async () => {
      try {
        const snap = await firestore().collection('users').doc(myUid)
          .collection('sosHistory')
          .orderBy('createdAt', 'desc')
          .limit(20)
          .get();
        setHistory(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      } catch {}
    };
    loadTrustedContacts();
    loadHistory();
  }, [myUid]);

  // Shake detection
  useEffect(() => {
    if (!shakeEnabled) return;
    const SHAKE_THRESHOLD = 1.8;
    const triggerSOSInEffect = async (isTest: boolean) => {
      setSending(true);
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        let lat = 0, lng = 0;
        if (status === 'granted') {
          const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
          lat = loc.coords.latitude;
          lng = loc.coords.longitude;
        }
        const mySnap = await firestore().collection('users').doc(myUid).get();
        const myName = mySnap.data()?.name || 'VaultChat User';
        const message = isTest ? TEST_MESSAGE(myName, lat, lng) : SOS_MESSAGE(myName, lat, lng);
        for (const uid of selectedContacts) {
          try {
            await firestore().collection('users').doc(uid).collection('alerts').add({
              type: isTest ? 'sos_test' : 'sos_emergency',
              fromUid: myUid, fromName: myName, message,
              latitude: lat, longitude: lng,
              createdAt: firestore.FieldValue.serverTimestamp(), read: false,
            });
          } catch {}
        }
        await firestore().collection('securityEvents').add({
          type: isTest ? 'sos_test' : 'sos_emergency',
          uid: myUid, name: myName, latitude: lat, longitude: lng,
          contactsNotified: selectedContacts.length,
          createdAt: firestore.FieldValue.serverTimestamp(),
        });
        await firestore().collection('users').doc(myUid).collection('sosHistory').add({
          type: isTest ? 'test' : 'emergency',
          latitude: lat, longitude: lng,
          contactsNotified: selectedContacts.length,
          createdAt: firestore.FieldValue.serverTimestamp(),
        });
        setSent(true);
        Vibration.vibrate([0, 500, 200, 500]);
        try {
          const hSnap = await firestore().collection('users').doc(myUid)
            .collection('sosHistory').orderBy('createdAt', 'desc').limit(20).get();
          setHistory(hSnap.docs.map(d => ({ id: d.id, ...d.data() })));
        } catch {}
      } catch {
        Alert.alert('Error', 'Failed to send SOS. Please try again.');
      }
      setSending(false);
    };
    const startCountdownFromShake = (isTest: boolean) => {
      if (selectedContacts.length === 0) {
        Alert.alert('No Contacts', 'Select at least one trusted contact to send SOS to.');
        return;
      }
      setTestMode(isTest);
      setCountdown(5);
      setSent(false);

      let count = 5;
      countdownTimer.current = setInterval(() => {
        count -= 1;
        if (count <= 0) {
          clearInterval(countdownTimer.current);
          setCountdown(null);
          triggerSOSInEffect(isTest);
        } else {
          setCountdown(count);
          if (Platform.OS !== 'web') Vibration.vibrate(100);
        }
      }, 1000);
    };
    if (Platform.OS === 'web') return;
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

        if (shakeRef.current.count >= 3 && countdown === null && !sending && !sent) {
          shakeRef.current.count = 0;
          if (Platform.OS !== 'web') Vibration.vibrate([0, 200, 100, 200]);
          startCountdownFromShake(false);
        }
      }
    });
    Accelerometer.setUpdateInterval(100);
    return () => subscription.remove();
  }, [shakeEnabled, countdown, sending, sent, selectedContacts, myUid]);

  const toggleContact = (uid: string) => {
    setSelectedContacts(prev =>
      prev.includes(uid) ? prev.filter(u => u !== uid) : [...prev, uid]
    );
  };

  const startCountdown = (isTest: boolean) => {
    if (selectedContacts.length === 0) {
      Alert.alert('No Contacts', 'Select at least one trusted contact to send SOS to.');
      return;
    }
    setTestMode(isTest);
    setCountdown(5);
    setSent(false);

    let count = 5;
    countdownTimer.current = setInterval(() => {
      count -= 1;
      if (count <= 0) {
        clearInterval(countdownTimer.current);
        setCountdown(null);
        triggerSOS(isTest);
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

  const triggerSOS = async (isTest: boolean) => {
    setSending(true);
    try {
      // Get location
      const { status } = await Location.requestForegroundPermissionsAsync();
      let lat = 0, lng = 0;
      if (status === 'granted') {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        lat = loc.coords.latitude;
        lng = loc.coords.longitude;
      }

      // Get user name
      const mySnap = await firestore().collection('users').doc(myUid).get();
      const myName = mySnap.data()?.name || 'VaultChat User';

      const message = isTest ? TEST_MESSAGE(myName, lat, lng) : SOS_MESSAGE(myName, lat, lng);

      // Send to each selected trusted contact
      for (const uid of selectedContacts) {
        try {
          await firestore().collection('users').doc(uid).collection('alerts').add({
            type: isTest ? 'sos_test' : 'sos_emergency',
            fromUid: myUid,
            fromName: myName,
            message,
            latitude: lat,
            longitude: lng,
            createdAt: firestore.FieldValue.serverTimestamp(),
            read: false,
          });
        } catch {}
      }

      // Log to securityEvents
      await firestore().collection('securityEvents').add({
        type: isTest ? 'sos_test' : 'sos_emergency',
        uid: myUid,
        name: myName,
        latitude: lat,
        longitude: lng,
        contactsNotified: selectedContacts.length,
        createdAt: firestore.FieldValue.serverTimestamp(),
      });

      // Save to SOS history
      await firestore().collection('users').doc(myUid).collection('sosHistory').add({
        type: isTest ? 'test' : 'emergency',
        latitude: lat,
        longitude: lng,
        contactsNotified: selectedContacts.length,
        createdAt: firestore.FieldValue.serverTimestamp(),
      });

      setSent(true);
      Vibration.vibrate([0, 500, 200, 500]);
      // Reload history inline
      try {
        const hSnap = await firestore().collection('users').doc(myUid)
          .collection('sosHistory')
          .orderBy('createdAt', 'desc')
          .limit(20)
          .get();
        setHistory(hSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      } catch {}
    } catch {
      Alert.alert('Error', 'Failed to send SOS. Please try again.');
    }
    setSending(false);
  };

  const formatTime = (ts: any) => {
    if (!ts?.toDate) return 'Unknown';
    const d = ts.toDate();
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />
      <LinearGradient colors={['#FFFFFF', '#0D0A18', '#FFFFFF']} style={StyleSheet.absoluteFill} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backArrow}>←</Text>
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
              <Text style={styles.countdownNumber}>{countdown}</Text>
              <TouchableOpacity onPress={cancelCountdown} style={styles.cancelBtn}>
                <Text style={styles.cancelBtnText}>CANCEL</Text>
              </TouchableOpacity>
            </View>
          ) : sending ? (
            // Sending state
            <View style={styles.sendingContainer}>
              <ActivityIndicator size="large" color={C.danger} />
              <Text style={styles.sendingText}>Sending SOS...</Text>
            </View>
          ) : sent ? (
            // Sent state
            <View style={styles.sentContainer}>
              <Text style={styles.sentCheck}>✓</Text>
              <Text style={styles.sentText}>{testMode ? 'Test SOS Sent' : 'SOS Sent!'}</Text>
              <Text style={styles.sentSub}>{selectedContacts.length} contact(s) notified</Text>
              <TouchableOpacity onPress={() => setSent(false)} style={styles.resetBtn}>
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
                >
                  <LinearGradient colors={['#FF2D2D', '#CC0000']} style={styles.sosGradient}>
                    <Text style={styles.sosText}>SOS</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </Animated.View>
              <TouchableOpacity onPress={() => startCountdown(true)} style={styles.testBtn}>
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
          >
            <Text style={[styles.toggleText, shakeEnabled && styles.toggleTextActive]}>
              {shakeEnabled ? 'ON' : 'OFF'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Trusted Contacts for SOS */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>SOS Contacts</Text>
          {loading ? (
            <ActivityIndicator color={C.accent} style={{ marginTop: 16 }} />
          ) : trustedContacts.length === 0 ? (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyText}>No trusted contacts set up</Text>
              <TouchableOpacity onPress={() => router.push('/trusted-contacts')} style={styles.setupBtn}>
                <Text style={styles.setupBtnText}>Set Up Trusted Contacts</Text>
              </TouchableOpacity>
            </View>
          ) : (
            trustedContacts.map(contact => (
              <TouchableOpacity
                key={contact.uid}
                style={[styles.contactRow, selectedContacts.includes(contact.uid) && styles.contactSelected]}
                onPress={() => toggleContact(contact.uid)}
              >
                <View style={[styles.contactCheck, selectedContacts.includes(contact.uid) && styles.contactCheckActive]}>
                  {selectedContacts.includes(contact.uid) && <Text style={styles.checkMark}>✓</Text>}
                </View>
                <View style={styles.contactInfo}>
                  <Text style={styles.contactName}>{contact.name}</Text>
                  <Text style={styles.contactId}>@{contact.vaultId}</Text>
                </View>
              </TouchableOpacity>
            ))
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
                <View style={[styles.historyDot, { backgroundColor: item.type === 'test' ? C.yellow : C.danger }]} />
                <View style={styles.historyInfo}>
                  <Text style={styles.historyType}>
                    {item.type === 'test' ? 'Test SOS' : 'Emergency SOS'}
                  </Text>
                  <Text style={styles.historyTime}>{formatTime(item.createdAt)}</Text>
                </View>
                <Text style={styles.historyContacts}>{item.contactsNotified} notified</Text>
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
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: Platform.OS === 'ios' ? 56 : 40, paddingHorizontal: 16, paddingBottom: 14 },
  backBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: 'rgba(74,159,255,0.08)', justifyContent: 'center', alignItems: 'center' },
  backArrow: { color: C.accent, fontSize: 20 },
  headerTitle: { color: '#FFF', fontSize: 18, fontWeight: '700' },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16 },

  // SOS Button
  sosSection: { alignItems: 'center', marginVertical: 30 },
  sosHint: { color: C.muted, fontSize: 14, marginBottom: 20, textAlign: 'center' },
  sosButton: { width: SOS_SIZE, height: SOS_SIZE, borderRadius: SOS_SIZE / 2, overflow: 'hidden', elevation: 10, shadowColor: C.red, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.5, shadowRadius: 20 },
  sosGradient: { flex: 1, justifyContent: 'center', alignItems: 'center', borderRadius: SOS_SIZE / 2, borderWidth: 4, borderColor: 'rgba(255,45,45,0.5)' },
  sosText: { color: '#FFF', fontSize: 48, fontWeight: '900', letterSpacing: 6 },
  testBtn: { marginTop: 20, paddingHorizontal: 24, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(251,191,36,0.3)', backgroundColor: 'rgba(251,191,36,0.08)' },
  testBtnText: { color: '#FBBF24', fontSize: 14, fontWeight: '600' },

  // Countdown
  countdownContainer: { alignItems: 'center' },
  countdownLabel: { color: C.danger, fontSize: 18, fontWeight: '600', marginBottom: 10 },
  countdownNumber: { color: '#FFF', fontSize: 72, fontWeight: '900' },
  cancelBtn: { marginTop: 20, backgroundColor: 'rgba(255,60,110,0.15)', paddingHorizontal: 40, paddingVertical: 14, borderRadius: 12, borderWidth: 1, borderColor: C.danger },
  cancelBtnText: { color: C.danger, fontSize: 18, fontWeight: '800', letterSpacing: 2 },

  // Sending/Sent
  sendingContainer: { alignItems: 'center', marginVertical: 30 },
  sendingText: { color: C.danger, fontSize: 16, fontWeight: '600', marginTop: 12 },
  sentContainer: { alignItems: 'center', marginVertical: 20 },
  sentCheck: { fontSize: 48, color: C.green },
  sentText: { color: '#FFF', fontSize: 22, fontWeight: '700', marginTop: 8 },
  sentSub: { color: C.muted, fontSize: 14, marginTop: 4 },
  resetBtn: { marginTop: 20, backgroundColor: C.accent, paddingHorizontal: 40, paddingVertical: 10, borderRadius: 8 },
  resetBtnText: { color: '#FFF', fontSize: 15, fontWeight: '700' },

  // Shake
  shakeRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: C.card, borderRadius: 14, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: 'rgba(74,159,255,0.08)' },
  shakeTitle: { color: '#FFF', fontSize: 15, fontWeight: '600' },
  shakeSub: { color: C.muted, fontSize: 12, marginTop: 2 },
  toggleBtn: { paddingHorizontal: 18, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
  toggleBtnActive: { borderColor: C.green, backgroundColor: 'rgba(16,185,129,0.15)' },
  toggleText: { color: C.muted, fontSize: 13, fontWeight: '700' },
  toggleTextActive: { color: C.green },

  // Contacts
  section: { marginTop: 20 },
  sectionTitle: { color: '#FFF', fontSize: 16, fontWeight: '700', marginBottom: 12 },
  contactRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: 'rgba(74,159,255,0.06)' },
  contactSelected: { borderColor: 'rgba(0,229,255,0.3)', backgroundColor: 'rgba(0,229,255,0.04)' },
  contactCheck: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: 'rgba(255,255,255,0.15)', justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  contactCheckActive: { borderColor: C.cyan, backgroundColor: 'rgba(0,229,255,0.2)' },
  checkMark: { color: C.cyan, fontSize: 14, fontWeight: '700' },
  contactInfo: { flex: 1 },
  contactName: { color: '#FFF', fontSize: 15, fontWeight: '600' },
  contactId: { color: C.muted, fontSize: 12, marginTop: 2 },
  emptyCard: { alignItems: 'center', backgroundColor: C.card, borderRadius: 14, padding: 24, borderWidth: 1, borderColor: 'rgba(74,159,255,0.08)' },
  emptyText: { color: C.muted, fontSize: 14, marginBottom: 14 },
  setupBtn: { backgroundColor: C.accent, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 },
  setupBtnText: { color: '#FFF', fontSize: 14, fontWeight: '700' },

  // History
  noHistory: { color: C.muted, fontSize: 13, textAlign: 'center', marginTop: 8 },
  historyRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: 'rgba(74,159,255,0.06)' },
  historyDot: { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
  historyInfo: { flex: 1 },
  historyType: { color: '#FFF', fontSize: 14, fontWeight: '600' },
  historyTime: { color: C.muted, fontSize: 12, marginTop: 2 },
  historyContacts: { color: C.muted, fontSize: 12 },
});
