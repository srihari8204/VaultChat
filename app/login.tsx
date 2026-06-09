/**
 * app/login.tsx — Phone-first login (WhatsApp/Telegram style).
 *
 * Flow: pick country code → enter number → Continue → sends OTP via
 * /auth/send-otp-phone → routes to /otp (flow='phone'). Google remains as a
 * secondary option. No permission prompts anywhere in this screen.
 */
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, FlatList, KeyboardAvoidingView, Modal,
  Platform, Pressable, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { Aurora } from '../constants/theme';
import { COUNTRIES, DEFAULT_COUNTRY, type Country } from '../constants/countries';
import { sendPhoneOTP, signInWithGoogle, configureGoogleSignIn } from './(constants)/authService';
import { markSetupComplete } from '../services/securityService';

export default function LoginScreen() {
  const router = useRouter();

  const [country, setCountry] = useState<Country>(DEFAULT_COUNTRY);
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [banner, setBanner] = useState<string | null>(null);

  const fade = useRef(new Animated.Value(0)).current;
  const slide = useRef(new Animated.Value(24)).current;

  useEffect(() => {
    try { configureGoogleSignIn(); } catch {}
    Animated.parallel([
      Animated.timing(fade, { toValue: 1, duration: 500, useNativeDriver: true }),
      Animated.spring(slide, { toValue: 0, tension: 50, friction: 9, useNativeDriver: true }),
    ]).start();
  }, [fade, slide]);

  const digits = phone.replace(/\D/g, '');
  const isValid = digits.length >= 6 && digits.length <= 15;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return COUNTRIES;
    return COUNTRIES.filter(c =>
      c.name.toLowerCase().includes(q) || c.dial.includes(q) || c.iso.toLowerCase().includes(q));
  }, [search]);

  const handleSend = async () => {
    if (!isValid || loading) return;
    setBanner(null);
    setLoading(true);
    try {
      const full = `${country.dial}${digits}`; // e.g. +9198…  backend normalises
      const r = await sendPhoneOTP(full);
      if (r?.dev) setBanner('Dev mode: enter code 123456'); // backend DEV_OTP
      router.push({ pathname: '/otp', params: { phone: full, flow: 'phone' } });
    } catch (err: any) {
      setBanner(err?.message ?? 'Failed to send code. Try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    setGoogleLoading(true);
    setBanner(null);
    try {
      await signInWithGoogle();
      try { await markSetupComplete(); } catch {}
      router.replace('/(tabs)/chats' as any);
    } catch (e: any) {
      if (!String(e?.message ?? '').toLowerCase().includes('cancel')) {
        setBanner(e?.message ?? 'Google sign-in failed');
      }
    } finally {
      setGoogleLoading(false);
    }
  };

  return (
    <View style={S.screen}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <Animated.View style={[S.body, { opacity: fade, transform: [{ translateY: slide }] }]}>
          {/* Header */}
          <View style={S.logoBadge}><Text style={S.logoTxt}>V</Text></View>
          <Text style={S.title}>Enter your{'\n'}phone number</Text>
          <Text style={S.subtitle}>We'll send you a verification code</Text>

          {/* Phone row */}
          <View style={S.phoneRow}>
            <TouchableOpacity style={S.ccBtn} onPress={() => setPickerOpen(true)} activeOpacity={0.8}>
              <Text style={S.ccFlag}>{country.flag}</Text>
              <Text style={S.ccDial}>{country.dial}</Text>
              <Text style={S.ccChevron}>▾</Text>
            </TouchableOpacity>
            <View style={S.phoneInputWrap}>
              <TextInput
                style={S.phoneInput}
                placeholder="98765 43210"
                placeholderTextColor={Aurora.textFaint}
                value={phone}
                onChangeText={setPhone}
                keyboardType="phone-pad"
                maxLength={18}
                autoFocus
                selectionColor={Aurora.primary}
              />
            </View>
          </View>

          {banner ? <Text style={S.banner}>{banner}</Text> : null}

          {/* Continue */}
          <TouchableOpacity
            style={[S.continueBtn, !isValid && S.continueOff]}
            onPress={handleSend}
            disabled={!isValid || loading}
            activeOpacity={0.85}
          >
            {loading
              ? <ActivityIndicator color="#04130D" />
              : <Text style={S.continueTxt}>Continue</Text>}
          </TouchableOpacity>

          {/* Divider */}
          <View style={S.dividerRow}>
            <View style={S.dividerLine} />
            <Text style={S.dividerTxt}>or</Text>
            <View style={S.dividerLine} />
          </View>

          {/* Google */}
          <TouchableOpacity style={S.googleBtn} onPress={handleGoogle} disabled={googleLoading} activeOpacity={0.85}>
            {googleLoading
              ? <ActivityIndicator color={Aurora.text} />
              : <><Text style={S.googleIcon}>G</Text><Text style={S.googleTxt}>Continue with Google</Text></>}
          </TouchableOpacity>

          <Text style={S.terms}>By continuing you agree to our Terms & Privacy Policy</Text>
        </Animated.View>
      </KeyboardAvoidingView>

      {/* Country picker */}
      <Modal visible={pickerOpen} animationType="slide" transparent onRequestClose={() => setPickerOpen(false)}>
        <Pressable style={S.modalBackdrop} onPress={() => setPickerOpen(false)} />
        <View style={S.modalSheet}>
          <View style={S.modalHandle} />
          <Text style={S.modalTitle}>Select country</Text>
          <TextInput
            style={S.searchInput}
            placeholder="Search country or code"
            placeholderTextColor={Aurora.textFaint}
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
            selectionColor={Aurora.primary}
          />
          <FlatList
            data={filtered}
            keyExtractor={(c, i) => `${c.iso}-${c.dial}-${i}`}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <TouchableOpacity
                style={S.countryRow}
                onPress={() => { setCountry(item); setPickerOpen(false); setSearch(''); }}
                activeOpacity={0.7}
              >
                <Text style={S.countryFlag}>{item.flag}</Text>
                <Text style={S.countryName}>{item.name}</Text>
                <Text style={S.countryDial}>{item.dial}</Text>
              </TouchableOpacity>
            )}
            style={{ maxHeight: 380 }}
          />
        </View>
      </Modal>
    </View>
  );
}

