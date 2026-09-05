// app/current-location.tsx
// Current Location — share exact coordinates as a snapshot
// Uses expo-location for real GPS, sends via Firestore chat message

import { Ionicons } from '@expo/vector-icons';
import React, { useState , useMemo} from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Alert, Platform, ActivityIndicator,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import * as Location from 'expo-location';
import { sendMessage } from '../lib/chatService';
import { AuroraBackground } from '../components/ui';

// const RED = '#EF4444';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function CurrentLocationScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const { chatId } = useLocalSearchParams<{ chatId?: string; peerUid?: string }>();

  const [location, setLocation] = useState<Location.LocationObject | null>(null);
  const [loading, setLoading] = useState(false);
  const [, setShared] = useState(false);
  const [address, setAddress] = useState('');

  const getLocation = async () => {
    setLoading(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Denied', 'Location permission is required');
        setLoading(false);
        return;
      }

      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setLocation(loc);

      // Reverse geocode for address
      try {
        const [geo] = await Location.reverseGeocodeAsync({
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
        });
        if (geo) {
          setAddress([geo.street, geo.city, geo.region, geo.country].filter(Boolean).join(', '));
        }
      } catch {
        setAddress(`${loc.coords.latitude.toFixed(6)}, ${loc.coords.longitude.toFixed(6)}`);
      }
    } catch (e: any) {
      Alert.alert('Error', e.message ?? 'Failed to get location');
    }
    setLoading(false);
  };

  const shareLocation = async () => {
    if (!location || !chatId) {
      Alert.alert('Error', 'No location or chat to share to');
      return;
    }

    try {
      // Send as a location-type chat message. Coordinates ride in the CONTENT
      // (end-to-end encrypted in direct chats), NOT in plaintext meta.
      await sendMessage(chatId, JSON.stringify({
        lat: location.coords.latitude,
        lng: location.coords.longitude,
        accuracy: location.coords.accuracy,
        address,
        live: false,
      }), 'location');

      setShared(true);
      Alert.alert('Shared!', 'Your current location has been sent', [
        { text: 'OK', onPress: () => router.back() },
      ]);
    } catch (e: any) {
      Alert.alert('Error', e.message ?? 'Failed to share location');
    }
  };

  return (
    <View style={s.screen}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />

      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle}>{'\uD83D\uDCCC'} Current Location</Text>
          <Text style={s.headerSub}>Share your exact coordinates instantly</Text>
        </View>
      </View>

      <View style={s.body}>
        {!location ? (
          <>
            <Text style={s.bigIcon}>{'\uD83D\uDCCC'}</Text>
            <Text style={s.title}>Share Current Location</Text>
            <Text style={s.sub}>
              Get your precise GPS coordinates and share them as a snapshot. The location is a one-time pin — not live tracking.
            </Text>
            <TouchableOpacity style={s.getBtn} onPress={getLocation} disabled={loading} activeOpacity={0.8}>
              {loading ? (
                <ActivityIndicator color="#FFF" />
              ) : (
                <>
                  <Ionicons name="location" size={18} color="#FFF" />
                  <Text style={[s.getBtnTxt, { marginLeft: 8 }]}>Get My Location</Text>
                </>
              )}
            </TouchableOpacity>
            <View style={s.infoCard}>
              <Text style={s.infoIcon}>{'\uD83D\uDD12'}</Text>
              <Text style={s.infoTxt}>A one-time pin — not live tracking. Only shared with this chat.</Text>
            </View>
          </>
        ) : (
          <>
            <View style={s.locCard}>
              <Text style={s.locIcon}>{'\uD83D\uDCCD'}</Text>
              <Text style={s.locTitle}>Location Found</Text>
              <View style={s.coordRow}>
                <View style={s.coordItem}>
                  <Text style={s.coordLabel}>Latitude</Text>
                  <Text style={s.coordVal}>{location.coords.latitude.toFixed(6)}</Text>
                </View>
                <View style={s.coordItem}>
                  <Text style={s.coordLabel}>Longitude</Text>
                  <Text style={s.coordVal}>{location.coords.longitude.toFixed(6)}</Text>
                </View>
              </View>
              {location.coords.altitude != null && (
                <View style={s.coordItem}>
                  <Text style={s.coordLabel}>Altitude</Text>
                  <Text style={s.coordVal}>{location.coords.altitude.toFixed(1)}m</Text>
                </View>
              )}
              <Text style={s.coordLabel}>Accuracy: {'\u00B1'}{location.coords.accuracy?.toFixed(0)}m</Text>
              {address ? <Text style={s.addressTxt}>{'\uD83C\uDFE0'} {address}</Text> : null}
            </View>

            {chatId ? (
              <TouchableOpacity style={s.shareBtn} onPress={shareLocation} activeOpacity={0.8}>
                <Ionicons name="share-outline" size={18} color="#FFF" />
                <Text style={[s.shareBtnTxt, { marginLeft: 8 }]}>Share to Chat</Text>
              </TouchableOpacity>
            ) : (
              <Text style={s.noChat}>Open from a chat to share location</Text>
            )}

            <TouchableOpacity style={s.refreshBtn} onPress={getLocation}>
              <Ionicons name="refresh" size={16} color={colors.textDim} />
              <Text style={[s.refreshBtnTxt, { marginLeft: 6 }]}>Refresh Location</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: Platform.OS === 'ios' ? 56 : 44, paddingBottom: 14, paddingHorizontal: 16, backgroundColor: c.card, borderBottomWidth: 1, borderBottomColor: c.border },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#2A2D3A', alignItems: 'center', justifyContent: 'center' },
  backTxt: { fontSize: 18, color: c.text },
  headerTitle: { fontSize: 16, fontWeight: '700', color: c.text },
  headerSub: { fontSize: 11, color: c.textDim, marginTop: 1 },

  body: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  bigIcon: { fontSize: 56, marginBottom: 16 },
  title: { fontSize: 22, fontWeight: '700', color: c.text, marginBottom: 8 },
  sub: { fontSize: 14, color: c.textDim, textAlign: 'center', lineHeight: 20, marginBottom: 28 },

  getBtn: { backgroundColor: c.purple, borderRadius: 16, paddingVertical: 16, paddingHorizontal: 40, marginBottom: 24, width: '100%', flexDirection: 'row', justifyContent: 'center', alignItems: 'center' },
  getBtnTxt: { color: '#FFF', fontSize: 17, fontWeight: '700' },

  infoCard: { flexDirection: 'row', gap: 10, backgroundColor: c.primary + '10', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: c.primary + '30', width: '100%' },
  infoIcon: { fontSize: 18 },
  infoTxt: { flex: 1, color: c.textDim, fontSize: 12, lineHeight: 17 },

  locCard: { backgroundColor: c.card, borderRadius: 18, padding: 20, width: '100%', marginBottom: 20, borderWidth: 1, borderColor: c.primary + '40', alignItems: 'center' },
  locIcon: { fontSize: 36, marginBottom: 8 },
  locTitle: { color: c.primary, fontSize: 18, fontWeight: '700', marginBottom: 16 },
  coordRow: { flexDirection: 'row', gap: 20, marginBottom: 12 },
  coordItem: { alignItems: 'center' },
  coordLabel: { color: c.textDim, fontSize: 11, fontWeight: '600', marginBottom: 4 },
  coordVal: { color: c.text, fontSize: 16, fontWeight: '700', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  addressTxt: { color: c.text, fontSize: 13, marginTop: 12, textAlign: 'center' },

  shareBtn: { backgroundColor: c.primary, borderRadius: 16, paddingVertical: 16, width: '100%', flexDirection: 'row', justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
  shareBtnTxt: { color: '#FFF', fontSize: 17, fontWeight: '700' },
  noChat: { color: c.textDim, fontSize: 13, marginBottom: 12 },
  refreshBtn: { backgroundColor: c.card, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 24, borderWidth: 1, borderColor: c.border, flexDirection: 'row', justifyContent: 'center', alignItems: 'center' },
  refreshBtnTxt: { color: c.textDim, fontSize: 14, fontWeight: '600' },
});
