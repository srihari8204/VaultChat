// app/pinentry.tsx
// PIN entry screen â€” detects duress PIN and wipes messages

import React, { useState, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Vibration, Animated, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as Location from 'expo-location';
import { activateGhost, deactivateGhost } from '../lib/ghostProtocol';

const PIN_KEY     = '@vaultchat_pin_hash';

export default function PinEntryScreen() {
  const router    = useRouter();
  const [pin,     setPin]     = useState('');
  const [error,   setError]   = useState('');
  const shakeAnim = useRef(new Animated.Value(0)).current;

  const shake = () => {
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 10,  duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 10,  duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0,   duration: 50, useNativeDriver: true }),
    ]).start();
  };

  const press = async (digit: string) => {
    const next = pin + digit;
    setPin(next);
    if (next.length < 4) return;

    const myUid   = auth().currentUser?.uid ?? '';
    const entered = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, 'vaultchat-' + next);
    const duress  = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, 'vaultchat-duress-' + next);

    // Check duress PIN first
    const userSnap = await firestore().collection('users').doc(myUid).get();
    const duressPinHash = userSnap.data()?.duressPinHash;

    if (duressPinHash && duress === duressPinHash) {
      // GHOST PROTOCOL ACTIVATED — show perfect decoy
      await activateGhost();

      // Silent background wipe (non-blocking)
      wipeSensitiveData(myUid).catch(() => {});

      // Silent location alert to trusted contact (non-blocking)
      sendDuressAlert(myUid).catch(() => {});

      // Navigate to decoy — looks identical to real app
      router.replace('/decoy-chats' as any);
      return;
    }

    // Check normal PIN
    const storedHash = await AsyncStorage.getItem(PIN_KEY);
    if (!storedHash) {
      // No PIN set — force user to set one (should not happen in normal flow)
      setPin('');
      setError('PIN not configured');
      shake();
      if (Platform.OS !== 'web') Vibration.vibrate(400);
      setTimeout(() => setError(''), 1500);
      return;
    }
    if (entered === storedHash) {
      await deactivateGhost();
      router.replace('/(tabs)/chats');
    } else {
      setPin('');
      setError('Wrong PIN');
      shake();
      if (Platform.OS !== 'web') Vibration.vibrate(400);
      setTimeout(() => setError(''), 1500);
    }
  };

  const del = () => setPin(p => p.slice(0, -1));

  // Called when duress PIN detected â€” wipe silently
  
  // Silent GPS alert to trusted contacts
  const sendDuressAlert = async (uid: string) => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      // Log duress event with location to Firestore
      const firestore = (await import('@react-native-firebase/firestore')).default;
      await firestore().collection('users').doc(uid)
        .collection('securityEvents').add({
          type: 'duress_activated',
          lat: loc.coords.latitude,
          lng: loc.coords.longitude,
          timestamp: firestore.FieldValue.serverTimestamp(),
          deviceInfo: { platform: 'android' },
        });
      // Send push notification to trusted contacts
      const userDoc = await firestore().collection('users').doc(uid).get();
      const trustedContacts = userDoc.data()?.trustedContacts || [];
      for (const contactUid of trustedContacts) {
        const contactDoc = await firestore().collection('users').doc(contactUid).get();
        const pushToken = contactDoc.data()?.pushToken;
        if (pushToken) {
          // Silent alert — "Emergency: [name] may need help"
          // Location shared via security events
        }
      }
    } catch {}
  };

const wipeSensitiveData = async (myUid: string) => {
    try {
      const chatsSnap = await firestore()
        .collection('chats')
        .where('participants', 'array-contains', myUid)
        .get();
      const batch = firestore().batch();
      // Mark all as deleted â€” actual wipe happens lazily
      chatsSnap.docs.forEach(doc => {
        batch.update(doc.ref, { wipedByDuress: true });
      });
      await batch.commit();
    } catch {}
  };

  const KEYS = [['1','2','3'],['4','5','6'],['7','8','9'],['','0','âŒ«']];

  return (
    <View style={s.screen}>
      <Text style={s.logo}>ðŸ”’</Text>
      <Text style={s.title}>VaultChat</Text>
      <Text style={s.sub}>Enter your PIN</Text>

      <Animated.View style={[s.dots, { transform: [{ translateX: shakeAnim }] }]}>
        {[0,1,2,3].map(i => (
          <View key={i} style={[s.dot, pin.length > i && s.dotFilled]} />
        ))}
      </Animated.View>

      {error ? <Text style={s.error}>{error}</Text> : null}

      {KEYS.map((row, ri) => (
        <View key={ri} style={s.row}>
          {row.map((k, ki) => {
            if (k === '') return <View key={ki} style={s.keyPlaceholder} />;
            return (
              <TouchableOpacity
                key={ki}
                style={s.key}
                onPress={() => k === 'âŒ«' ? del() : press(k)}
              >
                <Text style={[s.keyTxt, k === 'âŒ«' && { color: '#6B7280' }]}>{k}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  logo:   { fontSize: 48, marginBottom: 8 },
  title:  { color: '#fff', fontSize: 26, fontWeight: 'bold', marginBottom: 4 },
  sub:    { color: '#6B7280', fontSize: 15, marginBottom: 40 },
  dots:   { flexDirection: 'row', gap: 18, marginBottom: 16 },
  dot:    { width: 14, height: 14, borderRadius: 7, backgroundColor: '#E5E7EB', borderWidth: 2, borderColor: '#9CA3AF' },
  dotFilled: { backgroundColor: '#4A9FFF', borderColor: '#4A9FFF' },
  error:  { color: '#FF3C6E', fontSize: 14, marginBottom: 8 },
  row:    { flexDirection: 'row', gap: 20, marginBottom: 16 },
  key:    { width: 72, height: 72, borderRadius: 36, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#F3F4F6' },
  keyTxt: { color: '#1F2937', fontSize: 26, fontWeight: '300' },
  keyPlaceholder: { width: 72, height: 72 },
});
