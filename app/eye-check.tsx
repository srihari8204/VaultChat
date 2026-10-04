import { Ionicons } from '@expo/vector-icons';
import { Stack, useNavigation, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text as NativeText, View, useWindowDimensions } from 'react-native';
import Svg, { Circle, G, Line, Path } from 'react-native-svg';
import { AppText as Text, AuroraBackground } from '../components/ui';
import { useTheme } from '../lib/theme';
import { PALETTES } from '../constants/theme';
import {
  answerCheck, CLEAR_SCREEN_MATCHES, expectedOrientation, INITIAL_CHECK_STEP,
  SCREEN_LEVELS, screenClarityIndex, startLeftEye, symbolScale, TRIALS_PER_EYE,
} from '../lib/eyeCheckModel';

const NOTICE = 'ఇది కేవలం ప్రాథమిక స్క్రీనింగ్ మాత్రమే. ఇది డాక్టర్ కంటి పరీక్షకు ప్రత్యామ్నాయం కాదు';
const WHOEYES_URL = 'https://www.who.int/teams/noncommunicable-diseases/sensory-functions-disability-and-rehabilitation/whoeyes';
const DIGITS = ['5', '8', '3', '6', '2', '9'] as const;
// Label colour on solid primary fills. The palette has no on-primary token;
// white is the brand's button text in both themes.
const ON_PRIMARY = '#FFFFFF';
// The test charts sit on a fixed white field in both themes, so marks drawn on
// that field take the LIGHT palette's colours, which are made for white.
const ON_WHITE_FIELD = PALETTES.light;
// Phases where Back would throw away answers already given.
const MID_TEST = new Set(['setup', 'acuity', 'color', 'colorResult', 'astig', 'astigResult', 'amsler', 'amslerResult']);
const indexLabel = (correct: number) => {
  const value = screenClarityIndex(correct);
  return `${value > 0 ? '+' : ''}${value} points`;
};
const DIRECTIONS = [
  { angle: 0, symbol: '→', label: 'right' }, { angle: 45, symbol: '↘', label: 'down right' },
  { angle: 90, symbol: '↓', label: 'down' }, { angle: 135, symbol: '↙', label: 'down left' },
  { angle: 180, symbol: '←', label: 'left' }, { angle: 225, symbol: '↖', label: 'up left' },
  { angle: 270, symbol: '↑', label: 'up' }, { angle: 315, symbol: '↗', label: 'up right' },
] as const;

