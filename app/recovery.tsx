// app/recovery.tsx — REAL account-recovery identity check.
//
// Loads the three security questions the user actually chose during setup
// (security-questions.tsx → saveSecurityAnswers, stored hashed in SecureStore),
// presents them, and verifies the typed answers against the stored salted SHA-256
// hashes (services/securityService.verifySecurityAnswers). All three must match.
// Three wrong tries → a real 30-second lockout. On success the user proceeds to
// set a new MPIN (/set-mpin → savePIN). No demo pass-throughs, no fake questions.

import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Animated, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { getSecurityQuestions, verifySecurityAnswers } from '../services/securityService';

const C = {
  primary: '#4A9FFF', accent: '#10B981', danger: '#EF4444', warning: '#F59E0B',
  textFaint: 'rgba(255,255,255,0.22)', textDim: 'rgba(255,255,255,0.5)',
};

const MAX_ATTEMPTS = 3;

function RecoveryContent() {
  const router = useRouter();
  const [questions, setQuestions] = useState<string[] | null>(null);
  const [answers, setAnswers]     = useState<string[]>(['', '', '']);
  const [phase, setPhase]         = useState<'loading' | 'noconfig' | 'challenge' | 'success'>('loading');
  const [attempts, setAttempts]   = useState(0);
  const [locked, setLocked]       = useState(false);
  const [lockCountdown, setLockCountdown] = useState(30);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');

  const fadeAnim    = useRef(new Animated.Value(0)).current;
  const shakeAnim   = useRef(new Animated.Value(0)).current;
  const loadAnim    = useRef(new Animated.Value(0)).current;
  const successAnim = useRef(new Animated.Value(0)).current;
  const lockAnim    = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 500, useNativeDriver: true }).start();
  }, [fadeAnim]);

  // Load the user's real, chosen questions.
  useEffect(() => {
    (async () => {
      const qs = await getSecurityQuestions();
      if (qs && qs.length === 3) { setQuestions(qs); setPhase('challenge'); }
      else { setPhase('noconfig'); }
    })();
  }, []);

  useEffect(() => {
    if (!locked) return;
    let secs = 30;
    setLockCountdown(secs);
    Animated.loop(Animated.sequence([
      Animated.timing(lockAnim, { toValue: 1, duration: 800, useNativeDriver: false }),
      Animated.timing(lockAnim, { toValue: 0, duration: 800, useNativeDriver: false }),
    ])).start();
    const iv = setInterval(() => {
      secs--;
      setLockCountdown(secs);
      if (secs <= 0) {
        clearInterval(iv);
        setLocked(false);
        setAttempts(0);
        setError('');
        lockAnim.stopAnimation();
        lockAnim.setValue(0);
      }
    }, 1000);
    return () => clearInterval(iv);
  }, [locked, lockAnim]);

  const shake = () => {
    shakeAnim.setValue(0);
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 12,  duration: 55, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -12, duration: 55, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 8,   duration: 55, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -8,  duration: 55, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0,   duration: 55, useNativeDriver: true }),
    ]).start();
  };

  const filledAnswers = answers.filter(v => v.trim().length >= 2).length;

  const setAnswer = (slot: number, val: string) => {
    setAnswers(prev => { const n = [...prev]; n[slot] = val; return n; });
    setError('');
  };

  const handleVerify = async () => {
    if (locked || loading) return;
    if (filledAnswers < 3) {
      setError('Answer all 3 security questions exactly as you set them.');
      shake();
      return;
    }
    setLoading(true);
    Animated.loop(Animated.timing(loadAnim, { toValue: 1, duration: 800, useNativeDriver: true })).start();

    let passed = false;
    try {
      passed = await verifySecurityAnswers([answers[0], answers[1], answers[2]]);
    } catch {
      passed = false;
    }

    setLoading(false);
    loadAnim.stopAnimation();
    loadAnim.setValue(0);

    if (passed) {
      setError('');
      setPhase('success');
      Animated.spring(successAnim, { toValue: 1, tension: 60, friction: 8, useNativeDriver: true }).start();
      // Verified → let them set a new MPIN (real reset via savePIN in set-mpin).
      setTimeout(() => router.replace('/set-mpin' as any), 1600);
    } else {
      const next = attempts + 1;
      setAttempts(next);
      shake();
      if (next >= MAX_ATTEMPTS) {
        setLocked(true);
        setError('Too many failed attempts. Locked for 30 seconds.');
      } else {
        setError(`Answers don’t match. ${MAX_ATTEMPTS - next} attempt${MAX_ATTEMPTS - next === 1 ? '' : 's'} left.`);
      }
    }
  };

  const loadDeg = loadAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <View style={{ flex: 1, backgroundColor: '#040F20' }}>
      <LinearGradient colors={['#020E1A', '#061528', '#040F20']} style={S.fill} />
      <View style={{ position: 'absolute', top: -60, alignSelf: 'center', width: 300, height: 300, borderRadius: 150, backgroundColor: 'rgba(245,158,11,0.04)' }} />

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <Animated.View style={{ flex: 1, opacity: fadeAnim }}>
          <ScrollView contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 24, paddingBottom: 48 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>

            <TouchableOpacity onPress={() => router.back()} style={[S.backBtn, { marginTop: 54 }]}>
              <Text style={{ color: C.primary, fontSize: 18 }}>←</Text>
            </TouchableOpacity>

            {phase === 'loading' && (
              <View style={{ marginTop: 120, alignItems: 'center' }}>
                <Animated.View style={{ width: 32, height: 32, borderRadius: 16, borderWidth: 3, borderColor: C.primary, borderTopColor: 'transparent', transform: [{ rotate: loadDeg }] }} />
              </View>
            )}

            {phase === 'noconfig' && (
              <View style={{ marginTop: 60, alignItems: 'center', gap: 16 }}>
                <View style={S.iconWrap}><Text style={{ fontSize: 38 }}>🛡️</Text></View>
                <Text style={S.title}>No recovery questions</Text>
                <Text style={{ color: C.textDim, fontSize: 14, textAlign: 'center', lineHeight: 22 }}>
                  You haven’t set up security questions on this device, so identity recovery
                  isn’t available. If you’re locked out, you’ll need to reinstall and restore
                  from a backup.
                </Text>
                <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 8 }}>
                  <LinearGradient colors={['#1D4ED8', '#7C3AED']} style={S.bigBtn}>
                    <Text style={S.bigBtnTxt}>Back</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </View>
            )}

            {phase === 'challenge' && questions && (
              <>
                <View style={{ marginTop: 24, marginBottom: 28, alignItems: 'center', gap: 10 }}>
                  <View style={[S.iconWrap, locked && { borderColor: C.danger, backgroundColor: 'rgba(239,68,68,0.1)' }]}>
                    <Text style={{ fontSize: 38 }}>{locked ? '🔒' : '🛡️'}</Text>
                  </View>
                  <Text style={S.title}>{locked ? 'Account Locked' : 'Identity Verification'}</Text>
                  <Text style={{ color: C.textDim, fontSize: 13, textAlign: 'center', lineHeight: 20 }}>
                    {locked
                      ? 'Too many failed attempts. Please wait ' + lockCountdown + ' seconds.'
                      : 'Answer all 3 of your security questions to reset your PIN.'}
                  </Text>
                </View>

                {/* Filled count bar */}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 20 }}>
                  {[0, 1, 2].map(i => (
                    <View key={i} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: i < filledAnswers ? C.accent : 'rgba(255,255,255,0.08)' }} />
                  ))}
                  <Text style={{ color: filledAnswers >= 3 ? C.accent : C.textFaint, fontSize: 10, fontWeight: '800' }}>
                    {filledAnswers}/3
                  </Text>
                </View>

                {!!error && (
                  <View style={{ backgroundColor: 'rgba(239,68,68,0.1)', borderRadius: 12, padding: 12, marginBottom: 14, borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)' }}>
                    <Text style={{ color: C.danger, fontSize: 12, textAlign: 'center', fontWeight: '700' }}>⚠ {error}</Text>
                  </View>
                )}

                <Animated.View style={{ transform: [{ translateX: shakeAnim }], gap: 16 }}>
                  {questions.map((q, slot) => (
                    <View key={slot}>
                      <Text style={S.label}>Question {slot + 1}</Text>
                      <Text style={S.question}>{q}</Text>
                      <View style={[S.inputWrap, answers[slot] && { borderColor: C.accent + '55' }, locked && { opacity: 0.4 }]}>
                        <TextInput
                          value={answers[slot]}
                          onChangeText={v => setAnswer(slot, v)}
                          placeholder="Your answer"
                          placeholderTextColor={C.textFaint}
                          editable={!locked}
                          autoCapitalize="none"
                          autoCorrect={false}
                          secureTextEntry
                          style={[S.input, { flex: 1 }]}
                        />
                        {answers[slot].trim().length >= 2 ? <Text style={{ color: C.accent, fontSize: 14 }}>✓</Text> : null}
                      </View>
                    </View>
                  ))}

                  <TouchableOpacity onPress={handleVerify} disabled={locked || loading} style={{ marginTop: 8 }}>
                    <LinearGradient colors={locked ? ['#2a1a1a', '#1a0a0a'] : loading ? ['#1a2a4a', '#2a1a4a'] : ['#1D4ED8', '#7C3AED']} style={S.bigBtn}>
                      {loading ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                          <Animated.View style={{ width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: '#fff', borderTopColor: 'transparent', transform: [{ rotate: loadDeg }] }} />
                          <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>Verifying…</Text>
                        </View>
                      ) : locked ? (
                        <Text style={{ color: C.danger, fontSize: 15, fontWeight: '900' }}>🔒 Locked ({lockCountdown}s)</Text>
                      ) : (
                        <Text style={S.bigBtnTxt}>🛡️ Verify Identity</Text>
                      )}
                    </LinearGradient>
                  </TouchableOpacity>

                  <TouchableOpacity onPress={() => router.back()} style={{ alignItems: 'center', marginTop: 6 }}>
                    <Text style={{ color: C.textFaint, fontSize: 13 }}>Cancel — Back</Text>
                  </TouchableOpacity>
                </Animated.View>
              </>
            )}

            {phase === 'success' && (
              <Animated.View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 60, gap: 20, transform: [{ scale: successAnim }] }}>
                <View style={{ width: 100, height: 100, borderRadius: 50, backgroundColor: 'rgba(16,185,129,0.15)', borderWidth: 2, borderColor: C.accent, justifyContent: 'center', alignItems: 'center' }}>
                  <Text style={{ fontSize: 50 }}>✓</Text>
                </View>
                <Text style={[S.title, { textAlign: 'center' }]}>Identity Verified</Text>
                <Text style={{ color: C.textDim, fontSize: 14, textAlign: 'center', lineHeight: 22 }}>
                  Your answers matched. Set a new PIN to regain access…
                </Text>
              </Animated.View>
            )}

          </ScrollView>
        </Animated.View>
      </KeyboardAvoidingView>
    </View>
  );
}

