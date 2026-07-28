// app/onboard-security.tsx — pick 5 distinct security questions + answers.
// Answers are held in the store and only sent (argon2-hashed server-side) after
// the MPIN is set. Each row excludes questions chosen by the others.

import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { SecurityQuestionRow } from '../components/auth/SecurityQuestionRow';
import { REQUIRED_SECURITY_ANSWERS } from '../constants/securityQuestionPool';
import { onboarding } from '../lib/onboarding';

type Slot = { questionCode: string | null; answer: string };

export default function OnboardSecurity() {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();

  const [slots, setSlots] = useState<Slot[]>(() =>
    Array.from({ length: REQUIRED_SECURITY_ANSWERS }, () => ({ questionCode: null, answer: '' })));

  const setSlot = (i: number, patch: Partial<Slot>) =>
    setSlots(prev => prev.map((sl, j) => (j === i ? { ...sl, ...patch } : sl)));

  const chosen = slots.map(sl => sl.questionCode).filter(Boolean) as string[];
  const valid = slots.every(sl => sl.questionCode && sl.answer.trim().length >= 2);

  const next = () => {
    if (!valid) return;
    onboarding.set({
      securityAnswers: slots.map(sl => ({ questionCode: sl.questionCode as string, answer: sl.answer.trim() })),
    });
    router.push('/onboard-mpin' as any);
  };

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          <TouchableOpacity onPress={() => router.back()} style={s.back}><Ionicons name="arrow-back" size={24} color={colors.text} /></TouchableOpacity>
          <Text style={s.title}>Security questions</Text>
          <Text style={s.step}>Step 2 of 3 · used to recover your account</Text>

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

          <TouchableOpacity style={[s.cta, !valid && s.ctaOff]} onPress={next} disabled={!valid} activeOpacity={0.85}>
            <Text style={s.ctaTxt}>Next</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  body: { padding: 24, paddingTop: 56, paddingBottom: 48 },
  back: { marginBottom: 8 },
  backTxt: { color: c.text, fontSize: 26 },
  title: { color: c.text, fontSize: 24, fontWeight: '900' },
  step: { color: c.primary, fontSize: 12, fontWeight: '700', marginTop: 4, marginBottom: 20 },
  cta: { marginTop: 16, height: 56, borderRadius: 16, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  ctaOff: { opacity: 0.4 },
  ctaTxt: { color: '#fff', fontSize: 16, fontWeight: '800' },
});
