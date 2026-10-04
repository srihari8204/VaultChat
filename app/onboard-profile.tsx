// app/onboard-profile.tsx — new-user profile. Mobile is display-only (it is the
// verified identity and cannot be edited here); EMAIL IS OPTIONAL and editable,
// kept only as a recovery address; DOB (age ≥ 13); first/last name; status (≤139,
// emoji allowed). "Next" → security questions. Nothing is sent yet — all held in
// the in-memory onboarding store until /auth/profile/init at the end of the chain.
//
// The email field used to sit at the top, greyed out, showing the address the
// user had just proven by OTP. It is now the only field on the screen that can
// be left blank on purpose, so it sits below the number it no longer outranks
// and says what it is for — an unlabelled optional field reads as a required
// one somebody forgot to mark.
//
// Step 1 of 3 of the sign-up chain. Its colours come from useAuthTheme(), which
// follows the selected appearance: the night auth palette in dark, the app's
// light palette in light (lib/useAuthTheme.ts).

import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Image, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BRAND_GRADIENT_CTA } from '../constants/theme';
import { BRAND_CTA_INK } from '../constants/brandCtaInk';
import { onboarding } from '../lib/onboarding';
import { Sheet, type SheetAction } from '../components/ui/Sheet';
import { AuthSky, BrandMark, KeyboardSafe, StepRail } from '../components/ui';
import { type AuthPalette } from '../constants/authTheme';
import { useAuthTheme } from '../lib/useAuthTheme';
import { permissionDenied } from '../lib/permissionDenied';
// Local-field date both ways: toISOString() stored the previous day east of
// UTC, and new Date('YYYY-MM-DD') showed it west of UTC (lib/onboardDate.ts).
import { fromLocalIsoDate, toLocalIsoDate } from '../lib/onboardDate';

