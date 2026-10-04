// app/eye-check.tsx — Eye Check: a screen-comfort screening, not a diagnosis.
//
// This file holds the state and the answer logic and picks the phase; each
// phase renders from components/comfort/EyeCheckPhases.tsx and the charts from
// components/comfort/EyeCheckCharts.tsx.
import { Ionicons } from '@expo/vector-icons';
import { Stack, useNavigation, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { AppText as Text, AuroraBackground } from '../components/ui';
import { useTheme } from '../lib/theme';
import {
  answerCheck, CLEAR_SCREEN_MATCHES, expectedOrientation, INITIAL_CHECK_STEP, startLeftEye,
} from '../lib/eyeCheckModel';
import {
  AcuityResult, AcuitySwitch, AcuityTrial, AmslerResult, AmslerTrial, AstigResult, AstigTrial,
  ColorResult, ColorTrial, IntroPhase, SetupPhase, SummaryPhase, type Glasses,
} from '../components/comfort/EyeCheckPhases';

const DIGITS = ['5', '8', '3', '6', '2', '9'] as const;
// Phases where Back would throw away answers already given.
const MID_TEST = new Set(['setup', 'acuity', 'color', 'colorResult', 'astig', 'astigResult', 'amsler', 'amslerResult']);

export default function EyeCheckScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const [phase, setPhase] = useState<'intro' | 'setup' | 'acuity' | 'color' | 'colorResult' | 'astig' | 'astigResult' | 'amsler' | 'amslerResult' | 'summary'>('intro');
  const [setupStep, setSetupStep] = useState(0);
  const [calibration, setCalibration] = useState(1);
  const [glasses, setGlasses] = useState<Glasses>('with');
  const [step, setStep] = useState(INITIAL_CHECK_STEP);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * DIGITS.length));
  const [feedback, setFeedback] = useState<boolean | null>(null);
  const [colorIndex, setColorIndex] = useState(0);
  const [colorCorrect, setColorCorrect] = useState(0);
  const [astigEye, setAstigEye] = useState<'right' | 'left'>('right');
  const [astigSame, setAstigSame] = useState({ right: null, left: null } as { right: boolean | null; left: boolean | null });
  const [amslerEye, setAmslerEye] = useState<'right' | 'left'>('right');
  const [amslerQuestion, setAmslerQuestion] = useState(0);
  const [amslerConcern, setAmslerConcern] = useState({ right: false, left: false });
  const pending = useRef(false);
  // The 650 ms answer feedback must not fire after the screen is gone.
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (feedbackTimer.current) clearTimeout(feedbackTimer.current); }, []);
  // Leaving mid-test loses every answer, so it asks first (Back button,
  // hardware back and the swipe gesture all go through beforeRemove).
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const navigation = useNavigation();
  useEffect(() => navigation.addListener('beforeRemove', (ev) => {
    // beforeRemove is preventable at runtime; the generic navigation type says otherwise.
    const e = ev as typeof ev & { preventDefault(): void };
    if (!MID_TEST.has(phaseRef.current)) return;
    e.preventDefault();
    Alert.alert('Leave Eye Check?', 'Your answers so far will be lost.', [
      { text: 'Continue the check', style: 'cancel' },
      { text: 'Leave', style: 'destructive', onPress: () => navigation.dispatch(e.data.action) },
    ]);
  }), [navigation]);
  const chartSize = Math.max(1, Math.min(228, width - 64));
  const trackWidth = Math.max(1, Math.min(280, width - 64));
  const ringSize = Math.min(252, Math.max(0, width - 66));
  const ringButtonSize = Math.min(60, Math.max(44, ringSize * 60 / 252));
  const ringRadius = Math.min(85, (ringSize - ringButtonSize) / 2);
  const currentDigit = DIGITS[(seed + colorIndex) % DIGITS.length];
  const suggestComfort = step.rightCorrect < CLEAR_SCREEN_MATCHES || step.leftCorrect < CLEAR_SCREEN_MATCHES;
  const needsExam = suggestComfort || colorCorrect < DIGITS.length || astigSame.right !== true || astigSame.left !== true || amslerConcern.right || amslerConcern.left;

  const nextSetup = () => {
    if (setupStep < 3) setSetupStep(value => value + 1);
    else { setStep({ ...INITIAL_CHECK_STEP, seed }); setPhase('acuity'); }
  };
  const answerAcuity = (angle: number | null) => {
    if (pending.current || step.phase !== 'right' && step.phase !== 'left') return;
    pending.current = true;
    setFeedback(angle === expectedOrientation(step));
    feedbackTimer.current = setTimeout(() => {
      setStep(current => answerCheck(current, angle));
      setFeedback(null);
      pending.current = false;
    }, 650);
  };
  const answerColor = (value: string) => {
    if (pending.current) return;
    pending.current = true;
    const correct = value === currentDigit;
    setFeedback(correct);
    feedbackTimer.current = setTimeout(() => {
      if (correct) setColorCorrect(count => count + 1);
      if (colorIndex + 1 === DIGITS.length) setPhase('colorResult');
      else setColorIndex(index => index + 1);
      setFeedback(null);
      pending.current = false;
    }, 650);
  };
  const answerAstig = (same: boolean) => {
    setAstigSame(current => ({ ...current, [astigEye]: same }));
    if (astigEye === 'right') setAstigEye('left');
    else setPhase('astigResult');
  };
  const answerAmsler = (yes: boolean) => {
    if (yes !== (amslerQuestion === 0)) setAmslerConcern(current => ({ ...current, [amslerEye]: true }));
    if (amslerQuestion === 0) setAmslerQuestion(1);
    else if (amslerEye === 'right') { setAmslerEye('left'); setAmslerQuestion(0); }
    else setPhase('amslerResult');
  };
  const restart = () => {
    setSeed(current => current + 1);
    setStep(INITIAL_CHECK_STEP);
    setSetupStep(0);
    setColorIndex(0);
    setColorCorrect(0);
    setAstigEye('right');
    setAstigSame({ right: null, left: null });
    setAmslerEye('right');
    setAmslerQuestion(0);
    setAmslerConcern({ right: false, left: false });
    setPhase('intro');
  };

  const colorOptions = [currentDigit, DIGITS[(seed + colorIndex + 1) % DIGITS.length], DIGITS[(seed + colorIndex + 2) % DIGITS.length]].sort();
  // Back to the Vision Comfort screen that opened this one, with the suggestion.
  // dismissTo pops to it (replace used to stack a second Vision Comfort on the
  // first); eyeCheckAt makes a repeat result with the same values still apply.
  const previewSuggestion = () => router.dismissTo({
    pathname: '/vision-comfort',
    params: { eyeCheckSuggestion: suggestComfort ? '1' : '0', eyeCheckGlasses: glasses, eyeCheckAt: String(Date.now()) },
  });
  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/vision-comfort'));
  const trial = step.phase === 'right' || step.phase === 'left';

  return <View style={s.screen}>
    <Stack.Screen options={{ headerShown: false }} />
    <AuroraBackground />
    <ScrollView contentContainerStyle={s.scroll}>
      <View style={s.container}>
        <View style={s.header}>
          <Pressable accessibilityRole="button" accessibilityLabel="Back to Vision Comfort" onPress={goBack} style={s.back}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </Pressable>
          <Ionicons name="eye-outline" size={28} color={colors.primary} />
          <Text style={s.title} accessibilityRole="header">Eye Check</Text>
        </View>
        <Text style={[s.subtitle, { color: colors.textDim }]}>Visual acuity · Colour vision · Astigmatism · Amsler grid</Text>

        {phase === 'intro' && <IntroPhase onStart={() => setPhase('setup')} />}
        {phase === 'setup' && (
          <SetupPhase setupStep={setupStep} calibration={calibration} onCalibrate={setCalibration} trackWidth={trackWidth}
            glasses={glasses} onGlasses={setGlasses} onNext={nextSetup} />
        )}
        {phase === 'acuity' && step.phase === 'switch' && (
          <AcuitySwitch rightCorrect={step.rightCorrect} onStartLeft={() => setStep(current => startLeftEye(current))} />
        )}
        {phase === 'acuity' && step.phase === 'result' && <AcuityResult step={step} onNext={() => setPhase('color')} />}
        {phase === 'acuity' && trial && (
          <AcuityTrial step={step} glasses={glasses} calibration={calibration} ringSize={ringSize} ringButtonSize={ringButtonSize}
            ringRadius={ringRadius} feedback={feedback} onAnswer={answerAcuity} />
        )}
        {phase === 'color' && (
          <ColorTrial plate={colorIndex + 1} total={DIGITS.length} options={colorOptions} digit={currentDigit}
            variant={(seed + colorIndex) % 3} chartSize={chartSize} feedback={feedback} onAnswer={answerColor} />
        )}
        {phase === 'colorResult' && <ColorResult correct={colorCorrect} total={DIGITS.length} onNext={() => setPhase('astig')} />}
        {phase === 'astig' && <AstigTrial eye={astigEye} chartSize={chartSize} onAnswer={answerAstig} />}
        {phase === 'astigResult' && <AstigResult same={astigSame} onNext={() => setPhase('amsler')} />}
        {phase === 'amsler' && <AmslerTrial eye={amslerEye} question={amslerQuestion} chartSize={chartSize} onAnswer={answerAmsler} />}
        {phase === 'amslerResult' && <AmslerResult concern={amslerConcern} onNext={() => setPhase('summary')} />}
        {phase === 'summary' && (
          <SummaryPhase step={step} astigSame={astigSame} amslerConcern={amslerConcern} colorCorrect={colorCorrect}
            colorTotal={DIGITS.length} glasses={glasses} suggestComfort={suggestComfort} needsExam={needsExam}
            onPreview={previewSuggestion} onRestart={restart} />
        )}
      </View>
    </ScrollView>
  </View>;
}

const s = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { paddingHorizontal: 16, paddingBottom: 40 },
  container: { width: '100%', maxWidth: 680, alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, minWidth: 0 },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: '800', flexShrink: 1 },
  subtitle: { fontSize: 14, lineHeight: 20, marginBottom: 20 },
});
