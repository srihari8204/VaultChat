// app/(tabs)/profile.tsx — Phase 3a profile tab.
//
// Backed by /user/profile (Postgres). Edit name, About and photo; verify a
// phone number by SMS OTP; sign out.

import { useAuthHeader } from '../../hooks/useAuthHeader';
import { HEADER_TOP, SCREEN_BOTTOM } from '../../constants/layout';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import type { KeyboardTypeOptions } from 'react-native';
import { useTheme } from '../../lib/theme';
import { useVisionComfort } from '../../lib/visionComfort';
import { type Palette } from '../../constants/theme';
import {
  ActivityIndicator,
  Alert,
  Image,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput, ToastAndroid, TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { logoutUser, sendPhoneOTP, verifyPhoneOTP } from '../(constants)/authService';
import { api } from '../../lib/api';
import { resetTo } from '../../lib/authNav';
import { attachmentUrl, uploadAttachment } from '../../lib/chatService';
import { registerPushToken, unregisterPushToken } from '../../lib/push';
import { disconnect as disconnectSocket, getSocket } from '../../lib/socket';
import { readCache, writeCache } from '../../lib/localCache';
import { AppText as Text } from '../../components/ui/Text';
import { AuroraBackground, KeyboardSafe } from '../../components/ui';
import { initialOf } from '../../lib/format';
import { currentVersionName } from '../../lib/appVersion';
import { permissionDenied } from '../../lib/permissionDenied';
import { profileFromProtobuf } from '../../lib/userProfilePolicy';
import { userErrorText } from '../../lib/userErrorText';

interface UserProfile {
  id: string;
  // Optional, and usually absent: sign-in is mobile-only and email is a
  // thing you may add later. Typing it as `string` made every screen below
  // believe in a value the server does not send.
  email?: string | null;
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
  const { metrics } = useVisionComfort();
  return useMemo(() => makeStyles(colors, metrics), [colors, metrics]);
}

export default function ProfileScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  // The profile could not be fetched and nothing was cached: shown inline with
  // a retry, instead of an alert over an empty profile.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving,  setSaving]  = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const authHeader = useAuthHeader();

  const [name,   setName]   = useState('');
  const [status, setStatus] = useState('');
  const [phone,  setPhone]  = useState('');
  const [editing, setEditing] = useState<null | 'name' | 'status' | 'phone'>(null);
  // The profile fetch can settle after the tab unmounts (sign-out, deep link away).
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async () => {
    // Local-first: paint last-known profile instantly, then fetch fresh.
    //
    // The cache read is wrapped (2026-09-17): it used to sit OUTSIDE the
    // try/finally below, so a throwing readCache — a locked cache DEK is enough —
    // escaped before `finally { setLoading(false) }` could run and left the
    // Profile tab on a permanent spinner with no error and no retry.
    let cached: UserProfile | null = null;
    try {
      cached = await readCache<UserProfile>('my-profile');
      if (cached && alive.current) {
        setProfile(cached);
        setName(cached.name ?? '');
        setStatus(cached.status ?? '');
        setPhone(cached.phone ?? '');
        setLoading(false);
      }
    } catch { /* no cache is not an error; the network fetch below still runs */ }
    try {
      // Passing a decoder only OFFERS protobuf; a server that answers JSON is
      // parsed by the unchanged path in api(), with no second request. The
      // PUT calls below still send and receive JSON — they carry bodies.
      const p = await api<UserProfile>('/user/profile', { proto: profileFromProtobuf });
      writeCache('my-profile', p);
      if (!alive.current) return;
      setLoadError(null);
      setProfile(p);
      setName(p.name ?? '');
      setStatus(p.status ?? '');
      setPhone(p.phone ?? '');
    } catch (e: unknown) {
      // Keep cached data for offline read; only surface if nothing painted.
      if (!cached && alive.current) setLoadError(userErrorText(e, 'Check your connection and try again.'));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Saves ONE field. Sending all three meant saving the name also PUT an
  // edited, unverified phone; a phone change goes through the SMS OTP below.
  // Resolves true once saved, so a failed save keeps the editor open with the
  // typed text instead of collapsing onto a value the server never took.
  const onSave = useCallback(async (field: 'name' | 'status'): Promise<boolean> => {
    if (saving) return false;
    setSaving(true);
    try {
      const updated = await api<UserProfile>('/user/profile', {
        method: 'PUT',
        json: field === 'name' ? { name: name.trim() } : { status: status.trim() },
      });
      if (alive.current) setProfile(updated);
      return true;
    } catch (e: unknown) {
      Alert.alert('Save failed', userErrorText(e, 'Try again'));
      return false;
    } finally {
      if (alive.current) setSaving(false);
    }
  }, [name, status, saving]);

  // Inline per-row save (WhatsApp-style): commit then collapse the editor.
  // The phone row only collapses: the number is saved by verifying it.
  const saveField = useCallback(async () => {
    if ((editing === 'name' || editing === 'status') && !(await onSave(editing))) return;
    setEditing(null);
  }, [onSave, editing]);

  // ── Profile photo: pick → upload → PUT /user/profile { photoURL } ──
  const onChangePhoto = useCallback(async () => {
    if (photoBusy) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      permissionDenied('Permission needed', 'Allow photo library access to set your profile picture.', perm.canAskAgain);
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
      if (alive.current) setProfile(updated);
    } catch (e: unknown) {
      Alert.alert('Photo upload failed', userErrorText(e, 'Try again'));
    } finally {
      if (alive.current) setPhotoBusy(false);
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
      if (alive.current) setProfile(updated);
    } catch (e: unknown) {
      Alert.alert('Could not remove photo', userErrorText(e, 'Try again'));
    } finally {
      if (alive.current) setPhotoBusy(false);
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
  // Seconds until "Resend code" is offered again.
  const [resendIn, setResendIn] = useState(0);
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const onSendPhoneOtp = useCallback(async () => {
    const p = phone.trim();
    if (!p) { Alert.alert('Enter your phone number first'); return; }
    setVerifying(true);
    try {
      const r = await sendPhoneOTP(p);
      setVerifyDevHint(!!r.dev);
      setVerifyStep('code');
      setPhoneCode('');
      setResendIn(30);
    } catch (e: unknown) {
      Alert.alert('Could not send code', userErrorText(e, 'Try again'));
    } finally {
      if (alive.current) setVerifying(false);
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
    } catch (e: unknown) {
      Alert.alert('Verification failed', userErrorText(e, 'Try again'));
    } finally {
      if (alive.current) setVerifying(false);
    }
  }, [phone, phoneCode, load]);

  const onSignOut = useCallback(async () => {
    Alert.alert(
      'Sign out?',
      'Chats and media stored on this device will be removed. Anything still on the server syncs back when you sign in again.',
      [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: async () => {
          // These two cannot wait for logoutUser() to succeed: unregistering
          // the push token is an authenticated request, and logoutUser() drops
          // the token; a live socket would keep writing incoming messages into
          // the local store logoutUser() is purging. So they go first, and a
          // failed sign-out puts them back (best effort). The new socket gets
          // every lib/socket addPersistentListener listener (calls, the Chats
          // list); screens that use plain s.on() re-attach when they next mount.
          try { await unregisterPushToken(); } catch {}
          try { disconnectSocket(); } catch {}
          try {
            await logoutUser();
          } catch (e: unknown) {
            registerPushToken().catch(() => {});
            getSocket().catch(() => {});
            Alert.alert('Could not sign out', `${userErrorText(e, 'Something went wrong.')} You are still signed in. Try again.`);
            return;
          }
          // resetTo, not replace: anything pushed above the tabs stayed in the
          // history under the sign-in screen, so BACK re-entered the signed-out
          // account (lib/authNav.ts).
          resetTo('/onboard');
        }
      },
      ],
    );
  }, []);

  if (loading) {
    return (
      <View style={[S.screen, S.center]}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  // Leaving a row without saving puts back what the account actually holds —
  // by Cancel, or by starting to edit another row (which used to leave the
  // first row's unsaved text showing as if it were saved).
  const revertEditing = () => {
    if (editing === 'name') setName(profile?.name ?? '');
    else if (editing === 'status') setStatus(profile?.status ?? '');
    else if (editing === 'phone') { setPhone(profile?.phone ?? ''); setVerifyStep('idle'); setPhoneCode(''); }
  };
  const cancelEdit = () => { revertEditing(); setEditing(null); };
  const startEdit = (field: 'name' | 'status' | 'phone') => { if (editing !== field) revertEditing(); setEditing(field); };
  // The number the account already holds is verified (sign-in is by phone OTP);
  // only an edited number needs the SMS step.
  const isAccountPhone = !!profile?.phone && phone.trim() === String(profile.phone).trim();

  // Phone is deliberately not in this chain: its first character is '+' or a
  // digit, which is a worse avatar than the '?' placeholder.
  const avatarLetter = initialOf(profile?.name, profile?.email);

  return (
    <View style={S.screen}>
      <AuroraBackground variant="profile" />
    {/* NOT TAB_BAR_SPACE any more: this screen hides the floating bar
        (app/(tabs)/_layout.tsx), so reserving room for it left ~80px of dead
        space under Sign out. SCREEN_BOTTOM is the safe-area inset, which is all
        that is actually below the content now. */}
    <KeyboardSafe keyboardOnly>
    <ScrollView style={S.flex1} contentContainerStyle={S.scrollPad} keyboardShouldPersistTaps="handled">
      <View style={S.header}>
        {/* ADDED WITH THE TAB BAR'S REMOVAL (2026-09-23). This screen had no
            way off it except the bar — no header back, no router.back() in the
            file — so hiding the bar without this stranded it. Android's system
            back would still work; iOS has no hardware back, and a deep link
            straight to /profile leaves nothing to go back TO on either OS.
            Hence the fallback: go back if there is history, otherwise go to
            Chats, which is where the bar would have taken you. */}
        <TouchableOpacity
          onPress={() => { if (router.canGoBack()) router.back(); else router.replace('/(tabs)/chats'); }}
          hitSlop={11}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={S.backBtn}
        >
          <Ionicons name="arrow-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[S.title, { flex: 1 }]} accessibilityRole="header">Profile</Text>
        <TouchableOpacity onPress={() => router.push('/settings')} hitSlop={11} accessibilityRole="button" accessibilityLabel="Settings">
          <Ionicons name="settings-outline" size={22} color={colors.text} />
        </TouchableOpacity>
      </View>

      {/* Nothing cached and the fetch failed: say so, with a retry, instead of
          drawing an empty profile that looks like the account has no data.
          Settings and Sign out below stay reachable. */}
      {loadError && !profile ? (
        <View style={S.loadErr} accessibilityLiveRegion="polite">
          <Ionicons name="cloud-offline-outline" size={28} color={colors.danger} />
          <Text style={S.loadErrTitle}>Couldn’t load your profile</Text>
          <Text style={S.loadErrTxt}>{loadError}</Text>
          <TouchableOpacity style={S.loadErrBtn} onPress={() => { setLoading(true); load(); }} accessibilityRole="button" accessibilityLabel="Try loading your profile again">
            <Text style={S.btnTxt}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : (<>
      {/* Avatar with camera badge */}
      <View style={S.avatarWrap}>
        <TouchableOpacity onPress={onChangePhoto} activeOpacity={0.85} disabled={photoBusy}
          accessibilityRole="button" accessibilityLabel="Change profile photo" accessibilityState={{ busy: photoBusy, disabled: photoBusy }}>
          <View style={S.avatar}>
            {profile?.photoURL && authHeader ? (
              <Image source={{ uri: attachmentUrl(profile.photoURL), headers: { Authorization: authHeader } }} style={S.avatarImg} />
            ) : (
              <Text style={S.avatarTxt}>{avatarLetter}</Text>
            )}
            {photoBusy && <View style={S.avatarBusy}><ActivityIndicator color={colors.onPrimary} /></View>}
          </View>
          <View style={S.cameraBadge}><Ionicons name="camera" size={18} color={colors.onPrimary} /></View>
        </TouchableOpacity>
        <Text style={S.nameBig}>{name || 'Your name'}</Text>
        {/* Phone is the account; email is optional. Show whichever exists
            rather than an empty line where a subtitle used to be. */}
        {!!(profile?.phone || profile?.email) && (
          <Text style={S.emailDisplay}>{profile?.phone || profile?.email}</Text>
        )}
        {!!profile?.photoURL && (
          <TouchableOpacity
            onPress={() => Alert.alert('Remove profile photo?', 'People will see your initial instead.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Remove', style: 'destructive', onPress: () => { onRemovePhoto(); } },
            ])}
            disabled={photoBusy} hitSlop={12} accessibilityRole="button" accessibilityState={{ disabled: photoBusy }}>
            <Text style={S.removePhotoTxt}>Remove photo</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* VaultID — your @handle others use to add you (Trusted Contacts, QR) */}
      {!!profile?.vaultId && (
        <View style={[S.card, S.vaultCard]}>
          <Ionicons name="at-circle-outline" size={22} color={colors.primary} />
          <View style={S.flex1}>
            <Text style={S.vaultLabel}>Your VaultID</Text>
            <Text style={S.vaultId}>@{profile.vaultId}</Text>
          </View>
          <TouchableOpacity hitSlop={10} style={S.vaultBtn}
            onPress={async () => {
              await Clipboard.setStringAsync('@' + (profile?.vaultId ?? ''));
              // A copy needs no acknowledgement — the OS toast is the native one
              // and does not block the thumb. iOS has no toast, so it keeps the
              // alert rather than confirming nothing at all.
              if (Platform.OS === 'android') ToastAndroid.show('VaultID copied', ToastAndroid.SHORT);
              else Alert.alert('Copied', `@${profile?.vaultId} copied to clipboard.`);
            }} accessibilityRole="button" accessibilityLabel="Copy your VaultID">
            <Ionicons name="copy-outline" size={20} color={colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity hitSlop={10} style={S.vaultBtn} onPress={() => router.push('/qr-contact')} accessibilityRole="button" accessibilityLabel="Show your QR code">
            <Ionicons name="qr-code-outline" size={20} color={colors.primary} />
          </TouchableOpacity>
        </View>
      )}

      {/* WhatsApp-style editable info rows */}
      <View style={S.card}>
        <EditRow
          icon="person-outline" label="Name" value={name} placeholder="Your name"
          editing={editing === 'name'} onEdit={() => startEdit('name')} onCancel={cancelEdit}
          onChangeText={setName} onSave={saveField} saving={saving} maxLength={100}
        />
        <View style={S.rowSep} />
        <EditRow
          icon="information-circle-outline" label="About" value={status} placeholder="Hey, I'm on crazzychat"
          editing={editing === 'status'} onEdit={() => startEdit('status')} onCancel={cancelEdit}
          onChangeText={setStatus} onSave={saveField} saving={saving} maxLength={200} multiline
        />
        <View style={S.rowSep} />
        <EditRow
          icon="call-outline" label="Phone" value={phone} placeholder="Add phone number"
          editing={editing === 'phone'} onEdit={() => startEdit('phone')} onCancel={cancelEdit}
          onChangeText={(v) => {
            setPhone(v);
            // A code was sent to the OLD number: editing it must not let that
            // code verify the new one.
            if (verifyStep !== 'idle') { setVerifyStep('idle'); setPhoneCode(''); }
          }}
          onSave={saveField} saving={saving} maxLength={20} keyboardType="phone-pad"
          // Only the number the account actually has is verified — not an edit.
          verified={isAccountPhone}
        />
      </View>
      <Text style={S.cardHint}>Your phone number is your account — it is how people find you and start a direct chat.</Text>

      {/* CHANGING A NUMBER MOVES THE ACCOUNT — say so before they do it.
          Verifying a different number here is the change-number flow: the
          account, its chats and its history move to the new number and the old
          one stops signing in. That is what people want, but only if they know
          it is what is happening — silently reassigning an identity is how you
          get a support ticket instead of a happy user. */}
      {!!phone.trim() && !!profile?.phone && phone.trim() !== String(profile.phone).trim() && (
        <Text style={[S.cardHint, { color: colors.danger }]}>
          Verifying this will move your account to {phone.trim()} — your chats and history come
          with you, and {String(profile.phone).trim()} will no longer sign in.
        </Text>
      )}

      {/* Phone verification (kept) */}
      {!!phone.trim() && verifyStep !== 'done' && !(verifyStep === 'idle' && isAccountPhone) && (verifyStep === 'idle' ? (
        <TouchableOpacity onPress={onSendPhoneOtp} disabled={verifying || !phone.trim()} style={[S.verifyRow, (verifying || !phone.trim()) && { opacity: 0.5 }]} activeOpacity={0.7}
          accessibilityRole="button" accessibilityState={{ disabled: verifying || !phone.trim(), busy: verifying }}>
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
            accessibilityLabel="6-digit verification code" textContentType="oneTimeCode" autoComplete="sms-otp"
          />
          <View style={S.btnRow}>
            <TouchableOpacity style={[S.btn, S.flex1, verifying && S.btnOff]} onPress={onVerifyPhoneOtp} disabled={verifying} activeOpacity={0.85}
              accessibilityRole="button" accessibilityLabel="Verify" accessibilityState={{ disabled: verifying, busy: verifying }}>
              {verifying ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={S.btnTxt}>Verify</Text>}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setVerifyStep('idle'); setPhoneCode(''); }} style={[S.btn, S.btnGhost, { flex: 0.5 }]} disabled={verifying} activeOpacity={0.85}
              accessibilityRole="button" accessibilityState={{ disabled: verifying }}>
              <Text style={[S.btnTxt, { color: colors.text }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity onPress={onSendPhoneOtp} disabled={verifying || resendIn > 0} style={S.resendRow} hitSlop={6}
            accessibilityRole="button" accessibilityState={{ disabled: verifying || resendIn > 0 }}>
            <Text style={[S.verifyLinkTxt, (verifying || resendIn > 0) && { color: colors.textDim }]}>
              {resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}
            </Text>
          </TouchableOpacity>
        </View>
      ))}

      {/* Account (secondary) */}
      <Text style={S.groupLabel}>ACCOUNT</Text>
      <View style={S.card}>
        {/* Only meaningful once there IS an email; without one this row was a
            permanent em-dash that read like something had failed. */}
        {!!profile?.email && <InfoRow k="Email verified" v={profile.emailVerifiedAt ? '✓ Yes' : 'No'} />}
        <InfoRow k="PIN set" v={profile?.hasPin ? '✓ Yes' : 'No'} />
        <InfoRow k="Faces enrolled" v={String(profile?.faceCount ?? 0)} />
        <InfoRow k="User ID" v={profile?.id ?? '—'} small />
        <InfoRow k="Created" v={profile?.createdAt ? new Date(profile.createdAt).toLocaleString() : '—'} small />
      </View>
      </>)}

      {/* Actions */}
      <TouchableOpacity style={S.actionRow} onPress={() => router.push('/settings')} activeOpacity={0.85} accessibilityRole="button">
        <Ionicons name="settings-outline" size={20} color={colors.text} />
        <Text style={S.actionTxt}>Privacy & settings</Text>
        <Ionicons name="chevron-forward" size={18} color={colors.textDim} style={S.chevron} />
      </TouchableOpacity>
      <TouchableOpacity style={[S.actionRow, { borderColor: colors.danger }]} onPress={onSignOut} activeOpacity={0.85} accessibilityRole="button">
        <Ionicons name="log-out-outline" size={20} color={colors.danger} />
        <Text style={[S.actionTxt, { color: colors.danger }]}>Sign out</Text>
      </TouchableOpacity>

      {/* Version footer — long-press opens the hidden perf/debug screen. */}
      <TouchableOpacity
        onLongPress={() => router.push('/perf-debug')}
        delayLongPress={800}
        activeOpacity={1}
        accessibilityRole="text"
        accessibilityActions={[{ name: 'longpress', label: 'Open diagnostics' }]}
        onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'longpress') router.push('/perf-debug'); }}
        style={S.versionRow}
      >
        {/* Read, never hardcoded: this line said 1.1.1 while the build was
            1.2.15, and it is the number a user quotes in a bug report. */}
        <Text style={S.versionTxt}>
          {`crazzychat${currentVersionName() ? ` ${currentVersionName()}` : ''}`}
        </Text>
      </TouchableOpacity>
    </ScrollView>
    </KeyboardSafe>
    </View>
  );
}

// A WhatsApp-style info row: leading icon, label + value (or inline editor),
// trailing pencil → checkmark to save.
function EditRow({ icon, label, value, placeholder, editing, onEdit, onCancel, onChangeText, onSave, saving, multiline, keyboardType, maxLength, verified }: {
  icon: ComponentProps<typeof Ionicons>['name']; label: string; value: string; placeholder: string;
  editing: boolean; onEdit: () => void; onCancel: () => void; onChangeText: (t: string) => void; onSave: () => void; saving?: boolean;
  multiline?: boolean; keyboardType?: KeyboardTypeOptions; maxLength?: number; verified?: boolean;
}) {
  const { colors } = useTheme();
  const S = useS();
  return (
    <View style={S.editRow}>
      <Ionicons name={icon} size={22} color={colors.primary} style={S.editIcon} />
      <View style={S.flex1}>
        <Text style={S.editLabel}>{label}</Text>
        {editing ? (
          <TextInput
            style={S.editInput} value={value} onChangeText={onChangeText} placeholder={placeholder}
            placeholderTextColor={colors.textDim} multiline={multiline} keyboardType={keyboardType}
            maxLength={maxLength} autoFocus accessibilityLabel={label}
          />
        ) : (
          <View style={S.valueRow}>
            <Text style={[S.editValue, !value && { color: colors.textDim, fontWeight: '400' }]}>
              {value || placeholder}
            </Text>
            {verified && <Ionicons name="checkmark-circle" size={15} color={colors.success} />}
          </View>
        )}
      </View>
      {editing && (
        <TouchableOpacity onPress={onCancel} style={S.editPencil} disabled={saving}
          accessibilityRole="button" accessibilityLabel={`Cancel editing ${label.toLowerCase()}`} accessibilityState={{ disabled: !!saving }}>
          <Ionicons name="close" size={20} color={colors.textDim} />
        </TouchableOpacity>
      )}
      <TouchableOpacity onPress={editing ? onSave : onEdit} hitSlop={10} style={S.editPencil} disabled={saving}
        accessibilityRole="button" accessibilityLabel={`${editing ? 'Save' : 'Edit'} ${label.toLowerCase()}`} accessibilityState={{ disabled: !!saving, busy: editing && !!saving }}>
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
      {/* Account values wrap so identifiers and dates remain fully readable. */}
      <Text style={[S.infoV, small && S.infoVSmall]}>{v}</Text>
    </View>
  );
}

const makeStyles = (c: Palette, m: ReturnType<typeof useVisionComfort>['metrics']) => StyleSheet.create({
  screen:       { flex: 1, backgroundColor: c.bg },
  flex1:        { flex: 1 },
  scrollPad:    { paddingBottom: SCREEN_BOTTOM + 16 },
  backBtn:      { marginRight: 10 },
  btnRow:       { flexDirection: 'row', gap: 8 },
  chevron:      { marginLeft: 'auto' },
  valueRow:     { flexDirection: 'row', alignItems: 'center', gap: 6 },
  center:       { justifyContent: 'center', alignItems: 'center' },
  header:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: HEADER_TOP, paddingBottom: 8 },
  title:        { color: c.text, fontSize: 26, fontWeight: '800' },

  avatarWrap:   { alignItems: 'center', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 20 },
  avatar:       { width: 120, height: 120, borderRadius: 60, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarImg:    { width: '100%', height: '100%' },
  avatarTxt:    { color: c.onPrimary, fontSize: 46, fontWeight: '800' },
  avatarBusy:   { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: c.scrim },
  cameraBadge:  { position: 'absolute', right: 2, bottom: 2, width: 36, height: 36, borderRadius: 18, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: c.bg },
  nameBig:      { maxWidth: '100%', color: c.text, fontSize: 22, fontWeight: '800', marginTop: 14, textAlign: 'center' },
  emailDisplay: { maxWidth: '100%', color: c.textDim, fontSize: 13, marginTop: 2, textAlign: 'center' },
  removePhotoTxt: { color: c.danger, fontSize: 12, fontWeight: '600', marginTop: 8 },

  card:         { backgroundColor: c.glassSoft, borderRadius: 16, marginHorizontal: 16, marginTop: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke, overflow: 'hidden' },
  cardHint:     { color: c.textDim, fontSize: 12, lineHeight: 16, marginHorizontal: 22, marginTop: 8 },

  editRow:      { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14 * m.spacingScale, gap: 14 },
  editIcon:     { width: 24, textAlign: 'center' },
  editLabel:    { color: c.textDim, fontSize: 12, marginBottom: 2 },
  editValue:    { color: c.text, fontSize: 15.5, fontWeight: '600', flexShrink: 1 },
  editInput:    { color: c.text, fontSize: 15.5 * m.textScale, fontWeight: '600', padding: 0, borderBottomWidth: 1.5, borderBottomColor: c.primary, paddingBottom: 2 },
  editPencil:   { padding: 4, minWidth: 44 * m.controlScale, minHeight: 44 * m.controlScale, alignItems: 'center', justifyContent: 'center' },
  rowSep:       { height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginLeft: 54 },

  groupLabel:   { color: c.textDim, fontSize: 12, fontWeight: '700', letterSpacing: 1.2, marginHorizontal: 22, marginTop: 24, marginBottom: 2 },
  infoRow:      { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 4, paddingHorizontal: 16, paddingVertical: 12 * m.spacingScale, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  infoK:        { flexShrink: 1, marginRight: 12, color: c.textDim, fontSize: 13 },
  infoV:        { color: c.text, fontSize: 13, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  infoVSmall:   { fontSize: 12, fontWeight: '500' },

  input:        { color: c.text, backgroundColor: c.glassSoft, borderColor: c.glassStroke, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 * m.textScale },
  subHint:      { color: c.textDim, fontSize: 12, lineHeight: 16 },
  verifyRow:    { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 22, marginTop: 12, paddingVertical: 6, minHeight: 44 },
  verifyLinkTxt:{ color: c.primary, fontWeight: '700', fontSize: 13 },
  resendRow:    { alignSelf: 'center', minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  verifyBox:    { marginHorizontal: 16, marginTop: 10, gap: 8, backgroundColor: c.glassSoft, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke, padding: 14 },
  btn:          { backgroundColor: c.primary, paddingVertical: 14, borderRadius: 16, alignItems: 'center' },
  btnGhost:     { backgroundColor: c.glassSoft },
  btnOff:       { opacity: 0.5 },
  btnTxt:       { color: c.onPrimary, fontWeight: '800', fontSize: 14 },

  actionRow:    { flexDirection: 'row', alignItems: 'center', gap: 14, marginHorizontal: 16, marginTop: 12, paddingHorizontal: 16, paddingVertical: 15 * m.spacingScale, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke, backgroundColor: c.glassSoft },
  actionTxt:    { flex: 1, color: c.text, fontWeight: '700', fontSize: 15 },

  vaultCard:    { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14, gap: 12 },
  vaultLabel:   { color: c.textDim, fontSize: 12 },
  vaultId:      { color: c.text, fontSize: 15, fontWeight: '700' },
  // 32dp glyph box + hitSlop 10 = a 52dp target.
  vaultBtn:     { padding: 6 },
  versionRow:   { alignItems: 'center', paddingVertical: 24 },
  versionTxt:   { color: c.textDim, fontSize: 12 },
  loadErr:      { marginHorizontal: 16, marginTop: 12, padding: 16, gap: 10, alignItems: 'center', borderRadius: 16, borderWidth: 1, borderColor: c.danger, backgroundColor: c.glassSoft },
  loadErrTitle: { color: c.text, fontSize: 15, fontWeight: '700', textAlign: 'center' },
  loadErrTxt:   { color: c.textDim, fontSize: 13, lineHeight: 18, textAlign: 'center' },
  loadErrBtn:   { minHeight: 44, paddingHorizontal: 24, justifyContent: 'center', borderRadius: 14, backgroundColor: c.primary },
});