function ageOf(d: Date): number {
  const n = new Date();
  let a = n.getFullYear() - d.getFullYear();
  const m = n.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && n.getDate() < d.getDate())) a--;
  return a;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function OnboardProfile() {
  const AUTH = useAuthTheme();
  const s = useMemo(() => makeStyles(AUTH), [AUTH]);
  const router = useRouter();
  const st = onboarding.get();

  const [email, setEmail] = useState(st.email);
  const [firstName, setFirstName] = useState(st.firstName);
  const [lastName, setLastName] = useState(st.lastName);
  const [status, setStatus] = useState(st.status);
  const [dob, setDob] = useState<Date | null>(fromLocalIsoDate(st.dob));
  const [showPicker, setShowPicker] = useState(false);
  const [pic, setPic] = useState<string | null>(st.profilePicLocalUri);
  // 4 buttons when a photo exists — over Android's 3-button ceiling.
  const [sheet, setSheet] = useState<{ title: string; message?: string; actions: SheetAction[] } | null>(null);
  const [photoErr, setPhotoErr] = useState<string | null>(null);
  // The picker can resolve after the user has gone back: no state writes then.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const pickFrom = async (source: 'camera' | 'gallery') => {
    try {
      const perm = source === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) { permissionDenied('Permission needed', `Allow ${source} access to set a photo.`, perm.canAskAgain); return; }
      const fn = source === 'camera' ? ImagePicker.launchCameraAsync : ImagePicker.launchImageLibraryAsync;
      const res = await fn({ allowsEditing: true, aspect: [1, 1], quality: 0.85 });   // square crop
      if (res.canceled || !res.assets?.[0]) return;
      const uri = res.assets[0].uri;
      onboarding.set({ profilePicLocalUri: uri });
      if (alive.current) setPic(uri);
    } catch {
      // No camera, a picker crash, an OEM that refuses the intent: the photo
      // is optional, so say so and let sign-up continue.
      if (alive.current) setPhotoErr(`Couldn't open the ${source === 'camera' ? 'camera' : 'gallery'}. You can add a photo later.`);
    }
  };
  const choosePhoto = () => setSheet({
    title: 'Profile photo',
    actions: [
      { label: 'Take photo', icon: 'camera-outline', onPress: () => { setPhotoErr(null); void pickFrom('camera'); } },
      { label: 'Choose from gallery', icon: 'images-outline', onPress: () => { setPhotoErr(null); void pickFrom('gallery'); } },
      ...(pic ? [{ label: 'Remove', icon: 'trash-outline' as const, destructive: true, onPress: () => { setPic(null); onboarding.set({ profilePicLocalUri: null }); } }] : []),
    ],
  });

  const ageOk = !!dob && ageOf(dob) >= 13;
  // Blank is fine; typed-and-wrong is not. A recovery address with a typo in it
  // is worse than none — it looks like a way back in until the day it is needed.
  const emailOk = !email.trim() || EMAIL_RE.test(email.trim());
  const valid = firstName.trim().length > 0 && ageOk && emailOk;
  // Email and age already say what is wrong next to their fields; a missing
  // required field has nothing to point at, so name it by the button.
  const missing = [!firstName.trim() && 'your first name', !dob && 'your date of birth'].filter(Boolean);
  const missingWhy = missing.length ? `Add ${missing.join(' and ')} to continue.` : null;

  const next = () => {
    if (!valid || !dob) return;
    onboarding.set({
      email: email.trim().toLowerCase(),
      firstName: firstName.trim(), lastName: lastName.trim(),
      status: status.slice(0, 139), dob: toLocalIsoDate(dob),
    });
    router.push('/onboard-security');
  };

  return (
    <View style={s.screen}>
      <AuthSky />
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardSafe style={{ flex: 1 }} >
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          <Pressable
            onPress={() => router.back()}
            style={s.back}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            hitSlop={10}
          >
            <Ionicons name="arrow-back" size={24} color={AUTH.text} />
          </Pressable>

          {/* The mark alone, not the wordmark: the landing screen already said
              the name and a second full lockup here reads as a splash rerun. */}
          <View style={s.head}>
            <BrandMark size={52} markOnly />
            <Text style={s.title} accessibilityRole="header">Set up your profile</Text>
            <Text style={s.step}>Step 1 of 3</Text>
            <StepRail step={1} style={s.rail} />
          </View>

          <TouchableOpacity
            style={s.avatarWrap}
            onPress={choosePhoto}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={pic ? 'Change profile photo' : 'Add a profile photo'}
          >
            {pic
              ? <Image source={{ uri: pic }} style={s.avatar} />
              : <View style={[s.avatar, s.avatarEmpty]}><Ionicons name="add" size={34} color={AUTH.dim} /></View>}
            <Text style={s.avatarHint}>{pic ? 'Change photo' : 'Add photo'}</Text>
          </TouchableOpacity>
          {!!photoErr && <Text style={[s.warn, { textAlign: 'center', marginBottom: 12 }]} accessibilityLiveRegion="polite">{photoErr}</Text>}

          {/* One card, not nine loose fields — the whole thing is a single
              question ("who are you"), same as the landing form. */}
          <View style={s.card}>
            {/* Verified, and the account's identity — not editable here. */}
            <Text style={s.labelFirst}>MOBILE</Text>
            <TextInput style={[s.input, s.disabled]} value={st.phone} editable={false} accessibilityLabel="Mobile number, verified" />

            <Text style={s.label}>EMAIL (OPTIONAL) — FOR ACCOUNT RECOVERY</Text>
            <TextInput
              style={s.input}
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              placeholderTextColor={AUTH.faint}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              inputMode="email"
              accessibilityLabel="Email, optional, for account recovery"
            />
            {!emailOk && <Text style={s.warn} accessibilityLiveRegion="polite">That doesn’t look like an email address.</Text>}

            <View style={s.rowTwo}>
              <View style={{ flex: 1 }}>
                <Text style={s.label}>FIRST NAME</Text>
                <TextInput style={s.input} value={firstName} onChangeText={setFirstName} placeholder="First" placeholderTextColor={AUTH.faint} accessibilityLabel="First name, required" autoComplete="given-name" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.label}>LAST NAME</Text>
                <TextInput style={s.input} value={lastName} onChangeText={setLastName} placeholder="Last" placeholderTextColor={AUTH.faint} accessibilityLabel="Last name, optional" autoComplete="family-name" />
              </View>
            </View>

            <Text style={s.label}>DATE OF BIRTH</Text>
            <TouchableOpacity
              style={s.input}
              onPress={() => setShowPicker(true)}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel={dob ? `Date of birth, ${dob.toLocaleDateString()}` : 'Date of birth, not set'}
              accessibilityHint="Opens a date picker"
            >
              <Text style={[s.inputTxt, !dob && s.inputPlaceholder]}>
                {dob ? dob.toLocaleDateString() : 'Select your date of birth'}
              </Text>
            </TouchableOpacity>
            {!!dob && !ageOk && <Text style={s.warn} accessibilityLiveRegion="polite">You must be at least 13.</Text>}
            {showPicker && (
              <DateTimePicker
                value={dob ?? new Date(2000, 0, 1)}
                mode="date"
                maximumDate={new Date()}
                display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                onChange={(_, d) => { setShowPicker(Platform.OS === 'ios'); if (d) setDob(d); }}
              />
            )}

            <Text style={s.label}>STATUS</Text>
            <TextInput
              style={s.input}
              value={status}
              onChangeText={(t) => setStatus(t.slice(0, 139))}
              placeholder="Hey there! I'm on crazzychat ✨"
              placeholderTextColor={AUTH.faint}
              maxLength={139}
              accessibilityLabel="Status, optional"
            />
            <Text style={s.counter}>{status.length}/139</Text>
          </View>

          {/* The one gradient on the screen. Blue → violet, never the cyan end:
              cyan is 1.63:1 against white and the label would vanish into it. */}
          <Pressable
            onPress={next}
            disabled={!valid}
            accessibilityRole="button"
            accessibilityLabel="Next, security questions"
            accessibilityHint={missingWhy ?? undefined}
            accessibilityState={{ disabled: !valid }}
            style={({ pressed }) => [s.ctaWrap, !valid && s.ctaOff, pressed && valid && s.ctaDown]}
          >
            <LinearGradient
              colors={[...BRAND_GRADIENT_CTA]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={s.cta}
            >
              <Text style={s.ctaTxt}>Next</Text>
            </LinearGradient>
          </Pressable>
          {!!missingWhy && <Text style={s.why}>{missingWhy}</Text>}
        </ScrollView>
      </KeyboardSafe>

      <Sheet
        visible={!!sheet}
        title={sheet?.title}
        message={sheet?.message}
        actions={sheet?.actions ?? []}
        onClose={() => setSheet(null)}
      />
    </View>
  );
}

