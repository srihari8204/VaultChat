/**
 * app/profile-setup.tsx — first-run profile (Obsidian Aurora).
 *
 * Phone-flow new users land here after OTP. Fields: Full Name (required),
 * Email (optional), Mobile (pre-filled, read-only), Profile Photo (gallery).
 * Continue saves to backend + AsyncStorage; Skip sets a default avatar +
 * "VaultUser". No blocking permission alerts — the image picker is called
 * directly and denial is shown as an inline banner.
 */
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator, Image, KeyboardAvoidingView, Platform, ScrollView,
  StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Aurora } from '../constants/theme';
import { api, getCachedUser, setCachedUser } from '../lib/api';
import { getPendingSignup } from './(constants)/authService';

export default function ProfileSetupScreen() {
  const router = useRouter();
  const { phone } = useLocalSearchParams<{ phone?: string }>();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [mobile, setMobile] = useState((phone as string) ?? '');
  const [photo, setPhoto] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  // Pre-fill from the cached user (phone, and name/email if present).
  useEffect(() => {
    (async () => {
      const u = await getCachedUser();
      if (u) {
        if (!phone && u.phone) setMobile(u.phone);
        if (u.name && u.name !== 'VaultUser') setName(u.name);
        if (u.email && !u.email.endsWith('@vaultchat.local')) setEmail(u.email);
      }
    })();
  }, [phone]);

  const pickPhoto = async () => {
    setBanner(null);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.7,
      });
      if (!result.canceled && result.assets?.[0]) setPhoto(result.assets[0].uri);
    } catch {
      // Permission denied / unavailable — never block the flow.
      setBanner('Couldn’t open photos. You can add one later in Settings.');
    }
  };

  const persist = async (finalName: string) => {
    // Local first (instant), then best-effort backend.
    await AsyncStorage.multiSet([
      ['vc_profile_name', finalName],
      ['vc_profile_email', email.trim()],
      ['vc_profile_photo', photo ?? ''],
    ]).catch(() => {});
    const cached = (await getCachedUser()) ?? {};
    await setCachedUser({ ...cached, name: finalName, email: email.trim() || cached.email, photoURL: photo ?? cached.photoURL });
    try {
      await api('/user/profile', {
        method: 'PUT',
        json: {
          name: finalName,
          ...(email.trim() ? { email: email.trim() } : {}),
        },
      });
    } catch { /* offline / route differences — local copy already saved */ }
  };

  const goNext = async () => {
    // Email multi-step signup keeps its own next step; phone flow → MPIN setup.
    const pending = await getPendingSignup();
    if (pending && !phone) router.replace('/security-questions' as any);
    else router.replace('/set-mpin' as any);
  };

  const handleContinue = async () => {
    if (!name.trim()) { setBanner('Please enter your name'); return; }
    setLoading(true);
    try { await persist(name.trim()); await goNext(); }
    finally { setLoading(false); }
  };

  const handleSkip = async () => {
    setLoading(true);
    try { await persist('VaultUser'); await goNext(); }
    finally { setLoading(false); }
  };

  const initial = (name.trim()[0] || 'V').toUpperCase();

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={S.screen}>
        <ScrollView contentContainerStyle={S.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Text style={S.title}>Set up your{'\n'}profile</Text>
          <Text style={S.subtitle}>Help your contacts recognise you</Text>

          {/* Avatar */}
          <TouchableOpacity style={S.avatarWrap} onPress={pickPhoto} activeOpacity={0.85}>
            {photo
              ? <Image source={{ uri: photo }} style={S.avatarImg} />
              : <View style={S.avatarPH}><Text style={S.avatarInitial}>{initial}</Text></View>}
            <View style={S.cameraBadge}><Text style={S.cameraIcon}>📷</Text></View>
          </TouchableOpacity>

          {/* Name */}
          <Text style={S.label}>Full name</Text>
          <TextInput
            style={S.input}
            placeholder="Your name"
            placeholderTextColor={Aurora.textFaint}
            value={name}
            onChangeText={setName}
            maxLength={40}
            selectionColor={Aurora.primary}
          />

          {/* Email (optional) */}
          <Text style={S.label}>Email <Text style={S.optional}>(optional)</Text></Text>
          <TextInput
            style={S.input}
            placeholder="you@example.com"
            placeholderTextColor={Aurora.textFaint}
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            selectionColor={Aurora.primary}
          />

          {/* Mobile (read-only) */}
          <Text style={S.label}>Mobile number</Text>
          <View style={[S.input, S.inputReadonly]}>
            <Text style={S.readonlyTxt}>{mobile || '—'}</Text>
          </View>

          {banner ? <Text style={S.banner}>{banner}</Text> : null}
        </ScrollView>

        <View style={S.footer}>
          <TouchableOpacity style={[S.continueBtn, loading && { opacity: 0.6 }]} onPress={handleContinue} disabled={loading} activeOpacity={0.85}>
            {loading ? <ActivityIndicator color="#04130D" /> : <Text style={S.continueTxt}>Continue</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={S.skipBtn} onPress={handleSkip} disabled={loading}>
            <Text style={S.skipTxt}>Skip for now</Text>
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const S = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Aurora.bg },
  scroll: { paddingHorizontal: 28, paddingTop: 72, paddingBottom: 20 },

  title: { color: Aurora.text, fontSize: 30, fontWeight: '800', lineHeight: 36 },
  subtitle: { color: Aurora.textDim, fontSize: 14, marginTop: 8, marginBottom: 28 },

  avatarWrap: { alignSelf: 'center', width: 112, height: 112, marginBottom: 28 },
  avatarImg: { width: 112, height: 112, borderRadius: 56 },
  avatarPH: { width: 112, height: 112, borderRadius: 56, backgroundColor: Aurora.surface, borderWidth: 1, borderColor: Aurora.border, alignItems: 'center', justifyContent: 'center' },
  avatarInitial: { color: Aurora.primary, fontSize: 44, fontWeight: '800' },
  cameraBadge: { position: 'absolute', bottom: 0, right: 0, width: 34, height: 34, borderRadius: 17, backgroundColor: Aurora.primary, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: Aurora.bg },
  cameraIcon: { fontSize: 14 },

  label: { color: Aurora.textDim, fontSize: 13, fontWeight: '600', marginBottom: 8, marginTop: 4 },
  optional: { color: Aurora.textFaint, fontWeight: '400' },
  input: { height: 54, borderRadius: 14, backgroundColor: Aurora.surface, borderWidth: 1, borderColor: Aurora.border, paddingHorizontal: 16, color: Aurora.text, fontSize: 16, marginBottom: 16, justifyContent: 'center' },
  inputReadonly: { backgroundColor: 'rgba(255,255,255,0.03)' },
  readonlyTxt: { color: Aurora.textDim, fontSize: 16, fontWeight: '600' },

  banner: { color: Aurora.accent, fontSize: 13, marginTop: 2 },

  footer: { paddingHorizontal: 28, paddingBottom: 28, paddingTop: 8 },
  continueBtn: { height: 56, borderRadius: 16, backgroundColor: Aurora.primary, alignItems: 'center', justifyContent: 'center' },
  continueTxt: { color: '#04130D', fontSize: 16, fontWeight: '800' },
  skipBtn: { alignItems: 'center', paddingVertical: 14 },
  skipTxt: { color: Aurora.textDim, fontSize: 14, fontWeight: '600' },
});