export default function EyeCheckScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const [phase, setPhase] = useState<'intro' | 'setup' | 'acuity' | 'color' | 'colorResult' | 'astig' | 'astigResult' | 'amsler' | 'amslerResult' | 'summary'>('intro');
  const [setupStep, setSetupStep] = useState(0);
  const [calibration, setCalibration] = useState(1);
  const [glasses, setGlasses] = useState<'with' | 'without'>('with');
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
  const card = [s.card, { backgroundColor: colors.surfaceSolid, borderColor: colors.glassStroke }];
  const primary = [s.primaryButton, { backgroundColor: colors.primary }];
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

  return <View style={s.screen}>
    <Stack.Screen options={{ headerShown: false }} />
    <AuroraBackground />
    <ScrollView contentContainerStyle={s.scroll}>
      <View style={s.container}>
        <View style={s.header}>
          <Pressable accessibilityRole="button" accessibilityLabel="Back to Vision Comfort" onPress={() => router.back()} style={s.back}><Ionicons name="arrow-back" size={24} color={colors.text} /></Pressable>
          <Ionicons name="eye-outline" size={28} color={colors.primary} />
          <Text style={s.title} accessibilityRole="header">Eye Check</Text>
        </View>
        <Text style={[s.subtitle, { color: colors.textDim }]}>Visual acuity · Colour vision · Astigmatism · Amsler grid</Text>

        {phase === 'intro' && <>
          <View style={card}><Text style={s.cardTitle}>Before you start</Text><Text style={s.body}>{NOTICE}</Text><Text style={s.body}>This digital check is not a medical diagnosis. Screen size, brightness, room light, distance and glasses affect what you see. An optometrist or ophthalmologist must check your eyes for a prescription.</Text></View>
          <View style={card}><Text style={s.cardTitle}>Four short checks</Text><Text style={s.body}>1. Match the gap in a rotating C, separately for each eye.</Text><Text style={s.body}>2. Read six coloured dot plates with both eyes open.</Text><Text style={s.body}>3. Compare dark lines separately with each eye.</Text><Text style={s.body}>4. Check the Amsler grid separately with each eye.</Text></View>
          <View style={card}><Text style={s.cardTitle}>Urgent symptoms</Text><Text style={s.body}>Sudden sight loss, eye pain, flashes or many new floaters need prompt eye care. Do not delay care to take this check.</Text></View>
          <Pressable accessibilityRole="button" onPress={() => setPhase('setup')} style={primary}><Text style={s.primaryLabel}>Start screen setup</Text></Pressable>
        </>}

        {phase === 'setup' && <>
          <Text style={s.sectionTitle} accessibilityRole="header">Screen setup · {setupStep + 1}/4</Text>
          <View style={card}>
            {setupStep === 0 && <>
              <Text style={s.cardTitle}>Calibrate with a standard card</Text>
              <Text style={s.body}>Place the short edge of a bank card beside the dashed line. Adjust until their lengths match. This uses the card setup from the reference test, adapted to a phone screen.</Text>
              <View style={[s.cardLine, { height: 340 * calibration, borderColor: colors.primary }]} />
              <View onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => true}
                onResponderGrant={event => setCalibration(0.65 + Math.max(0, Math.min(1, event.nativeEvent.locationX / trackWidth)) * 0.6)}
                onResponderMove={event => setCalibration(0.65 + Math.max(0, Math.min(1, event.nativeEvent.locationX / trackWidth)) * 0.6)}
                style={[s.calibrationTrack, { width: trackWidth, backgroundColor: colors.glassStroke }]}
                accessibilityRole="adjustable" accessibilityLabel="Card calibration" accessibilityValue={{ min: 65, max: 125, now: Math.round(calibration * 100) }}
                accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
                onAccessibilityAction={event => setCalibration(value => Math.max(0.65, Math.min(1.25, value + (event.nativeEvent.actionName === 'increment' ? 0.05 : -0.05))))}>
                <View pointerEvents="none" style={[s.calibrationThumb, { left: ((calibration - 0.65) / 0.6) * (trackWidth - 24), backgroundColor: colors.primary }]} />
              </View>
              <Text style={[s.smallNote, { color: colors.textDim }]}>Calibration helps screen sizing but cannot make a phone test clinically exact.</Text>
            </>}
            {setupStep === 1 && <>
              <Text style={s.cardTitle}>Glasses or contacts</Text>
              <Text style={s.body}>Use your usual glasses or contacts if needed. You can repeat the check without them later. Keep the same choice for both eyes.</Text>
              <View style={s.choiceRow}>{(['with', 'without'] as const).map(value => <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: glasses === value }} onPress={() => setGlasses(value)} style={[s.choice, { backgroundColor: glasses === value ? colors.primary : colors.bg, borderColor: colors.glassStroke }]}><Text style={[s.choiceText, { color: glasses === value ? ON_PRIMARY : colors.text }]}>{value === 'with' ? 'With glasses' : 'Without glasses'}</Text></Pressable>)}</View>
            </>}
            {setupStep === 2 && <><Text style={s.cardTitle}>Check one eye at a time</Text><Text style={s.body}>Cover your left eye gently without pressing on it. We will check the right eye first, then switch sides.</Text><Ionicons name="eye-outline" size={100} color={colors.primary} style={s.setupIcon} /></>}
            {setupStep === 3 && <><Text style={s.cardTitle}>Keep your distance</Text><Text style={s.body}>Hold your device at arm&apos;s length, face it directly, and keep the distance steady. Set brightness to 100% if comfortable; lower it if glare hurts.</Text><Text style={[s.smallNote, { color: colors.textDim }]}>Ask someone to tap the gap directions if you need to stay farther from the phone.</Text></>}
          </View>
          <Pressable accessibilityRole="button" onPress={nextSetup} style={primary}><Text style={s.primaryLabel}>{setupStep === 3 ? 'Start right eye' : 'Next'}</Text></Pressable>
        </>}

        {phase === 'acuity' && step.phase === 'switch' && <>
          <View style={card}><Text style={s.cardTitle}>Now check your left eye</Text><Text style={s.body}>Right eye: {step.rightCorrect}/{TRIALS_PER_EYE} gaps matched. Cover your right eye gently. Keep the same distance, light and glasses choice.</Text></View>
          <Pressable accessibilityRole="button" onPress={() => setStep(current => startLeftEye(current))} style={primary}><Text style={s.primaryLabel}>Start left eye</Text></Pressable>
        </>}
        {phase === 'acuity' && step.phase === 'result' && <>
          <View style={card}><Text style={s.cardTitle}>C-gap screen test scores</Text><Text style={s.resultHeading}>Right eye</Text><Text style={s.scoreValue}>{step.rightCorrect}/{TRIALS_PER_EYE}</Text><Text style={s.body}>Screen clarity index: {indexLabel(step.rightCorrect)} · {step.rightCorrect >= CLEAR_SCREEN_MATCHES ? 'Appears clear on this screen' : 'Further eye check recommended'} · smallest matched detail level {step.rightCompleted}/{SCREEN_LEVELS}</Text><Text style={s.resultHeading}>Left eye</Text><Text style={s.scoreValue}>{step.leftCorrect}/{TRIALS_PER_EYE}</Text><Text style={s.body}>Screen clarity index: {indexLabel(step.leftCorrect)} · {step.leftCorrect >= CLEAR_SCREEN_MATCHES ? 'Appears clear on this screen' : 'Further eye check recommended'} · smallest matched detail level {step.leftCompleted}/{SCREEN_LEVELS}</Text><Text style={[s.smallNote, { color: colors.textDim }]}>The −4 to +4 index only remaps your C-gap answers: negative means fewer gaps matched, positive means more. It is not spectacle power (+/− D), eyesight percentage or a prescription.</Text></View>
          <Pressable accessibilityRole="button" onPress={() => setPhase('color')} style={primary}><Text style={s.primaryLabel}>Next: colour vision</Text></Pressable>
        </>}
        {phase === 'acuity' && (step.phase === 'right' || step.phase === 'left') && <>
          <Text style={s.sectionTitle} accessibilityRole="header">Visual acuity · {step.eye === 'right' ? 'Right eye' : 'Left eye'}</Text>
          <Text style={s.body}>Cover your {step.eye === 'right' ? 'left' : 'right'} eye. At arm&apos;s length, match the gap in the top C using the direction buttons below.</Text>
          <Text style={[s.smallNote, { color: colors.textDim }]}>Gap {step.trial + 1}/{TRIALS_PER_EYE} · {glasses === 'with' ? 'with glasses' : 'without glasses'}</Text>
          <View style={[s.chartCard, { backgroundColor: '#FFFFFF', borderColor: colors.glassStroke }]}>{/* theme-exempt: the C chart uses a stable white test field */}
            <LandoltC size={Math.max(14, Math.min(100, 64 * symbolScale(step.stage) * calibration))} angle={expectedOrientation(step)} />
            <View style={ringSize < 190 ? s.narrowDirectionGrid : [s.directionRing, { width: ringSize, height: ringSize }]}>
              {DIRECTIONS.map(direction => {
                const rad = direction.angle * Math.PI / 180;
                return <Pressable key={direction.angle} accessibilityRole="button" accessibilityLabel={`Gap ${direction.label}`} onPress={() => answerAcuity(direction.angle)} style={[s.directionButton, ringSize < 190 ? s.narrowDirectionButton : { width: ringButtonSize, height: ringButtonSize, borderRadius: ringButtonSize / 2, left: (ringSize - ringButtonSize) / 2 + Math.cos(rad) * ringRadius, top: (ringSize - ringButtonSize) / 2 + Math.sin(rad) * ringRadius }, { backgroundColor: colors.primary }]}><NativeText maxFontSizeMultiplier={1} style={s.directionArrow}>{direction.symbol}</NativeText></Pressable>;
              })}
              {ringSize >= 190 && <View style={[s.ringCenter, { left: (ringSize - 36) / 2, top: (ringSize - 36) / 2 }]}><Ionicons name={feedback === null ? 'eye-outline' : feedback ? 'checkmark-circle' : 'close-circle'} size={36} color={feedback === null ? colors.primary : feedback ? ON_WHITE_FIELD.success : ON_WHITE_FIELD.danger} /></View>}
            </View>
          </View>
          {/* The ring's centre icon is visual only (and hidden on narrow screens); this says it. */}
          <Text accessibilityLiveRegion="polite" style={[s.feedback, { color: feedback ? colors.success : colors.danger }]}>{feedback === null ? '' : feedback ? 'Matched' : 'Different answer'}</Text>
          <Pressable accessibilityRole="button" onPress={() => answerAcuity(null)} style={[s.secondaryButton, { borderColor: colors.glassStroke }]}><Text style={[s.secondaryLabel, { color: colors.text }]}>I can&apos;t see the gap</Text></Pressable>
          <Text style={[s.smallNote, { color: colors.textDim }]}>The gap changes direction and the C changes size after each answer. Keep looking at the top C, then tap its direction below.</Text>
        </>}

        {phase === 'color' && <>
          <Text style={s.sectionTitle} accessibilityRole="header">Colour vision · plate {colorIndex + 1}/{DIGITS.length}</Text>
          <Text style={s.body}>Keep both eyes open. Hold the phone at arm&apos;s length. Which number do you see in the circle?</Text>
          <View style={[s.chartCard, { backgroundColor: '#FFFFFF', borderColor: colors.glassStroke }]}>{/* theme-exempt: dot plate colours need a stable white test field */}<ColorPlate digit={currentDigit} variant={(seed + colorIndex) % 3} size={chartSize} /></View>
          <View style={s.answerGrid}>{[currentDigit, DIGITS[(seed + colorIndex + 1) % DIGITS.length], DIGITS[(seed + colorIndex + 2) % DIGITS.length]].sort().map(value => <Pressable key={value} accessibilityRole="button" onPress={() => answerColor(value)} style={[s.answerButton, { backgroundColor: colors.surfaceSolid, borderColor: colors.glassStroke }]}><Text style={s.answerLabel}>{value}</Text></Pressable>)}</View>
          <Pressable accessibilityRole="button" onPress={() => answerColor('Nothing')} style={[s.secondaryButton, { borderColor: colors.glassStroke }]}><Text style={[s.secondaryLabel, { color: colors.text }]}>Nothing</Text></Pressable>
          <Text accessibilityLiveRegion="polite" style={[s.feedback, { color: feedback ? colors.success : colors.danger }]}>{feedback === null ? '' : feedback ? 'Matched' : 'Different answer'}</Text>
          <Text style={[s.smallNote, { color: colors.textDim }]}>These original dot patterns are inspired by the portal flow. Phone colours are not calibrated Ishihara plates.</Text>
        </>}
        {phase === 'colorResult' && <><View style={card}><Text style={s.cardTitle}>Colour vision screen result</Text><Text style={s.body}>{colorCorrect}/{DIGITS.length} numbers matched with both eyes open.</Text><Text style={[s.smallNote, { color: colors.textDim }]}>A different answer here cannot diagnose a colour-vision deficiency.</Text></View><Pressable accessibilityRole="button" onPress={() => setPhase('astig')} style={primary}><Text style={s.primaryLabel}>Next: astigmatism</Text></Pressable></>}

        {phase === 'astig' && <>
          <Text style={s.sectionTitle} accessibilityRole="header">Astigmatism · {astigEye === 'right' ? 'Right eye' : 'Left eye'}</Text>
          <Text style={s.body}>Cover your {astigEye === 'right' ? 'left' : 'right'} eye. At arm&apos;s length, focus on the centre. Do all lines look equally dark?</Text>
          <View style={[s.chartCard, { backgroundColor: '#FFFFFF', borderColor: colors.glassStroke }]}>{/* theme-exempt: black line chart needs a stable white test field */}<AstigChart size={chartSize} /></View>
          <View style={s.choiceRow}><Pressable accessibilityRole="button" onPress={() => answerAstig(true)} style={[s.choice, { backgroundColor: colors.surfaceSolid, borderColor: colors.glassStroke }]}><Text style={s.answerLabel}>Yes</Text></Pressable><Pressable accessibilityRole="button" onPress={() => answerAstig(false)} style={[s.choice, { backgroundColor: colors.surfaceSolid, borderColor: colors.glassStroke }]}><Text style={s.answerLabel}>No / not sure</Text></Pressable></View>
        </>}
        {phase === 'astigResult' && <><View style={card}><Text style={s.cardTitle}>Astigmatism line screen</Text><Text style={s.body}>Right eye: {astigSame.right ? 'lines looked equal' : 'difference or uncertainty reported'}</Text><Text style={s.body}>Left eye: {astigSame.left ? 'lines looked equal' : 'difference or uncertainty reported'}</Text><Text style={[s.smallNote, { color: colors.textDim }]}>Only an eye examination can diagnose astigmatism.</Text></View><Pressable accessibilityRole="button" onPress={() => setPhase('amsler')} style={primary}><Text style={s.primaryLabel}>Next: Amsler grid</Text></Pressable></>}

        {phase === 'amsler' && <>
          <Text style={s.sectionTitle} accessibilityRole="header">Amsler grid · {amslerEye === 'right' ? 'Right eye' : 'Left eye'}</Text>
          <Text style={s.body}>Cover your {amslerEye === 'right' ? 'left' : 'right'} eye. Hold the phone about 30 cm away. Keep looking at the centre dot.</Text>
          <View style={[s.chartCard, { backgroundColor: '#FFFFFF', borderColor: colors.glassStroke }]}>{/* theme-exempt: black grid needs a stable white test field */}<AmslerGrid size={chartSize} /></View>
          <Text style={s.cardTitle}>{amslerQuestion === 0 ? 'Do all lines and squares look regular?' : 'Are any parts missing, distorted or darker?'}</Text>
          <View style={s.choiceRow}><Pressable accessibilityRole="button" onPress={() => answerAmsler(true)} style={[s.choice, { backgroundColor: colors.surfaceSolid, borderColor: colors.glassStroke }]}><Text style={s.answerLabel}>Yes</Text></Pressable><Pressable accessibilityRole="button" onPress={() => answerAmsler(false)} style={[s.choice, { backgroundColor: colors.surfaceSolid, borderColor: colors.glassStroke }]}><Text style={s.answerLabel}>No</Text></Pressable></View>
        </>}
        {phase === 'amslerResult' && <><View style={card}><Text style={s.cardTitle}>Amsler grid screen</Text><Text style={s.body}>Right eye: {amslerConcern.right ? 'difference reported' : 'no difference reported'}</Text><Text style={s.body}>Left eye: {amslerConcern.left ? 'difference reported' : 'no difference reported'}</Text><Text style={[s.smallNote, { color: colors.textDim }]}>A grid cannot diagnose or rule out retinal disease.</Text></View><Pressable accessibilityRole="button" onPress={() => setPhase('summary')} style={primary}><Text style={s.primaryLabel}>View all results</Text></Pressable></>}

        {phase === 'summary' && <>
          <View style={card}>
            <Text style={s.cardTitle}>Your screen vision result</Text>
            <Text style={s.body}>Based on the C-gap answers you gave in this test:</Text>
            <Text style={s.resultHeading}>Right eye</Text>
            <Text style={s.scoreValue}>{step.rightCorrect}/{TRIALS_PER_EYE}</Text>
            <Text style={s.body}>Screen clarity index: {indexLabel(step.rightCorrect)} (−4 to +4 scale)</Text>
            <Text style={s.resultHeading}>{step.rightCorrect >= CLEAR_SCREEN_MATCHES ? 'Appears clear on this screen' : 'Further eye check recommended'}</Text>
            <Text style={s.body}>C gaps matched · smallest matched detail level {step.rightCompleted}/{SCREEN_LEVELS}</Text>
            <Text style={s.resultHeading}>Left eye</Text>
            <Text style={s.scoreValue}>{step.leftCorrect}/{TRIALS_PER_EYE}</Text>
            <Text style={s.body}>Screen clarity index: {indexLabel(step.leftCorrect)} (−4 to +4 scale)</Text>
            <Text style={s.resultHeading}>{step.leftCorrect >= CLEAR_SCREEN_MATCHES ? 'Appears clear on this screen' : 'Further eye check recommended'}</Text>
            <Text style={s.body}>C gaps matched · smallest matched detail level {step.leftCompleted}/{SCREEN_LEVELS}</Text>
            <Text style={s.resultHeading}>Spectacle power (+/− D): not measured</Text>
            <Text style={[s.smallNote, { color: colors.textDim }]}>The −4 to +4 index only remaps correct C-gap answers: negative means fewer matched, positive means more. It is not diopters, myopia or hyperopia. An eye examination is needed for a prescription. Detail level 0 means no level was matched.</Text>
          </View>
          <View style={card}><Text style={s.cardTitle}>Your screening responses</Text><Text style={s.resultHeading}>Right eye</Text><Text style={s.body}>C gaps {step.rightCorrect}/{TRIALS_PER_EYE} · detail level {step.rightCompleted}/{SCREEN_LEVELS} · lines {astigSame.right ? 'equal' : 'uneven/unsure'} · grid {amslerConcern.right ? 'difference' : 'no difference'}</Text><Text style={s.resultHeading}>Left eye</Text><Text style={s.body}>C gaps {step.leftCorrect}/{TRIALS_PER_EYE} · detail level {step.leftCompleted}/{SCREEN_LEVELS} · lines {astigSame.left ? 'equal' : 'uneven/unsure'} · grid {amslerConcern.left ? 'difference' : 'no difference'}</Text><Text style={s.resultHeading}>Both eyes</Text><Text style={s.body}>Colour plates {colorCorrect}/{DIGITS.length} · {glasses === 'with' ? 'with glasses/contacts' : 'without glasses/contacts'}</Text></View>
          <View style={card}><Text style={s.cardTitle}>Suggested app display setup</Text><Text style={s.body}>{suggestComfort ? 'Try at least comfort level 3 of 6: larger text, higher contrast and less transparent backgrounds.' : 'Your current display can stay as it is. You can still adjust Vision Comfort if reading feels uncomfortable.'}</Text><Text style={[s.smallNote, { color: colors.textDim }]}>This is a starting point from your screen responses, not an eye treatment. Check the live preview and save only when it looks comfortable.</Text><Pressable accessibilityRole="button" onPress={() => router.replace({ pathname: '/vision-comfort' as any, params: { eyeCheckSuggestion: suggestComfort ? '1' : '0', eyeCheckGlasses: glasses } })} style={primary}><Text style={s.primaryLabel}>Preview Vision Comfort suggestion</Text></Pressable></View>
          <View style={card}><Text style={s.cardTitle}>What to do next</Text><Text style={s.body}>{needsExam ? 'One or more responses were unclear. Arrange a professional eye examination, especially for new or unequal changes.' : 'No difficulty was reported on this screen. Continue regular professional eye checks.'}</Text><Text style={s.body}>These detail levels are not 20/20 acuity, eyesight percentages, myopia or hyperopia, or plus/minus prescription values. Results stay on this screen only.</Text><Text style={s.body}>Seek prompt care for sudden sight loss, flashes or eye pain.</Text><Text style={s.body}>{NOTICE}</Text></View>
          <Pressable accessibilityRole="button" onPress={restart} style={primary}><Text style={s.primaryLabel}>Re-do test</Text></Pressable>
          <Pressable accessibilityRole="link" onPress={() => Linking.openURL(WHOEYES_URL)} style={s.linkButton}><Text style={[s.linkLabel, { color: colors.accentOn }]}>Learn about WHOeyes screening</Text></Pressable>
        </>}
      </View>
    </ScrollView>
  </View>;
}

