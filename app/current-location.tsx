// app/current-location.tsx
// Current Location — share exact coordinates as a snapshot
// Uses expo-location for real GPS, sends via Firestore chat message

import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Alert, Platform, ActivityIndicator,
} from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import * as Location from 'expo-location';
import { sendMessage } from '../lib/chatService';

const DARK = '#0D0F14';
const CARD = '#1A1D27';
const PURPLE = '#6C63FF';
const BORDER = '#2A2D3A';
const TXT = '#E8E8E8';
const SUB = '#6B7280';
const GREEN = '#10B981';
// const RED = '#EF4444';

export default function CurrentLocationScreen() {
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
      // Send as a location-type chat message (Postgres backend).
      await sendMessage(chatId, `\uD83D\uDCCC Current Location${address ? `\n${address}` : ''}`, 'location', {
        meta: {
          latitude: location.coords.latitude,
          longitude: location.coords.longitude,
          accuracy: location.coords.accuracy,
          address,
          kind: 'snapshot',
        },
      });

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
      <Stack.Screen options={{ headerShown: false }} />

      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Text style={s.backTxt}>{'\u2190'}</Text>
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
                <Text style={s.getBtnTxt}>{'\uD83D\uDCCD'} Get My Location</Text>
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
                <Text style={s.shareBtnTxt}>{'\uD83D\uDCE4'} Share to Chat</Text>
              </TouchableOpacity>
            ) : (
              <Text style={s.noChat}>Open from a chat to share location</Text>
            )}

            <TouchableOpacity style={s.refreshBtn} onPress={getLocation}>
              <Text style={s.refreshBtnTxt}>{'\uD83D\uDD04'} Refresh Location</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: DARK },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: Platform.OS === 'ios' ? 56 : 44, paddingBottom: 14, paddingHorizontal: 16, backgroundColor: CARD, borderBottomWidth: 1, borderBottomColor: BORDER },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#2A2D3A', alignItems: 'center', justifyContent: 'center' },
  backTxt: { fontSize: 18, color: TXT },
  headerTitle: { fontSize: 16, fontWeight: '700', color: TXT },
  headerSub: { fontSize: 11, color: SUB, marginTop: 1 },

  body: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  bigIcon: { fontSize: 56, marginBottom: 16 },
  title: { fontSize: 22, fontWeight: '700', color: TXT, marginBottom: 8 },
  sub: { fontSize: 14, color: SUB, textAlign: 'center', lineHeight: 20, marginBottom: 28 },

  getBtn: { backgroundColor: PURPLE, borderRadius: 16, paddingVertical: 16, paddingHorizontal: 40, marginBottom: 24, width: '100%', alignItems: 'center' },
  getBtnTxt: { color: '#FFF', fontSize: 17, fontWeight: '700' },

  infoCard: { flexDirection: 'row', gap: 10, backgroundColor: GREEN + '10', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: GREEN + '30', width: '100%' },
  infoIcon: { fontSize: 18 },
  infoTxt: { flex: 1, color: SUB, fontSize: 12, lineHeight: 17 },

  locCard: { backgroundColor: CARD, borderRadius: 18, padding: 20, width: '100%', marginBottom: 20, borderWidth: 1, borderColor: GREEN + '40', alignItems: 'center' },
  locIcon: { fontSize: 36, marginBottom: 8 },
  locTitle: { color: GREEN, fontSize: 18, fontWeight: '700', marginBottom: 16 },
  coordRow: { flexDirection: 'row', gap: 20, marginBottom: 12 },
  coordItem: { alignItems: 'center' },
  coordLabel: { color: SUB, fontSize: 11, fontWeight: '600', marginBottom: 4 },
  coordVal: { color: TXT, fontSize: 16, fontWeight: '700', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  addressTxt: { color: TXT, fontSize: 13, marginTop: 12, textAlign: 'center' },

  shareBtn: { backgroundColor: GREEN, borderRadius: 16, paddingVertical: 16, width: '100%', alignItems: 'center', marginBottom: 12 },
  shareBtnTxt: { color: '#FFF', fontSize: 17, fontWeight: '700' },
  noChat: { color: SUB, fontSize: 13, marginBottom: 12 },
  refreshBtn: { backgroundColor: CARD, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 24, borderWidth: 1, borderColor: BORDER },
  refreshBtnTxt: { color: SUB, fontSize: 14, fontWeight: '600' },
});
