// app/(tabs)/profile.tsx — Phase 3a profile tab.
//
// Backed by /user/profile (Postgres). Edit name + status, sign out.
// Photo upload is deferred to Phase 4 (file storage).

import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTheme } from '../../lib/theme';
import { type Palette } from '../../constants/theme';
import {
  ActivityIndicator,
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Text, TextInput, TouchableOpacity,
  View,
} from 'react-native';
import { logoutUser, sendPhoneOTP, verifyPhoneOTP } from '../(constants)/authService';
import { api, getAccessToken } from '../../lib/api';
import { attachmentUrl, uploadAttachment } from '../../lib/chatService';
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

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function ProfileScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [authHeader, setAuthHeader] = useState<string | null>(null);

  const [name,   setName]   = useState('');
  const [status, setStatus] = useState('');
  const [phone,  setPhone]  = useState('');

  // Fetch the Bearer header once so RN's <Image> can pull the photo via
  // the auth-gated /uploads endpoint.
  useEffect(() => {
    let cancel = false;
    (async () => {
      const tok = await getAccessToken();
      if (!cancel) setAuthHeader(tok ? `Bearer ${tok}` : null);
    })();
    return () => { cancel = true; };
  }, []);

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

  // ── Profile photo: pick → upload → PUT /user/profile { photoURL } ──
  const onChangePhoto = useCallback(async () => {
    if (photoBusy) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Allow photo library access to set your profile picture.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.7,
      allowsEditing: true,
      aspect: [1, 1],
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];

    setPhotoBusy(true);
    try {
      const filename = asset.fileName || `avatar-${Date.now()}.jpg`;
      const mime     = asset.mimeType || 'image/jpeg';
      const up       = await uploadAttachment(asset.uri, filename, mime);
      const updated  = await api<UserProfile>('/user/profile', {
        method: 'PUT',
        json: { photoURL: up.id },
      });
      setProfile(updated);
    } catch (e: any) {
      Alert.alert('Photo upload failed', e?.message ?? 'Try again');
    } finally {
      setPhotoBusy(false);
    }
  }, [photoBusy]);

  const onRemovePhoto = useCallback(async () => {
    if (photoBusy || !profile?.photoURL) return;
    setPhotoBusy(true);
    try {
      const updated = await api<UserProfile>('/user/profile', {
        method: 'PUT',
        json: { photoURL: '' },
      });
      setProfile(updated);
    } catch (e: any) {
      Alert.alert('Could not remove photo', e?.message ?? 'Try again');
    } finally {
      setPhotoBusy(false);
    }
  }, [photoBusy, profile?.photoURL]);

  // ── Phone verification (Day 17) ──────────────────────────
  // Two-step flow: tap "Verify" → POST /auth/send-otp-phone → reveal a
  // 6-digit input → POST /auth/verify-otp-phone with link=true. On success,
  // refresh the profile so the new verified phone shows up.
  const [verifying,    setVerifying]    = useState(false);
  const [verifyStep,   setVerifyStep]   = useState<'idle' | 'code' | 'done'>('idle');
  const [phoneCode,    setPhoneCode]    = useState('');
  const [verifyDevHint, setVerifyDevHint] = useState(false);

  const onSendPhoneOtp = useCallback(async () => {
    const p = phone.trim();
    if (!p) { Alert.alert('Enter your phone number first'); return; }
    setVerifying(true);
    try {
      const r = await sendPhoneOTP(p);
      setVerifyDevHint(!!r.dev);
      setVerifyStep('code');
      setPhoneCode('');
    } catch (e: any) {
      Alert.alert('Could not send code', e?.message ?? 'Try again');
    } finally {
      setVerifying(false);
    }
  }, [phone]);

  const onVerifyPhoneOtp = useCallback(async () => {
    if (!/^\d{6}$/.test(phoneCode)) { Alert.alert('Enter the 6-digit code'); return; }
    setVerifying(true);
    try {
      await verifyPhoneOTP(phone, phoneCode, { link: true });
      setVerifyStep('done');
      // Reload the profile to pick up the verified phone
      await load();
    } catch (e: any) {
      Alert.alert('Verification failed', e?.message ?? 'Try again');
    } finally {
      setVerifying(false);
    }
  }, [phone, phoneCode, load]);

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
        <ActivityIndicator color={colors.primary} size="large" />
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
        <TouchableOpacity
          onPress={onChangePhoto}
          activeOpacity={0.85}
          disabled={photoBusy}
        >
          <View style={S.avatar}>
            {profile?.photoURL && authHeader ? (
              <Image
                source={{
                  uri: attachmentUrl(profile.photoURL),
                  headers: { Authorization: authHeader },
                }}
                style={S.avatarImg}
              />
            ) : (
              <Text style={S.avatarTxt}>{avatarLetter}</Text>
            )}
            {photoBusy && (
              <View style={S.avatarBusy}>
                <ActivityIndicator color="#fff" />
              </View>
            )}
            <View style={S.avatarEditPill}>
              <Text style={S.avatarEditTxt}>📷</Text>
            </View>
          </View>
        </TouchableOpacity>
        {profile?.photoURL ? (
          <TouchableOpacity onPress={onRemovePhoto} disabled={photoBusy} hitSlop={8}>
            <Text style={S.removePhotoTxt}>Remove photo</Text>
          </TouchableOpacity>
        ) : (
          <Text style={S.subHint}>Tap the avatar to set a photo</Text>
        )}
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
          placeholderTextColor={colors.textDim}
          maxLength={100}
        />

        <Text style={S.label}>STATUS</Text>
        <TextInput
          style={S.input}
          value={status}
          onChangeText={setStatus}
          placeholder="e.g. Hey, I'm on VaultChat"
          placeholderTextColor={colors.textDim}
          maxLength={200}
        />

        <Text style={S.label}>PHONE (for chat discovery)</Text>
        <TextInput
          style={S.input}
          value={phone}
          onChangeText={setPhone}
          placeholder="+91 9876543210 or 9876543210"
          placeholderTextColor={colors.textDim}
          keyboardType="phone-pad"
          autoComplete="tel"
          maxLength={20}
        />
        <Text style={S.subHint}>
          Others can start a direct chat with you using this number.
          Leave blank to stay email-only.
        </Text>

        {/* Phone verification (Day 17) */}
        {verifyStep === 'idle' && (
          <TouchableOpacity
            onPress={onSendPhoneOtp}
            disabled={verifying || !phone.trim()}
            style={[S.verifyLink, (verifying || !phone.trim()) && { opacity: 0.5 }]}
            activeOpacity={0.7}
          >
            <Text style={S.verifyLinkTxt}>
              {verifying ? 'Sending…' : '📱 Verify this number via SMS'}
            </Text>
          </TouchableOpacity>
        )}
        {verifyStep === 'code' && (
          <View style={S.verifyBox}>
            <Text style={S.subHint}>Enter the 6-digit code we sent to {phone}.</Text>
            {verifyDevHint && (
              <Text style={[S.subHint, { color: colors.primary }]}>
                (Dev: SMS provider not configured — check the server logs for the code.)
              </Text>
            )}
            <TextInput
              style={[S.input, { letterSpacing: 6, textAlign: 'center', fontSize: 20 }]}
              value={phoneCode}
              onChangeText={(v) => setPhoneCode(v.replace(/\D/g, '').slice(0, 6))}
              placeholder="123456"
              placeholderTextColor={colors.textDim}
              keyboardType="number-pad"
              maxLength={6}
            />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity
                style={[S.btn, { flex: 1 }, verifying && S.btnOff]}
                onPress={onVerifyPhoneOtp}
                disabled={verifying}
                activeOpacity={0.85}
              >
                {verifying ? <ActivityIndicator color="#fff" /> : <Text style={S.btnTxt}>Verify</Text>}
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => { setVerifyStep('idle'); setPhoneCode(''); }}
                style={[S.btn, { flex: 0.5, backgroundColor: '#1F2937' }]}
                disabled={verifying}
                activeOpacity={0.85}
              >
                <Text style={S.btnTxt}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
        {verifyStep === 'done' && (
          <Text style={[S.subHint, { color: '#22C55E' }]}>✓ Phone verified</Text>
        )}

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

      <TouchableOpacity
        style={S.settingsBtn}
        onPress={() => router.push('/settings' as any)}
        activeOpacity={0.85}
      >
        <Text style={S.settingsBtnTxt}>Privacy & settings →</Text>
      </TouchableOpacity>

      <TouchableOpacity style={S.signOutBtn} onPress={onSignOut} activeOpacity={0.85}>
        <Text style={S.signOutTxt}>Sign out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function InfoRow({ k, v, small }: { k: string; v: string; small?: boolean }) {
  const S = useS();
  return (
    <View style={S.infoRow}>
      <Text style={S.infoK}>{k}</Text>
      <Text style={[S.infoV, small && S.infoVSmall]} numberOfLines={1}>{v}</Text>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:       { flex: 1, backgroundColor: c.bg },
  center:       { justifyContent: 'center', alignItems: 'center' },
  header:       { paddingHorizontal: 20, paddingTop: 56, paddingBottom: 12 },
  title:        { color: c.text, fontSize: 28, fontWeight: '800' },

  avatarWrap:   { alignItems: 'center', paddingVertical: 24, gap: 8 },
  avatar:       { width: 96, height: 96, borderRadius: 48, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarImg:    { width: '100%', height: '100%' },
  avatarTxt:    { color: '#fff', fontSize: 38, fontWeight: '800' },
  avatarBusy:   { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.4)' },
  avatarEditPill: { position: 'absolute', right: 0, bottom: 0, backgroundColor: c.surfaceSolid, borderRadius: 14, paddingHorizontal: 6, paddingVertical: 2, borderWidth: 2, borderColor: c.bg },
  avatarEditTxt:  { fontSize: 14 },
  removePhotoTxt: { color: c.danger, fontSize: 12, fontWeight: '600', marginTop: 4 },
  emailDisplay: { color: c.text, fontSize: 15, fontWeight: '600', marginTop: 8 },
  providerPill: { backgroundColor: c.card, borderColor: c.border, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, marginTop: 4 },
  providerPillTxt: { color: c.textDim, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1 },

  section:      { paddingHorizontal: 20, marginTop: 16, gap: 8 },
  label:        { color: c.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, marginTop: 8 },
  input:        { color: c.text, backgroundColor: c.card, borderColor: c.border, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
  subHint:      { color: c.textDim, fontSize: 12, lineHeight: 16, marginTop: -2 },
  btn:          { backgroundColor: c.primary, paddingVertical: 14, borderRadius: 24, alignItems: 'center', marginTop: 12 },
  btnOff:       { backgroundColor: '#374151' },
  btnTxt:       { color: '#fff', fontWeight: '700', fontSize: 14 },

  infoRow:      { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  infoK:        { color: c.textDim, fontSize: 13 },
  infoV:        { color: c.text, fontSize: 13, fontWeight: '600', maxWidth: '60%' },
  infoVSmall:   { fontSize: 11, fontWeight: '500' },

  verifyLink:     { paddingVertical: 8 },
  verifyLinkTxt:  { color: c.primary, fontWeight: '600', fontSize: 13 },
  verifyBox:      { marginTop: 8, gap: 8 },

  settingsBtn:    { marginHorizontal: 20, marginTop: 24, padding: 14, borderRadius: 24, borderWidth: 1, borderColor: c.border, backgroundColor: c.card, alignItems: 'center' },
  settingsBtnTxt: { color: c.text, fontWeight: '700', fontSize: 14 },
  signOutBtn:   { marginHorizontal: 20, marginTop: 12, padding: 14, borderRadius: 24, borderWidth: 1, borderColor: c.danger, alignItems: 'center' },
  signOutTxt:   { color: c.danger, fontWeight: '700', fontSize: 14 },
});