function LandoltC({ size, angle }: { size: number; angle: number }) {
  return <Svg width={size} height={size} viewBox="0 0 100 100" accessibilityLabel="C gap symbol"><G rotation={angle} origin="50,50"><Path d="M 70 27 A 32 32 0 1 0 70 73" stroke="#111111" strokeWidth={14} strokeLinecap="butt" fill="none" /></G></Svg>;
}

const DIGIT_MASK: Record<string, readonly string[]> = {
  '2': ['11110', '00001', '00001', '01110', '10000', '10000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['01111', '10000', '10000', '11110', '10001', '10001', '01110'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '11110'],
};
const PLATE_COLORS = [['#B86C60', '#93A66E'], ['#A56377', '#82A99B'], ['#B57553', '#9BAA76']] as const;
function ColorPlate({ digit, variant, size }: { digit: string; variant: number; size: number }) {
  const mask = DIGIT_MASK[digit];
  const [figure, background] = PLATE_COLORS[variant];
  return <Svg width={size} height={size} viewBox="0 0 220 220" accessibilityLabel="Coloured dot number plate"><Circle cx={110} cy={110} r={106} fill="#F8F5ED" />{Array.from({ length: 225 }, (_, index) => {
    const col = index % 15, row = Math.floor(index / 15);
    const x = 14 + col * 13.7 + ((index * 7) % 5 - 2), y = 14 + row * 13.7 + ((index * 11) % 5 - 2);
    if ((x - 110) ** 2 + (y - 110) ** 2 > 99 ** 2) return null;
    const inDigit = row >= 4 && row < 11 && col >= 5 && col < 10 && mask[row - 4][col - 5] === '1';
    return <Circle key={index} cx={x} cy={y} r={4.2 + index % 3} fill={inDigit ? figure : background} />;
  })}</Svg>;
}
function AstigChart({ size }: { size: number }) {
  return <Svg width={size} height={size * 0.85} viewBox="0 0 220 190" accessibilityLabel="Semicircle line chart">{Array.from({ length: 13 }, (_, index) => {
    const angle = Math.PI + index * Math.PI / 12;
    return <Line key={index} x1={110} y1={175} x2={110 + Math.cos(angle) * 90} y2={175 + Math.sin(angle) * 90} stroke="#111111" strokeWidth={2} />;
  })}<Circle cx={110} cy={175} r={5} fill="#111111" /></Svg>;
}
function AmslerGrid({ size }: { size: number }) {
  return <Svg width={size} height={size} viewBox="0 0 220 220" accessibilityLabel="Amsler grid with centre dot">{Array.from({ length: 21 }, (_, index) => <G key={index}><Line x1={10 + index * 10} y1={10} x2={10 + index * 10} y2={210} stroke="#222222" strokeWidth={0.8} /><Line x1={10} y1={10 + index * 10} x2={210} y2={10 + index * 10} stroke="#222222" strokeWidth={0.8} /></G>)}<Circle cx={110} cy={110} r={3} fill="#111111" /></Svg>;
}

const s = StyleSheet.create({
  screen: { flex: 1 }, scroll: { paddingHorizontal: 16, paddingBottom: 40 }, container: { width: '100%', maxWidth: 680, alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, minWidth: 0 }, back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }, title: { fontSize: 24, fontWeight: '800', flexShrink: 1 }, subtitle: { fontSize: 14, lineHeight: 20, marginBottom: 20 },
  card: { borderWidth: 1, borderRadius: 16, padding: 16, marginBottom: 16, gap: 12 }, cardTitle: { fontSize: 18, fontWeight: '800' }, sectionTitle: { fontSize: 20, fontWeight: '800', marginBottom: 12 }, body: { fontSize: 15, lineHeight: 22 }, smallNote: { fontSize: 13, lineHeight: 19, marginTop: 8 }, resultHeading: { fontSize: 16, fontWeight: '800', marginTop: 4 }, scoreValue: { fontSize: 32, lineHeight: 40, fontWeight: '800' },
  primaryButton: { minHeight: 54, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, alignItems: 'center', justifyContent: 'center', marginTop: 8 }, primaryLabel: { color: ON_PRIMARY, fontSize: 16, fontWeight: '800', textAlign: 'center' },
  secondaryButton: { minHeight: 54, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, alignItems: 'center', justifyContent: 'center', marginTop: 10 }, secondaryLabel: { fontSize: 15, fontWeight: '700', textAlign: 'center' }, linkButton: { minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingVertical: 10, marginTop: 8 }, linkLabel: { fontSize: 14, fontWeight: '700', textAlign: 'center' },
  chartCard: { minHeight: 170, borderWidth: 1, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginVertical: 16, padding: 16, gap: 24 },
  directionRing: { position: 'relative' }, directionButton: { position: 'absolute', alignItems: 'center', justifyContent: 'center' }, directionArrow: { color: ON_PRIMARY, fontSize: 27, fontWeight: '800' }, ringCenter: { position: 'absolute', width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }, narrowDirectionGrid: { width: '100%', flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, narrowDirectionButton: { position: 'relative', width: '46%', flexGrow: 1, minHeight: 44, borderRadius: 12 },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 10 }, choice: { flexGrow: 1, minWidth: '44%', minHeight: 54, borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center', padding: 10 }, choiceText: { fontSize: 15, fontWeight: '700', textAlign: 'center' },
  answerGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 }, answerButton: { width: '30%', flexGrow: 1, minHeight: 54, borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }, answerLabel: { fontSize: 16, fontWeight: '700', textAlign: 'center' }, feedback: { fontSize: 15, fontWeight: '800', textAlign: 'center', marginTop: 10 },
  cardLine: { width: 28, borderWidth: 2, borderStyle: 'dashed', borderRadius: 5, alignSelf: 'center', marginVertical: 12 }, calibrationTrack: { minHeight: 30, borderRadius: 15, alignSelf: 'center', justifyContent: 'center' }, calibrationThumb: { position: 'absolute', width: 24, height: 24, borderRadius: 12 }, setupIcon: { alignSelf: 'center', marginVertical: 16 },
});
