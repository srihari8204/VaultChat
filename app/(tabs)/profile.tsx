// app/(tabs)/profile.tsx — Phase 3a profile tab.
//
// Backed by /user/profile (Postgres). Edit name + status, sign out.
// Photo upload is deferred to Phase 4 (file storage).

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text, TextInput, TouchableOpacity,
  View,
} from 'react-native';
import { logoutUser } from '../(constants)/authService';
import { api } from '../../lib/api';
import { unregisterPushToken } from '../../lib/push';
import { disconnect as disconnectSocket } from '../../lib/socket';

interface UserProfile {
  id: string;
  email: string;
  name?: string | null;
  phone?: string | null;
  photoURL?: string | null;
  status?: string | null;
  authProvider?: string | null;
  hasPin?: boolean;
  faceCount?: number;
  createdAt?: string;
  emailVerifiedAt?: string | null;
}

export default function ProfileScreen() {
  const router = useRouter();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);

  const [name,   setName]   = useState('');
  const [status, setStatus] = useState('');
  const [phone,  setPhone]  = useState('');

  const load = useCallback(async () => {
    try {
      const p = await api<UserProfile>('/user/profile');
      setProfile(p);
      setName(p.name ?? '');
      setStatus(p.status ?? '');
      setPhone(p.phone ?? '');
    } catch (e: any) {
      Alert.alert('Profile load failed', e?.message ?? 'Try again');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onSave = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      const updated = await api<UserProfile>('/user/profile', {
        method: 'PUT',
        json: {
          name: name.trim(),
          status: status.trim(),
          phone: phone.trim() || undefined,
        },
      });
      setProfile(updated);
      Alert.alert('Saved', 'Profile updated');
    } catch (e: any) {
      Alert.alert('Save failed', e?.message ?? 'Try again');
    } finally {
      setSaving(false);
    }
  }, [name, status, phone, saving]);

  const onSignOut = useCallback(async () => {
    Alert.alert('Sign out?', 'You will need to sign in again next time.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: async () => {
          try { await unregisterPushToken(); } catch {}
          try { disconnectSocket(); } catch {}
          await logoutUser();
          router.replace('/welcome' as any);
        }
      },
    ]);
  }, [router]);

  if (loading) {
    return (
      <View style={[S.screen, S.center]}>
        <ActivityIndicator color={ACCENT} size="large" />
      </View>
    );
  }

  const avatarLetter = (profile?.name?.trim()[0] ?? profile?.email?.[0] ?? '?').toUpperCase();

  return (
    <ScrollView style={S.screen} contentContainerStyle={{ paddingBottom: 80 }}>
      <View style={S.header}>
        <Text style={S.title}>Profile</Text>
      </View>

      <View style={S.avatarWrap}>
        <View style={S.avatar}>
          <Text style={S.avatarTxt}>{avatarLetter}</Text>
        </View>
        <Text style={S.emailDisplay}>{profile?.email}</Text>
        <View style={S.providerPill}>
          <Text style={S.providerPillTxt}>{profile?.authProvider ?? 'unknown'}</Text>
        </View>
      </View>

      <View style={S.section}>
        <Text style={S.label}>DISPLAY NAME</Text>
        <TextInput
          style={S.input}
          value={name}
          onChangeText={setName}
          placeholder="Your name"
          placeholderTextColor={SUBTLE}
          maxLength={100}
        />

        <Text style={S.label}>STATUS</Text>
        <TextInput
          style={S.input}
          value={status}
          onChangeText={setStatus}
          placeholder="e.g. Hey, I'm on VaultChat"
          placeholderTextColor={SUBTLE}
          maxLength={200}
        />

        <Text style={S.label}>PHONE (for chat discovery)</Text>
        <TextInput
          style={S.input}
          value={phone}
          onChangeText={setPhone}
          placeholder="+91 9876543210 or 9876543210"
          placeholderTextColor={SUBTLE}
          keyboardType="phone-pad"
          autoComplete="tel"
          maxLength={20}
        />
        <Text style={S.subHint}>
          Others can start a direct chat with you using this number.
          Leave blank to stay email-only.
        </Text>

        <TouchableOpacity
          style={[S.btn, saving && S.btnOff]}
          onPress={onSave}
          disabled={saving}
          activeOpacity={0.85}
        >
          {saving ? <ActivityIndicator color="#fff" /> : <Text style={S.btnTxt}>Save changes</Text>}
        </TouchableOpacity>
      </View>

      <View style={S.section}>
        <Text style={S.label}>ACCOUNT</Text>
        <InfoRow k="User ID" v={profile?.id ?? '—'} small />
        <InfoRow k="Created"  v={profile?.createdAt ? new Date(profile.createdAt).toLocaleString() : '—'} small />
        <InfoRow k="Email verified" v={profile?.emailVerifiedAt ? '✓ Yes' : '—'} />
        <InfoRow k="PIN set" v={profile?.hasPin ? '✓ Yes' : 'No'} />
        <InfoRow k="Faces enrolled" v={String(profile?.faceCount ?? 0)} />
      </View>

      <TouchableOpacity style={S.signOutBtn} onPress={onSignOut} activeOpacity={0.85}>
        <Text style={S.signOutTxt}>Sign out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function InfoRow({ k, v, small }: { k: string; v: string; small?: boolean }) {
  return (
    <View style={S.infoRow}>
      <Text style={S.infoK}>{k}</Text>
      <Text style={[S.infoV, small && S.infoVSmall]} numberOfLines={1}>{v}</Text>
    </View>
  );
}

const DARK_BG = '#0D0F14';
const CARD_BG = '#161A22';
const BORDER  = '#1F2937';
const TEXT    = '#E5E7EB';
const SUBTLE  = '#9CA3AF';
const ACCENT  = '#6C63FF';
const DANGER  = '#EF4444';

const S = StyleSheet.create({
  screen:       { flex: 1, backgroundColor: DARK_BG },
  center:       { justifyContent: 'center', alignItems: 'center' },
  header:       { paddingHorizontal: 20, paddingTop: 56, paddingBottom: 12 },
  title:        { color: TEXT, fontSize: 28, fontWeight: '800' },

  avatarWrap:   { alignItems: 'center', paddingVertical: 24, gap: 8 },
  avatar:       { width: 96, height: 96, borderRadius: 48, backgroundColor: ACCENT, alignItems: 'center', justifyContent: 'center' },
  avatarTxt:    { color: '#fff', fontSize: 38, fontWeight: '800' },
  emailDisplay: { color: TEXT, fontSize: 15, fontWeight: '600', marginTop: 8 },
  providerPill: { backgroundColor: CARD_BG, borderColor: BORDER, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, marginTop: 4 },
  providerPillTxt: { color: SUBTLE, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1 },

  section:      { paddingHorizontal: 20, marginTop: 16, gap: 8 },
  label:        { color: SUBTLE, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, marginTop: 8 },
  input:        { color: TEXT, backgroundColor: CARD_BG, borderColor: BORDER, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
  subHint:      { color: SUBTLE, fontSize: 12, lineHeight: 16, marginTop: -2 },
  btn:          { backgroundColor: ACCENT, paddingVertical: 14, borderRadius: 24, alignItems: 'center', marginTop: 12 },
  btnOff:       { backgroundColor: '#374151' },
  btnTxt:       { color: '#fff', fontWeight: '700', fontSize: 14 },

  infoRow:      { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: BORDER },
  infoK:        { color: SUBTLE, fontSize: 13 },
  infoV:        { color: TEXT, fontSize: 13, fontWeight: '600', maxWidth: '60%' },
  infoVSmall:   { fontSize: 11, fontWeight: '500' },

  signOutBtn:   { marginHorizontal: 20, marginTop: 32, padding: 14, borderRadius: 24, borderWidth: 1, borderColor: DANGER, alignItems: 'center' },
  signOutTxt:   { color: DANGER, fontWeight: '700', fontSize: 14 },
});