const S = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Aurora.bg },
  body: { flex: 1, paddingHorizontal: 28, paddingTop: 88 },

  logoBadge: {
    width: 56, height: 56, borderRadius: 18, backgroundColor: Aurora.primary,
    alignItems: 'center', justifyContent: 'center', marginBottom: 28,
  },
  logoTxt: { color: '#04130D', fontSize: 28, fontWeight: '900' },

  title: { color: Aurora.text, fontSize: 30, fontWeight: '800', lineHeight: 36, letterSpacing: -0.5 },
  subtitle: { color: Aurora.textDim, fontSize: 14, marginTop: 10, marginBottom: 32 },

  phoneRow: { flexDirection: 'row', gap: 10, marginBottom: 8 },
  ccBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, height: 56, paddingHorizontal: 14,
    borderRadius: 14, backgroundColor: Aurora.surface, borderWidth: 1, borderColor: Aurora.border,
  },
  ccFlag: { fontSize: 20 },
  ccDial: { color: Aurora.text, fontSize: 16, fontWeight: '700' },
  ccChevron: { color: Aurora.textDim, fontSize: 12 },
  phoneInputWrap: {
    flex: 1, height: 56, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 14,
    backgroundColor: Aurora.surface, borderWidth: 1, borderColor: Aurora.border,
  },
  phoneInput: { color: Aurora.text, fontSize: 18, fontWeight: '600', letterSpacing: 1 },

  banner: { color: Aurora.accent, fontSize: 13, marginTop: 4, marginBottom: 4 },

  continueBtn: {
    height: 56, borderRadius: 16, backgroundColor: Aurora.primary,
    alignItems: 'center', justifyContent: 'center', marginTop: 20,
  },
  continueOff: { opacity: 0.35 },
  continueTxt: { color: '#04130D', fontSize: 16, fontWeight: '800', letterSpacing: 0.3 },

  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 22 },
  dividerLine: { flex: 1, height: 1, backgroundColor: Aurora.border },
  dividerTxt: { color: Aurora.textFaint, fontSize: 13 },

  googleBtn: {
    height: 56, borderRadius: 16, backgroundColor: Aurora.surface, borderWidth: 1, borderColor: Aurora.border,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  googleIcon: { color: '#4285F4', fontSize: 18, fontWeight: '900' },
  googleTxt: { color: Aurora.text, fontSize: 15, fontWeight: '700' },

  terms: { color: Aurora.textFaint, fontSize: 12, textAlign: 'center', marginTop: 24, lineHeight: 18 },

  // Country picker modal
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' },
  modalSheet: {
    backgroundColor: Aurora.surfaceSolid, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: 20, paddingTop: 10, paddingBottom: 28,
    borderTopWidth: 1, borderColor: Aurora.border,
  },
  modalHandle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: Aurora.border, marginBottom: 14 },
  modalTitle: { color: Aurora.text, fontSize: 18, fontWeight: '800', marginBottom: 14 },
  searchInput: {
    height: 46, borderRadius: 12, backgroundColor: Aurora.surface, borderWidth: 1, borderColor: Aurora.border,
    paddingHorizontal: 14, color: Aurora.text, fontSize: 15, marginBottom: 10,
  },
  countryRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: Aurora.separator },
  countryFlag: { fontSize: 22 },
  countryName: { flex: 1, color: Aurora.text, fontSize: 15, fontWeight: '500' },
  countryDial: { color: Aurora.textDim, fontSize: 15, fontWeight: '700' },
});
