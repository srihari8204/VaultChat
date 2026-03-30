import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Animated, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { ErrorBoundary } from '../components/ErrorBoundary';

const C = {
  bg: '#FFFFFF', primary: '#4A9FFF', secondary: '#7C3AED',
  accent: '#10B981', danger: '#EF4444', warning: '#F59E0B',
  textFaint: 'rgba(255,255,255,0.22)', textDim: 'rgba(255,255,255,0.5)',
};

const COLOUR_OPTIONS = ['Red','Blue','Green','Purple','Gold','Black','White','Pink','Orange','Teal','Silver','Navy'];
const COLOUR_HEX = { Red:'#EF4444', Blue:'#4A9FFF', Green:'#10B981', Purple:'#7C3AED', Gold:'#F59E0B', Black:'#1F2937', White:'#F9FAFB', Pink:'#EC4899', Orange:'#F97316', Teal:'#14B8A6', Silver:'#9CA3AF', Navy:'#1E3A5F' };
const CAR_OPTIONS = ['BMW','Mercedes','Toyota','Tesla','Ferrari','Lamborghini','Porsche','Audi','Ford','Rolls-Royce','McLaren','Bugatti'];

const QUESTIONS = [
  { id: 'birthday',  label: 'Date of Birthday',  icon: '&#128197;', hint: 'Format: DD/MM/YYYY', type: 'text', keyboard: 'numbers-and-punctuation' },
  { id: 'shoeSize',  label: 'Shoe Size',          icon: '&#128095;', hint: 'e.g. 42 or 9.5',    type: 'text', keyboard: 'decimal-pad' },
  { id: 'favCar',    label: 'Favourite Car',       icon: '&#128663;', hint: 'Pick from list',    type: 'picker', options: CAR_OPTIONS },
  { id: 'favColour', label: 'Favourite Colour',    icon: '&#127912;', hint: 'Pick your colour',  type: 'colour', options: COLOUR_OPTIONS },
];

