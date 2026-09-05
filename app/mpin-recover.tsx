// app/mpin-recover.tsx — Forgot MPIN. Phase 1: answer your security questions
// (≥3 must match) → recovery ticket. Phase 2: set + confirm a new 6-digit MPIN
// (weak rejected) → logged in → Chats.

import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Animated, KeyboardAvoidingView, Platform,
  ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { questionLabel } from '../constants/securityQuestionPool';
import { MpinInput } from '../components/auth/MpinInput';
import {
  getRecoveryQuestions, verifyRecoveryAnswers, recoverMpin, onboarding, onboardingError,
} from '../lib/onboarding';
import { AuroraBackground } from '../components/ui';

export default function MpinRecover() {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const { userId } = useLocalSearchParams<{ userId: string }>();

  const [phase, setPhase] = useState<'loading' | 'answer' | 'setmpin'>('loading');
  const [questions, setQuestions] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [ticket, setTicket] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // set-mpin phase
  const [mpinPhase, setMpinPhase] = useState<'set' | 'confirm'>('set');
  const [first, setFirst] = useState('');
  const [confirm, setConfirm] = useState('');
  const shake = useRef(new Animated.Value(0)).current;
  const doShake = () => {
    shake.setValue(0);
    Animated.sequence([12, -12, 8, -8, 0].map(t => Animated.timing(shake, { toValue: t, duration: 55, useNativeDriver: true }))).start();
  };

  useEffect(() => {
    (async () => {
      try {
        const qs = await getRecoveryQuestions(userId);
        if (!qs.length) { Alert.alert('No questions', 'No security questions are set for this account.'); router.back(); return; }
        setQuestions(qs); setPhase('answer');
      } catch (e: any) { Alert.alert('Error', onboardingError(e, 'Could not load')); router.back(); }
    })();
  }, [userId]);

  const filled = questions.filter(q => (answers[q] ?? '').trim().length >= 2).length;

  const verify = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const payload = questions
        .filter(q => (answers[q] ?? '').trim())
        .map(q => ({ questionCode: q, answer: answers[q] }));
      const t = await verifyRecoveryAnswers(userId, payload);
      setTicket(t); setPhase('setmpin');
    } catch (e: any) {
      setError(onboardingError(e, 'Answers don’t match'));
    } finally { setBusy(false); }
  };

  const isWeak = (m: string) => !/^\d{6}$/.test(m) || /^(\d)\1{5}$/.test(m) || '0123456789'.includes(m) || '9876543210'.includes(m) || ['123456', '654321', '000000', '121212', '112233'].includes(m);

  const onSet = (v: string) => { if (isWeak(v)) { setError('That MPIN is too easy to guess.'); setFirst(''); doShake(); return; } setError(null); setMpinPhase('confirm'); };
  const onConfirm = async (v: string) => {
    if (v !== first) { setError('PINs don’t match.'); setConfirm(''); setFirst(''); setMpinPhase('set'); doShake(); return; }
    setBusy(true);
    try {
      await recoverMpin(userId, ticket, v);
      onboarding.reset();
      router.replace('/(tabs)/chats' as any);
    } catch (e: any) {
      setBusy(false); setMpinPhase('set'); setFirst(''); setConfirm('');
      Alert.alert('Could not reset', onboardingError(e, 'Try again'));
    }
  };

  return (
    <View style={s.screen}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          <TouchableOpacity onPress={() => router.back()} style={s.back}><Ionicons name="arrow-back" size={24} color={colors.text} /></TouchableOpacity>

          {phase === 'loading' && <ActivityIndicator color={colors.primary} style={{ marginTop: 80 }} />}

          {phase === 'answer' && (
            <>
              <Text style={s.title}>Reset your MPIN</Text>
              <Text style={s.sub}>Answer at least 3 of your security questions.</Text>
              <View style={{ height: 12 }} />
              {questions.map((q, i) => (
                <View key={q} style={{ marginBottom: 16 }}>
                  <Text style={s.qLabel}>{i + 1}. {questionLabel(q)}</Text>
                  <TextInput
                    style={s.input}
                    value={answers[q] ?? ''}
                    onChangeText={(t) => { setAnswers(prev => ({ ...prev, [q]: t })); setError(null); }}
                    placeholder="Your answer"
                    placeholderTextColor={colors.textFaint}
                    autoCapitalize="none" autoCorrect={false} secureTextEntry
                  />
                </View>
              ))}
              {!!error && <Text style={s.error}>{error}</Text>}
              <TouchableOpacity style={[s.cta, filled < 3 && s.ctaOff]} onPress={verify} disabled={filled < 3 || busy} activeOpacity={0.85}>
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.ctaTxt}>Verify ({filled}/3+)</Text>}
              </TouchableOpacity>
            </>
          )}

          {phase === 'setmpin' && (
            <View style={{ alignItems: 'center', paddingTop: 20 }}>
              <Text style={s.title}>{mpinPhase === 'set' ? 'New MPIN' : 'Confirm MPIN'}</Text>
              <Text style={s.sub}>{mpinPhase === 'set' ? 'Choose a new 6-digit PIN' : 'Re-enter to confirm'}</Text>
              <View style={{ marginVertical: 28 }}>
                {busy ? <ActivityIndicator color={colors.primary} size="large" />
                  : mpinPhase === 'set'
                    ? <MpinInput key="set" value={first} onChange={setFirst} onComplete={onSet} autoFocus shakeAnim={shake} />
                    : <MpinInput key="confirm" value={confirm} onChange={setConfirm} onComplete={onConfirm} autoFocus shakeAnim={shake} />}
              </View>
              {!!error && <Text style={s.error}>{error}</Text>}
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  body: { padding: 24, paddingTop: HEADER_TOP, paddingBottom: 48 },
  back: { marginBottom: 8 },
  backTxt: { color: c.text, fontSize: 26 },
  title: { color: c.text, fontSize: 24, fontWeight: '900' },
  sub: { color: c.textDim, fontSize: 14, marginTop: 8, textAlign: 'center' },
  qLabel: { color: c.textDim, fontSize: 13, fontWeight: '600', marginBottom: 6, lineHeight: 18 },
  input: { minHeight: 50, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.card, paddingHorizontal: 14, paddingVertical: 12, color: c.text, fontSize: 15 },
  error: { color: c.danger, fontSize: 13, marginTop: 6, textAlign: 'center', fontWeight: '600' },
  cta: { marginTop: 12, height: 56, borderRadius: 16, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  ctaOff: { opacity: 0.4 },
  ctaTxt: { color: '#fff', fontSize: 16, fontWeight: '800' },
});