export default function RecoveryScreen() {
  return (
    <ErrorBoundary fallbackTitle="Recovery Error" fallbackMessage="Identity verification had a problem.">
      <RecoveryContent />
    </ErrorBoundary>
  );
}

const S = StyleSheet.create({
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  backBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(10,22,40,0.8)', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)' },
  iconWrap: { width: 84, height: 84, borderRadius: 42, backgroundColor: 'rgba(245,158,11,0.1)', borderWidth: 2, borderColor: 'rgba(245,158,11,0.35)', justifyContent: 'center', alignItems: 'center' },
  title: { color: '#fff', fontSize: 24, fontWeight: '900' },
  label: { color: C.primary, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 4 },
  question: { color: 'rgba(255,255,255,0.85)', fontSize: 14, fontWeight: '600', marginBottom: 8, lineHeight: 20 },
  inputWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(10,22,40,0.85)', borderRadius: 16, paddingHorizontal: 16, paddingVertical: 14, borderWidth: 1.5, borderColor: 'rgba(74,159,255,0.15)' },
  input: { flex: 1, color: '#fff', fontSize: 15 },
  bigBtn: { borderRadius: 18, paddingVertical: 18, alignItems: 'center', justifyContent: 'center' },
  bigBtnTxt: { color: '#fff', fontSize: 16, fontWeight: '900' },
});
