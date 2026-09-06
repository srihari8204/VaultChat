// app/(tabs)/profile.tsx — Phase 3a profile tab.
//
// Backed by /user/profile (Postgres). Edit name + status, sign out.
// Photo upload is deferred to Phase 4 (file storage).

import { HEADER_TOP, TAB_BAR_SPACE } from '../../constants/layout';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState, type ComponentProps } from 'react';
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
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { logoutUser, sendPhoneOTP, verifyPhoneOTP } from '../(constants)/authService';
import { api, getAccessToken } from '../../lib/api';
import { attachmentUrl, uploadAttachment } from '../../lib/chatService';
import { unregisterPushToken } from '../../lib/push';
import { disconnect as disconnectSocket } from '../../lib/socket';
import { readCache, writeCache } from '../../lib/localCache';
import { AuroraBackground } from '../../components/ui';

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
  vaultId?: string | null;
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
  const [editing, setEditing] = useState<null | 'name' | 'status' | 'phone'>(null);

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
    // Local-first: paint last-known profile instantly, then fetch fresh.
    const cached = await readCache<UserProfile>('my-profile');
    if (cached) {
      setProfile(cached);
      setName(cached.name ?? '');
      setStatus(cached.status ?? '');
      setPhone(cached.phone ?? '');
      setLoading(false);
    }
    try {
      const p = await api<UserProfile>('/user/profile');
      setProfile(p);
      setName(p.name ?? '');
      setStatus(p.status ?? '');
      setPhone(p.phone ?? '');
      writeCache('my-profile', p);
    } catch (e: any) {
      // Keep cached data for offline read; only surface if nothing painted.
      if (!cached) Alert.alert('Profile load failed', e?.message ?? 'Try again');
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
    } catch (e: any) {
      Alert.alert('Save failed', e?.message ?? 'Try again');
    } finally {
      setSaving(false);
    }
  }, [name, status, phone, saving]);

  // Inline per-row save (WhatsApp-style): commit then collapse the editor.
  const saveField = useCallback(async () => { await onSave(); setEditing(null); }, [onSave]);

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
      // 'profile' keeps this out of chat retention entirely — an avatar is
      // kept until the user changes or deletes it, never aged out.
      const up       = await uploadAttachment(asset.uri, filename, mime, { purpose: 'profile' });
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
    Alert.alert(
      'Sign out?',
      'Chats and media stored on this device will be removed. Anything still on the server syncs back when you sign in again.',
      [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: async () => {
          try { await unregisterPushToken(); } catch {}
          try { disconnectSocket(); } catch {}
          await logoutUser();
          router.replace('/onboard' as any);
        }
      },
      ],
    );
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
    <View style={{ flex: 1 }}>
      <AuroraBackground variant="profile" />
    <ScrollView style={S.screen} contentContainerStyle={{ paddingBottom: TAB_BAR_SPACE + 16 }}>
      <View style={S.header}>
        <Text style={S.title}>Profile</Text>
        <TouchableOpacity onPress={() => router.push('/settings' as any)} hitSlop={8}>
          <Ionicons name="settings-outline" size={22} color={colors.text} />
        </TouchableOpacity>
      </View>

      {/* Avatar with camera badge */}
      <View style={S.avatarWrap}>
        <TouchableOpacity onPress={onChangePhoto} activeOpacity={0.85} disabled={photoBusy}>
          <View style={S.avatar}>
            {profile?.photoURL && authHeader ? (
              <Image source={{ uri: attachmentUrl(profile.photoURL), headers: { Authorization: authHeader } }} style={S.avatarImg} />
            ) : (
              <Text style={S.avatarTxt}>{avatarLetter}</Text>
            )}
            {photoBusy && <View style={S.avatarBusy}><ActivityIndicator color="#fff" /></View>}
          </View>
          <View style={S.cameraBadge}><Ionicons name="camera" size={18} color="#fff" /></View>
        </TouchableOpacity>
        <Text style={S.nameBig} numberOfLines={1}>{name || 'Your name'}</Text>
        <Text style={S.emailDisplay} numberOfLines={1}>{profile?.email}</Text>
        {!!profile?.photoURL && (
          <TouchableOpacity onPress={onRemovePhoto} disabled={photoBusy} hitSlop={8}>
            <Text style={S.removePhotoTxt}>Remove photo</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* VaultID — your @handle others use to add you (Trusted Contacts, QR) */}
      {!!profile?.vaultId && (
        <View style={[S.card, { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14, gap: 12 }]}>
          <Ionicons name="at-circle-outline" size={22} color={colors.primary} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.textDim, fontSize: 12 }}>Your VaultID</Text>
            <Text style={{ color: colors.text, fontSize: 15, fontWeight: '700' }}>@{profile.vaultId}</Text>
          </View>
          <TouchableOpacity hitSlop={10} style={{ padding: 6 }}
            onPress={async () => { await Clipboard.setStringAsync('@' + (profile?.vaultId ?? '')); Alert.alert('Copied', `@${profile?.vaultId} copied to clipboard.`); }}>
            <Ionicons name="copy-outline" size={20} color={colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity hitSlop={10} style={{ padding: 6 }} onPress={() => router.push('/qr-contact' as any)}>
            <Ionicons name="qr-code-outline" size={20} color={colors.primary} />
          </TouchableOpacity>
        </View>
      )}

      {/* WhatsApp-style editable info rows */}
      <View style={S.card}>
        <EditRow
          icon="person-outline" label="Name" value={name} placeholder="Your name"
          editing={editing === 'name'} onEdit={() => setEditing('name')}
          onChangeText={setName} onSave={saveField} saving={saving} maxLength={100}
        />
        <View style={S.rowSep} />
        <EditRow
          icon="information-circle-outline" label="About" value={status} placeholder="Hey, I'm on VaultChat"
          editing={editing === 'status'} onEdit={() => setEditing('status')}
          onChangeText={setStatus} onSave={saveField} saving={saving} maxLength={200} multiline
        />
        <View style={S.rowSep} />
        <EditRow
          icon="call-outline" label="Phone" value={phone} placeholder="Add phone number"
          editing={editing === 'phone'} onEdit={() => setEditing('phone')}
          onChangeText={setPhone} onSave={saveField} saving={saving} maxLength={20} keyboardType="phone-pad"
          verified={verifyStep === 'done' || !!profile?.phone}
        />
      </View>
      <Text style={S.cardHint}>Your phone lets others start a direct chat with you. Leave blank to stay email-only.</Text>

      {/* Phone verification (kept) */}
      {!!phone.trim() && verifyStep !== 'done' && (verifyStep === 'idle' ? (
        <TouchableOpacity onPress={onSendPhoneOtp} disabled={verifying || !phone.trim()} style={[S.verifyRow, (verifying || !phone.trim()) && { opacity: 0.5 }]} activeOpacity={0.7}>
          <Ionicons name="shield-checkmark-outline" size={18} color={colors.primary} />
          <Text style={S.verifyLinkTxt}>{verifying ? 'Sending…' : 'Verify this number via SMS'}</Text>
        </TouchableOpacity>
      ) : (
        <View style={S.verifyBox}>
          <Text style={S.subHint}>Enter the 6-digit code we sent to {phone}.</Text>
          {verifyDevHint && <Text style={[S.subHint, { color: colors.primary }]}>(Dev: SMS provider not configured — check the server logs for the code.)</Text>}
          <TextInput
            style={[S.input, { letterSpacing: 6, textAlign: 'center', fontSize: 20 }]}
            value={phoneCode} onChangeText={(v) => setPhoneCode(v.replace(/\D/g, '').slice(0, 6))}
            placeholder="123456" placeholderTextColor={colors.textDim} keyboardType="number-pad" maxLength={6}
          />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity style={[S.btn, { flex: 1 }, verifying && S.btnOff]} onPress={onVerifyPhoneOtp} disabled={verifying} activeOpacity={0.85}>
              {verifying ? <ActivityIndicator color="#fff" /> : <Text style={S.btnTxt}>Verify</Text>}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setVerifyStep('idle'); setPhoneCode(''); }} style={[S.btn, S.btnGhost, { flex: 0.5 }]} disabled={verifying} activeOpacity={0.85}>
              <Text style={[S.btnTxt, { color: colors.text }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      ))}

      {/* Account (secondary) */}
      <Text style={S.groupLabel}>ACCOUNT</Text>
      <View style={S.card}>
        <InfoRow k="Email verified" v={profile?.emailVerifiedAt ? '✓ Yes' : '—'} />
        <InfoRow k="PIN set" v={profile?.hasPin ? '✓ Yes' : 'No'} />
        <InfoRow k="Faces enrolled" v={String(profile?.faceCount ?? 0)} />
        <InfoRow k="User ID" v={profile?.id ?? '—'} small />
        <InfoRow k="Created" v={profile?.createdAt ? new Date(profile.createdAt).toLocaleString() : '—'} small />
      </View>

      {/* Actions */}
      <TouchableOpacity style={S.actionRow} onPress={() => router.push('/settings' as any)} activeOpacity={0.85}>
        <Ionicons name="settings-outline" size={20} color={colors.text} />
        <Text style={S.actionTxt}>Privacy & settings</Text>
        <Ionicons name="chevron-forward" size={18} color={colors.textDim} style={{ marginLeft: 'auto' }} />
      </TouchableOpacity>
      <TouchableOpacity style={[S.actionRow, { borderColor: colors.danger }]} onPress={onSignOut} activeOpacity={0.85}>
        <Ionicons name="log-out-outline" size={20} color={colors.danger} />
        <Text style={[S.actionTxt, { color: colors.danger }]}>Sign out</Text>
      </TouchableOpacity>

      {/* Version footer — long-press opens the hidden perf/debug screen. */}
      <TouchableOpacity
        onLongPress={() => router.push('/perf-debug' as any)}
        delayLongPress={800}
        activeOpacity={1}
        style={{ alignItems: 'center', paddingVertical: 24 }}
      >
        <Text style={{ color: colors.textDim, fontSize: 12 }}>VaultChat 1.1.1</Text>
      </TouchableOpacity>
    </ScrollView>
    </View>
  );
}