const makeStyles = (AUTH: AuthPalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  body: { padding: 24, paddingTop: HEADER_TOP, paddingBottom: 48 },
  back: { marginBottom: 8, alignSelf: 'flex-start' },

  head: { alignItems: 'center', marginBottom: 8 },
  title: { color: AUTH.text, fontSize: 24, fontWeight: '900' },
  step: { color: AUTH.dim, fontSize: 12, fontWeight: '700', marginTop: 6 },
  rail: { width: 132, marginTop: 8 },

  avatarWrap: { alignItems: 'center', marginBottom: 16 },
  avatar: { width: 96, height: 96, borderRadius: 48 },
  avatarEmpty: { backgroundColor: AUTH.card, borderWidth: 1, borderColor: AUTH.stroke, alignItems: 'center', justifyContent: 'center' },
  avatarHint: { color: AUTH.cyan, fontSize: 13, fontWeight: '700', marginTop: 8 },

  card: {
    backgroundColor: AUTH.card,
    borderColor: AUTH.stroke,
    borderWidth: 1,
    borderRadius: 22,
    padding: 18,
  },
  label: { color: AUTH.dim, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginTop: 16, marginBottom: 6 },
  // Same as `label` without the top gap — the card's own padding is the gap.
  labelFirst: { color: AUTH.dim, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 6 },
  input: {
    minHeight: 52, borderRadius: 12, borderWidth: 1, borderColor: AUTH.stroke,
    backgroundColor: AUTH.hairline, paddingHorizontal: 14, paddingVertical: 14,
    color: AUTH.text, fontSize: 16,
  },
  inputTxt: { color: AUTH.text, fontSize: 16, paddingTop: 2 },
  inputPlaceholder: { color: AUTH.faint },
  disabled: { opacity: 0.6 },
  rowTwo: { flexDirection: 'row', gap: 12 },
  counter: { color: AUTH.faint, fontSize: 11, alignSelf: 'flex-end', marginTop: 4 },
  warn: { color: AUTH.danger, fontSize: 12, marginTop: 6 },
  why: { color: AUTH.dim, fontSize: 12, textAlign: 'center', marginTop: 10 },

  ctaWrap: { marginTop: 24, borderRadius: 16, overflow: 'hidden' },
  // 2026-09-18: minHeight, not height — same clip as `input` above already
  // guards against. At font scale 1.5 'Next' outgrew a pinned 56 and stranded
  // the user mid-signup. 56 is still the floor; the padding keeps the button
  // identical at scale 1.0 and lets it grow only when the label needs it.
  cta: { minHeight: 56, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
  ctaOff: { opacity: 0.38 },
  ctaDown: { opacity: 0.88 },
  ctaTxt: { color: BRAND_CTA_INK, fontSize: 16, fontWeight: '800', letterSpacing: 0.2 },
});
