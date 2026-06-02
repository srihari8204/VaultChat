// Minimal post-signin landing for Phase 2.
//
// Confirms the JWT is in SecureStore by showing the cached user profile
// fetched from the backend. Acts as a placeholder until Phases 4-7 bring
// chats / contacts / channels back online on top of Postgres.

import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import {
  getCurrentUserAsync,
  logoutUser,
} from './(constants)/authService';
import { api } from '../lib/api';

export default function SignedInScreen() {
  const router = useRouter();
  const [user,    setUser]    = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [serverProfile, setServerProfile] = useState<any | null>(null);

  // Read cached user immediately (zero network)
  useEffect(() => {
    (async () => {
      const u = await getCurrentUserAsync();
      setUser(u);
      setLoading(false);
      // In parallel, fetch fresh profile from the backend so the cache
      // reflects any server-side changes.
      try {
        const fresh = await api<any>('/user/profile');
        setServerProfile(fresh);
      } catch (err) {
        console.warn('[signed-in] profile fetch failed:', (err as any)?.message);
      }
    })();
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const fresh = await api<any>('/user/profile');
      setServerProfile(fresh);
    } catch (err: any) {
      Alert.alert('Refresh failed', err?.message ?? 'Unknown error');
    } finally {
      setRefreshing(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await logoutUser();
    } finally {
      router.replace('/welcome' as any);
    }
  };

  if (loading) {
    return (
      <View style={S.center}>
        <ActivityIndicator color="#4A9FFF" size="large" />
      </View>
    );
  }

  const display = serverProfile ?? user ?? {};

  return (
    <View style={S.screen}>
      <View style={S.card}>
        <Text style={S.title}>You're signed in</Text>
        <Text style={S.sub}>Phase 2 auth is wired up. Chats and other features come back online in Phases 4-7.</Text>

        <View style={S.row}><Text style={S.k}>Email</Text><Text style={S.v}>{display.email ?? '—'}</Text></View>
        <View style={S.row}><Text style={S.k}>Name</Text><Text style={S.v}>{display.name ?? '—'}</Text></View>
        <View style={S.row}><Text style={S.k}>Provider</Text><Text style={S.v}>{display.authProvider ?? '—'}</Text></View>
        <View style={S.row}><Text style={S.k}>User ID</Text><Text style={S.vSmall}>{display.id ?? '—'}</Text></View>
        <View style={S.row}><Text style={S.k}>Created</Text><Text style={S.vSmall}>{display.createdAt ? new Date(display.createdAt).toLocaleString() : '—'}</Text></View>
        <View style={S.row}><Text style={S.k}>Email verified</Text><Text style={S.v}>{display.emailVerifiedAt ? '✓' : '—'}</Text></View>
        <View style={S.row}><Text style={S.k}>PIN set</Text><Text style={S.v}>{display.hasPin ? '✓' : '—'}</Text></View>
      </View>

      <TouchableOpacity style={S.btnSecondary} onPress={refresh} disabled={refreshing} activeOpacity={0.8}>
        <Text style={S.btnSecondaryTxt}>{refreshing ? 'Refreshing…' : 'Refresh from /user/profile'}</Text>
      </TouchableOpacity>

      <TouchableOpacity style={S.btnDanger} onPress={handleSignOut} activeOpacity={0.85}>
        <Text style={S.btnDangerTxt}>Sign out</Text>
      </TouchableOpacity>
    </View>
  );
}

const S = StyleSheet.create({
  center:        { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#FFFFFF' },
  screen:        { flex: 1, backgroundColor: '#FFFFFF', padding: 24, paddingTop: 64, gap: 16 },
  card:          { backgroundColor: '#F4F6FA', borderRadius: 16, padding: 20, gap: 8 },
  title:         { fontSize: 22, fontWeight: '800', color: '#000', marginBottom: 4 },
  sub:           { fontSize: 13, color: 'rgba(0,0,0,0.55)', marginBottom: 12, lineHeight: 18 },
  row:           { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(0,0,0,0.1)' },
  k:             { fontSize: 13, color: 'rgba(0,0,0,0.55)' },
  v:             { fontSize: 14, color: '#000', fontWeight: '600' },
  vSmall:        { fontSize: 11, color: '#000', fontWeight: '500', maxWidth: 220, textAlign: 'right' },
  btnSecondary:  { borderWidth: 1, borderColor: 'rgba(0,0,0,0.15)', borderRadius: 12, padding: 14, alignItems: 'center' },
  btnSecondaryTxt: { color: '#000', fontWeight: '600' },
  btnDanger:     { backgroundColor: '#000', borderRadius: 12, padding: 14, alignItems: 'center' },
  btnDangerTxt:  { color: '#fff', fontWeight: '700' },
});