// A WhatsApp-style info row: leading icon, label + value (or inline editor),
// trailing pencil → checkmark to save.
function EditRow({ icon, label, value, placeholder, editing, onEdit, onChangeText, onSave, saving, multiline, keyboardType, maxLength, verified }: {
  icon: ComponentProps<typeof Ionicons>['name']; label: string; value: string; placeholder: string;
  editing: boolean; onEdit: () => void; onChangeText: (t: string) => void; onSave: () => void; saving?: boolean;
  multiline?: boolean; keyboardType?: any; maxLength?: number; verified?: boolean;
}) {
  const { colors } = useTheme();
  const S = useS();
  return (
    <View style={S.editRow}>
      <Ionicons name={icon} size={22} color={colors.primary} style={S.editIcon} />
      <View style={{ flex: 1 }}>
        <Text style={S.editLabel}>{label}</Text>
        {editing ? (
          <TextInput
            style={S.editInput} value={value} onChangeText={onChangeText} placeholder={placeholder}
            placeholderTextColor={colors.textDim} multiline={multiline} keyboardType={keyboardType}
            maxLength={maxLength} autoFocus
          />
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={[S.editValue, !value && { color: colors.textDim, fontWeight: '400' }]} numberOfLines={multiline ? 2 : 1}>
              {value || placeholder}
            </Text>
            {verified && <Ionicons name="checkmark-circle" size={15} color={colors.success} />}
          </View>
        )}
      </View>
      <TouchableOpacity onPress={editing ? onSave : onEdit} hitSlop={10} style={S.editPencil} disabled={saving}>
        {editing && saving ? <ActivityIndicator size="small" color={colors.primary} /> : (
          <Ionicons name={editing ? 'checkmark' : 'pencil'} size={20} color={editing ? colors.primary : colors.textDim} />
        )}
      </TouchableOpacity>
    </View>
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
  header:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: HEADER_TOP, paddingBottom: 8 },
  title:        { color: c.text, fontSize: 26, fontWeight: '800' },

  avatarWrap:   { alignItems: 'center', paddingTop: 16, paddingBottom: 20 },
  avatar:       { width: 120, height: 120, borderRadius: 60, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarImg:    { width: '100%', height: '100%' },
  avatarTxt:    { color: '#fff', fontSize: 46, fontWeight: '800' },
  avatarBusy:   { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.4)' },
  cameraBadge:  { position: 'absolute', right: 2, bottom: 2, width: 36, height: 36, borderRadius: 18, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: c.bg },
  nameBig:      { color: c.text, fontSize: 22, fontWeight: '800', marginTop: 14 },
  emailDisplay: { color: c.textDim, fontSize: 13, marginTop: 2 },
  removePhotoTxt: { color: c.danger, fontSize: 12, fontWeight: '600', marginTop: 8 },

  card:         { backgroundColor: c.glassSoft, borderRadius: 16, marginHorizontal: 16, marginTop: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke, overflow: 'hidden' },
  cardHint:     { color: c.textDim, fontSize: 12, lineHeight: 16, marginHorizontal: 22, marginTop: 8 },

  editRow:      { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, gap: 14 },
  editIcon:     { width: 24, textAlign: 'center' },
  editLabel:    { color: c.textDim, fontSize: 12, marginBottom: 2 },
  editValue:    { color: c.text, fontSize: 15.5, fontWeight: '600' },
  editInput:    { color: c.text, fontSize: 15.5, fontWeight: '600', padding: 0, borderBottomWidth: 1.5, borderBottomColor: c.primary, paddingBottom: 2 },
  editPencil:   { padding: 4, minWidth: 26, alignItems: 'center' },
  rowSep:       { height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginLeft: 54 },

  groupLabel:   { color: c.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, marginHorizontal: 22, marginTop: 24, marginBottom: 2 },
  infoRow:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  infoK:        { color: c.textDim, fontSize: 13 },
  infoV:        { color: c.text, fontSize: 13, fontWeight: '600', maxWidth: '60%' },
  infoVSmall:   { fontSize: 11, fontWeight: '500' },

  input:        { color: c.text, backgroundColor: c.glassSoft, borderColor: c.glassStroke, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
  subHint:      { color: c.textDim, fontSize: 12, lineHeight: 16 },
  verifyRow:    { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 22, marginTop: 12, paddingVertical: 6 },
  verifyLinkTxt:{ color: c.primary, fontWeight: '700', fontSize: 13 },
  verifyBox:    { marginHorizontal: 16, marginTop: 10, gap: 8, backgroundColor: c.glassSoft, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke, padding: 14 },
  btn:          { backgroundColor: c.primary, paddingVertical: 14, borderRadius: 16, alignItems: 'center' },
  btnGhost:     { backgroundColor: c.glassSoft },
  btnOff:       { opacity: 0.5 },
  btnTxt:       { color: '#fff', fontWeight: '800', fontSize: 14 },

  actionRow:    { flexDirection: 'row', alignItems: 'center', gap: 14, marginHorizontal: 16, marginTop: 12, paddingHorizontal: 16, paddingVertical: 15, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke, backgroundColor: c.glassSoft },
  actionTxt:    { color: c.text, fontWeight: '700', fontSize: 15 },
});
