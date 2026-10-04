// app/onboard-security.tsx — pick REQUIRED_SECURITY_ANSWERS distinct security
// questions + answers.
// Answers are held in the store and only sent (argon2-hashed server-side) after
// the MPIN is set. Each row excludes questions chosen by the others.
//
// Step 2 of 3, using the shared adaptive auth palette.

import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BRAND_GRADIENT_CTA } from '../constants/theme';
import { MIN_ANSWER, SecurityQuestionRow } from '../components/auth/SecurityQuestionRow';
import { REQUIRED_SECURITY_ANSWERS } from '../constants/securityQuestionPool';
import { onboarding } from '../lib/onboarding';
import { AuthSky, BrandMark, KeyboardSafe, StepRail } from '../components/ui';
import { type AuthPalette } from '../constants/authTheme';
import { useAuthTheme } from '../lib/useAuthTheme';

type Slot = { questionCode: string | null; answer: string };

export default function OnboardSecurity() {
  const AUTH = useAuthTheme();
  const s = useMemo(() => makeStyles(AUTH), [AUTH]);
  const router = useRouter();

  const [slots, setSlots] = useState<Slot[]>(() =>
    Array.from({ length: REQUIRED_SECURITY_ANSWERS }, () => ({ questionCode: null, answer: '' })));

  const setSlot = (i: number, patch: Partial<Slot>) =>
    setSlots(prev => prev.map((sl, j) => (j === i ? { ...sl, ...patch } : sl)));

  const chosen = slots.map(sl => sl.questionCode).filter(Boolean) as string[];
  const valid = slots.every(sl => sl.questionCode && sl.answer.trim().length >= MIN_ANSWER);

  const next = () => {
    if (!valid) return;
    onboarding.set({
      securityAnswers: slots.map(sl => ({ questionCode: sl.questionCode as string, answer: sl.answer.trim() })),
    });
    router.push('/onboard-mpin' as any);
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

          <View style={s.head}>
            <BrandMark size={52} markOnly />
            <Text style={s.title} accessibilityRole="header">Security questions</Text>
            <Text style={s.step}>Step 2 of 3 · used to recover your account</Text>
            <StepRail step={2} style={s.rail} />
          </View>

          {/* All the rows in one card: they are one answer to one question
              ("how do we know it's you"), not five separate settings. */}
          <View style={s.card}>
            {slots.map((sl, i) => (
              <SecurityQuestionRow
                key={i}
                index={i}
                selectedCode={sl.questionCode}
                answer={sl.answer}
                excludeCodes={chosen.filter(c => c !== sl.questionCode)}
                onSelect={(code) => setSlot(i, { questionCode: code })}
                onAnswer={(answer) => setSlot(i, { answer })}
              />
            ))}
          </View>

          <Pressable
            onPress={next}
            disabled={!valid}
            accessibilityRole="button"
            accessibilityLabel="Next, create your MPIN"
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
        </ScrollView>
      </KeyboardSafe>
    </View>
  );
}

const makeStyles = (AUTH: AuthPalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  body: { padding: 24, paddingTop: HEADER_TOP, paddingBottom: 48 },
  back: { marginBottom: 8, alignSelf: 'flex-start' },

  head: { alignItems: 'center', marginBottom: 16 },
  title: { color: AUTH.text, fontSize: 24, fontWeight: '900' },
  step: { color: AUTH.dim, fontSize: 12, fontWeight: '700', marginTop: 6, textAlign: 'center' },
  rail: { width: 132, marginTop: 8 },

  card: {
    backgroundColor: AUTH.card,
    borderColor: AUTH.stroke,
    borderWidth: 1,
    borderRadius: 22,
    padding: 18,
    // The rows carry their own bottom margin; trim the last one's.
    paddingBottom: 2,
  },

  ctaWrap: { marginTop: 24, borderRadius: 16, overflow: 'hidden' },
  // 2026-09-18: minHeight, not height. A pinned 56 clipped the 16sp label at
  // font scale 1.5, and this is the step that sets the MPIN — nobody should be
  // blocked from finishing it because their text is large. 56 remains the
  // floor and the padding keeps the button identical at scale 1.0.
  cta: { minHeight: 56, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
  ctaOff: { opacity: 0.38 },
  ctaDown: { opacity: 0.88 },
  ctaTxt: { color: '#fff', fontSize: 16, fontWeight: '800', letterSpacing: 0.2 },
});