function RecoveryContent() {
  const router = useRouter();
  const [answers, setAnswers] = useState({ birthday:'', shoeSize:'', favCar:'', favColour:'' });
  const [errors, setErrors]   = useState({});
  const [phase, setPhase]     = useState('challenge');
  const [attempts, setAttempts] = useState(0);
  const [locked, setLocked]   = useState(false);
  const [lockCountdown, setLockCountdown] = useState(30);
  const [openPicker, setOpenPicker] = useState(null);
  const [loading, setLoading] = useState(false);

  const fadeAnim   = useRef(new Animated.Value(0)).current;
  const shakeAnim  = useRef(new Animated.Value(0)).current;
  const loadAnim   = useRef(new Animated.Value(0)).current;
  const successAnim = useRef(new Animated.Value(0)).current;
  const lockAnim   = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 500, useNativeDriver: true }).start();
  }, [fadeAnim]);

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

  const filledAnswers = Object.values(answers).filter(v => v.trim()).length;

  const validate = () => {
    const errs = {};
    if (filledAnswers < 2) {
      errs.general = 'Please answer at least 2 security questions';
      setErrors(errs);
      return false;
    }
    if (answers.birthday && !/^\d{2}\/\d{2}\/\d{4}$/.test(answers.birthday.trim())) {
      errs.birthday = 'Format must be DD/MM/YYYY';
    }
    if (answers.shoeSize && isNaN(Number(answers.shoeSize))) {
      errs.shoeSize = 'Must be a number';
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleVerify = () => {
    if (locked) return;
    if (!validate()) { shake(); return; }
    setLoading(true);
    Animated.loop(Animated.timing(loadAnim, { toValue: 1, duration: 800, useNativeDriver: true })).start();

    // Demo: any 2+ answers = pass. In production compare hashed answers.
    setTimeout(() => {
      setLoading(false);
      loadAnim.stopAnimation();
      loadAnim.setValue(0);
      const newAttempts = attempts + 1;
      // Simulate: fail on first attempt to demo lockout, pass on 2nd
      // In real app: compare against stored hashed answers
      const passed = filledAnswers >= 2; // always pass in demo mode
      if (passed) {
        setPhase('success');
        Animated.spring(successAnim, { toValue: 1, tension: 60, friction: 8, useNativeDriver: true }).start();
        setTimeout(() => router.push('/forgot'), 2000);
      } else {
        setAttempts(newAttempts);
        shake();
        setErrors({ general: 'Answers do not match our records. ' + (3 - newAttempts) + ' attempt(s) remaining.' });
        if (newAttempts >= 3) {
          setLocked(true);
          setErrors({ general: 'Too many failed attempts. Account locked for 30 seconds.' });
        }
      }
    }, 1600);
  };

  const setAnswer = (id, val) => {
    setAnswers(prev => ({ ...prev, [id]: val }));
    setErrors(e => ({ ...e, [id]: undefined, general: undefined }));
  };

  const loadDeg = loadAnim.interpolate({ inputRange:[0,1], outputRange:['0deg','360deg'] });

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <LinearGradient colors={['#FFFFFF','#FFFFFF','#040F20']} style={S.fill} />
      <View style={{ position: 'absolute', top: -60, alignSelf: 'center', width: 300, height: 300, borderRadius: 150, backgroundColor: 'rgba(245,158,11,0.04)' }} />

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <Animated.View style={{ flex: 1, opacity: fadeAnim }}>
          <ScrollView contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 24, paddingBottom: 48 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>

            <TouchableOpacity onPress={() => router.back()} style={[S.backBtn, { marginTop: 54 }]}>
              <Text style={{ color: C.primary, fontSize: 18 }}>&#8592;</Text>
            </TouchableOpacity>

            {phase === 'challenge' && (
              <>
                <View style={{ marginTop: 24, marginBottom: 28, alignItems: 'center', gap: 10 }}>
                  <View style={[S.iconWrap, locked && { borderColor: C.danger, backgroundColor: 'rgba(239,68,68,0.1)' }]}>
                    <Text style={{ fontSize: 38 }}>{locked ? '&#128274;' : '&#128737;'}</Text>
                  </View>
                  <Text style={S.title}>{locked ? 'Account Locked' : 'Identity Verification'}</Text>
                  <Text style={{ color: C.textDim, fontSize: 13, textAlign: 'center', lineHeight: 20 }}>
                    {locked
                      ? 'Too many failed attempts. Please wait ' + lockCountdown + ' seconds.'
                      : 'Answer at least 2 of your security questions to proceed with password reset.'}
                  </Text>
                  {attempts > 0 && !locked && (
                    <View style={{ backgroundColor: 'rgba(239,68,68,0.1)', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 6, borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)' }}>
                      <Text style={{ color: C.danger, fontSize: 11, fontWeight: '700' }}>
                        &#9888; {attempts} failed attempt{attempts > 1 ? 's' : ''} Â· {3 - attempts} remaining
                      </Text>
                    </View>
                  )}
                </View>

                {/* Filled count bar */}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 20 }}>
                  {[0,1,2,3].map(i => (
                    <View key={i} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: i < filledAnswers ? C.accent : 'rgba(255,255,255,0.08)' }} />
                  ))}
                  <Text style={{ color: filledAnswers >= 2 ? C.accent : C.textFaint, fontSize: 10, fontWeight: '800' }}>
                    {filledAnswers}/4
                  </Text>
                </View>

                {errors.general && (
                  <View style={{ backgroundColor: 'rgba(239,68,68,0.1)', borderRadius: 12, padding: 12, marginBottom: 14, borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)' }}>
                    <Text style={{ color: C.danger, fontSize: 12, textAlign: 'center', fontWeight: '700' }}>&#9888; {errors.general}</Text>
                  </View>
                )}

                <Animated.View style={{ transform: [{ translateX: shakeAnim }], gap: 16 }}>
                  {QUESTIONS.map(q => (
                    <View key={q.id}>
                      <Text style={S.label}>{q.icon} {q.label}</Text>
                      {q.type === 'text' && (
                        <View style={[S.inputWrap, errors[q.id] && S.inputError, answers[q.id] && { borderColor: C.accent + '55' }, locked && { opacity: 0.4 }]}>
                          <TextInput
                            value={answers[q.id]}
                            onChangeText={v => setAnswer(q.id, v)}
                            placeholder={q.hint}
                            placeholderTextColor={C.textFaint}
                            keyboardType={q.keyboard}
                            editable={!locked}
                            style={[S.input, { flex: 1 }]}
                          />
                          {answers[q.id] ? <Text style={{ color: C.accent, fontSize: 14 }}>&#10003;</Text> : null}
                        </View>
                      )}
                      {q.type === 'picker' && (
                        <>
                          <TouchableOpacity onPress={() => !locked && setOpenPicker(openPicker === q.id ? null : q.id)} style={[S.inputWrap, answers[q.id] && { borderColor: C.accent + '55' }, locked && { opacity: 0.4 }]}>
                            <Text style={{ color: answers[q.id] ? '#fff' : C.textFaint, flex: 1, fontSize: 15 }}>{answers[q.id] || q.hint}</Text>
                            <Text style={{ color: C.textFaint, fontSize: 12 }}>{openPicker === q.id ? '&#9650;' : '&#9660;'}</Text>
                          </TouchableOpacity>
                          {openPicker === q.id && (
                            <View style={S.pickerDrop}>
                              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 12 }}>
                                {q.options.map(opt => (
                                  <TouchableOpacity key={opt} onPress={() => { setAnswer(q.id, opt); setOpenPicker(null); }} style={[S.pickerChip, answers[q.id] === opt && { backgroundColor: C.primary + '22', borderColor: C.primary }]}>
                                    <Text style={{ color: answers[q.id] === opt ? C.primary : '#fff', fontSize: 12, fontWeight: '700' }}>{opt}</Text>
                                  </TouchableOpacity>
                                ))}
                              </View>
                            </View>
                          )}
                        </>
                      )}
                      {q.type === 'colour' && (
                        <>
                          <TouchableOpacity onPress={() => !locked && setOpenPicker(openPicker === q.id ? null : q.id)} style={[S.inputWrap, answers[q.id] && { borderColor: C.accent + '55' }, locked && { opacity: 0.4 }]}>
                            {answers[q.id]
                              ? <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: COLOUR_HEX[answers[q.id]], marginRight: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' }} />
                              : <Text style={S.inputIcon}>&#127912;</Text>}
                            <Text style={{ color: answers[q.id] ? '#fff' : C.textFaint, flex: 1, fontSize: 15 }}>{answers[q.id] || 'Choose your favourite colour'}</Text>
                            <Text style={{ color: C.textFaint, fontSize: 12 }}>{openPicker === q.id ? '&#9650;' : '&#9660;'}</Text>
                          </TouchableOpacity>
                          {openPicker === q.id && (
                            <View style={S.pickerDrop}>
                              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, padding: 14 }}>
                                {q.options.map(col => (
                                  <TouchableOpacity key={col} onPress={() => { setAnswer(q.id, col); setOpenPicker(null); }} style={{ alignItems: 'center', gap: 4 }}>
                                    <View style={[{ width: 36, height: 36, borderRadius: 18, backgroundColor: COLOUR_HEX[col] }, answers[q.id] === col && { borderWidth: 3, borderColor: '#fff' }]} />
                                    <Text style={{ color: answers[q.id] === col ? '#fff' : C.textFaint, fontSize: 8, fontWeight: '700' }}>{col.toUpperCase()}</Text>
                                  </TouchableOpacity>
                                ))}
                              </View>
                            </View>
                          )}
                        </>
                      )}
                      {errors[q.id] ? <Text style={S.errTxt}>&#9888; {errors[q.id]}</Text> : null}
                    </View>
                  ))}

                  <TouchableOpacity onPress={handleVerify} disabled={locked || loading} style={{ marginTop: 8 }}>
                    <LinearGradient colors={locked ? ['#2a1a1a','#1a0a0a'] : loading ? ['#1a2a4a','#2a1a4a'] : ['#1D4ED8','#7C3AED']} style={S.bigBtn}>
                      {loading ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                          <Animated.View style={{ width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: '#fff', borderTopColor: 'transparent', transform: [{ rotate: loadDeg }] }} />
                          <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>Verifying identity...</Text>
                        </View>
                      ) : locked ? (
                        <Text style={{ color: C.danger, fontSize: 15, fontWeight: '900' }}>&#128274; Locked ({lockCountdown}s)</Text>
                      ) : (
                        <Text style={S.bigBtnTxt}>&#128737; Verify Identity</Text>
                      )}
                    </LinearGradient>
                  </TouchableOpacity>

                  <TouchableOpacity onPress={() => router.back()} style={{ alignItems: 'center', marginTop: 6 }}>
                    <Text style={{ color: C.textFaint, fontSize: 13 }}>Cancel â€” Back to Login</Text>
                  </TouchableOpacity>
                </Animated.View>
              </>
            )}

            {phase === 'success' && (
              <Animated.View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 60, gap: 20, transform: [{ scale: successAnim }] }}>
                <View style={{ width: 100, height: 100, borderRadius: 50, backgroundColor: 'rgba(16,185,129,0.15)', borderWidth: 2, borderColor: C.accent, justifyContent: 'center', alignItems: 'center' }}>
                  <Text style={{ fontSize: 50 }}>&#10003;</Text>
                </View>
                <Text style={[S.title, { textAlign: 'center' }]}>Identity Verified</Text>
                <Text style={{ color: C.textDim, fontSize: 14, textAlign: 'center', lineHeight: 22 }}>
                  Your answers matched. Redirecting to password reset...
                </Text>
                <View style={{ backgroundColor: 'rgba(16,185,129,0.08)', borderRadius: 14, padding: 14, borderWidth: 1, borderColor: 'rgba(16,185,129,0.25)', width: '100%' }}>
                  <Text style={{ color: C.accent, fontSize: 12, textAlign: 'center' }}>
                    &#128274; A secure reset link will be sent to your registered email
                  </Text>
                </View>
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
  label: { color: 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: '700', letterSpacing: 0.5, marginBottom: 8 },
  inputWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(10,22,40,0.85)', borderRadius: 16, paddingHorizontal: 16, paddingVertical: 14, borderWidth: 1.5, borderColor: 'rgba(74,159,255,0.15)' },
  inputError: { borderColor: '#EF4444' },
  inputIcon: { fontSize: 16, marginRight: 10 },
  input: { flex: 1, color: '#fff', fontSize: 15 },
  errTxt: { color: '#EF4444', fontSize: 11, marginTop: 5, marginLeft: 4 },
  bigBtn: { borderRadius: 18, paddingVertical: 18, alignItems: 'center', justifyContent: 'center' },
  bigBtnTxt: { color: '#fff', fontSize: 16, fontWeight: '900' },
  pickerDrop: { backgroundColor: 'rgba(6,14,34,0.97)', borderRadius: 16, marginTop: 6, borderWidth: 1, borderColor: 'rgba(74,159,255,0.15)', overflow: 'hidden' },
  pickerChip: { backgroundColor: 'rgba(10,22,40,0.8)', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.08)' },
});
