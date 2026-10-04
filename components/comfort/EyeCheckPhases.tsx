// components/comfort/EyeCheckPhases.tsx — one component per Eye Check phase.
//
// Split out of app/eye-check.tsx, which keeps the state and the answer logic
// and decides which phase shows. These only render and report taps; the copy,
// layout and order are the screen's, unchanged.
import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { Linking, Pressable, StyleSheet, Text as NativeText, View } from 'react-native';
import { AppText as Text } from '../ui';
import { useTheme } from '../../lib/theme';
import { PALETTES } from '../../constants/theme';
import {
  CLEAR_SCREEN_MATCHES, expectedOrientation, SCREEN_LEVELS, screenClarityIndex, symbolScale,
  TRIALS_PER_EYE, type CheckStep,
} from '../../lib/eyeCheckModel';
import { AmslerGrid, AstigChart, ChartField, ColorPlate, LandoltC } from './EyeCheckCharts';

export type Glasses = 'with' | 'without';
type Eye = 'right' | 'left';
type PerEye<T> = { right: T; left: T };

export const EYE_CHECK_NOTICE = 'ఇది కేవలం ప్రాథమిక స్క్రీనింగ్ మాత్రమే. ఇది డాక్టర్ కంటి పరీక్షకు ప్రత్యామ్నాయం కాదు';
const WHOEYES_URL = 'https://www.who.int/teams/noncommunicable-diseases/sensory-functions-disability-and-rehabilitation/whoeyes';
// Marks drawn on the fixed white test field take the LIGHT palette's colours,
// which are made for white.
const ON_WHITE_FIELD = PALETTES.light;
const DIRECTIONS = [
  { angle: 0, symbol: '→', label: 'right' }, { angle: 45, symbol: '↘', label: 'down right' },
  { angle: 90, symbol: '↓', label: 'down' }, { angle: 135, symbol: '↙', label: 'down left' },
  { angle: 180, symbol: '←', label: 'left' }, { angle: 225, symbol: '↖', label: 'up left' },
  { angle: 270, symbol: '↑', label: 'up' }, { angle: 315, symbol: '↗', label: 'up right' },
] as const;

const indexLabel = (correct: number) => {
  const value = screenClarityIndex(correct);
  return `${value > 0 ? '+' : ''}${value} points`;
};
const eyeName = (eye: Eye) => (eye === 'right' ? 'Right eye' : 'Left eye');
const otherEye = (eye: Eye) => (eye === 'right' ? 'left' : 'right');
const clearVerdict = (correct: number) => (correct >= CLEAR_SCREEN_MATCHES ? 'Appears clear on this screen' : 'Further eye check recommended');

// ─── Shared pieces ───────────────────────────────────────────────────────────

function Card({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return <View style={[s.card, { backgroundColor: colors.surfaceSolid, borderColor: colors.glassStroke }]}>{children}</View>;
}

function Note({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return <Text style={[s.smallNote, { color: colors.textDim }]}>{children}</Text>;
}

function PrimaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={[s.primaryButton, { backgroundColor: colors.primary }]}>
      <Text style={[s.primaryLabel, { color: colors.onPrimary }]}>{label}</Text>
    </Pressable>
  );
}

function SecondaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={[s.secondaryButton, { borderColor: colors.glassStroke }]}>
      <Text style={[s.secondaryLabel, { color: colors.text }]}>{label}</Text>
    </Pressable>
  );
}

/** A Yes/No style answer tile. */
function Choice({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={[s.choice, { backgroundColor: colors.surfaceSolid, borderColor: colors.glassStroke }]}>
      <Text style={s.answerLabel}>{label}</Text>
    </Pressable>
  );
}

/** Spoken and shown answer feedback (the chart's icon is visual only). */
function Feedback({ value }: { value: boolean | null }) {
  const { colors } = useTheme();
  return (
    <Text accessibilityLiveRegion="polite" style={[s.feedback, { color: value ? colors.success : colors.danger }]}>
      {value === null ? '' : value ? 'Matched' : 'Different answer'}
    </Text>
  );
}

// ─── Phases ──────────────────────────────────────────────────────────────────

export function IntroPhase({ onStart }: { onStart: () => void }) {
  return <>
    <Card>
      <Text style={s.cardTitle}>Before you start</Text>
      <Text style={s.body}>{EYE_CHECK_NOTICE}</Text>
      <Text style={s.body}>This digital check is not a medical diagnosis. Screen size, brightness, room light, distance and glasses affect what you see. An optometrist or ophthalmologist must check your eyes for a prescription.</Text>
    </Card>
    <Card>
      <Text style={s.cardTitle}>Four short checks</Text>
      <Text style={s.body}>1. Match the gap in a rotating C, separately for each eye.</Text>
      <Text style={s.body}>2. Read six coloured dot plates with both eyes open.</Text>
      <Text style={s.body}>3. Compare dark lines separately with each eye.</Text>
      <Text style={s.body}>4. Check the Amsler grid separately with each eye.</Text>
    </Card>
    <Card>
      <Text style={s.cardTitle}>Urgent symptoms</Text>
      <Text style={s.body}>Sudden sight loss, eye pain, flashes or many new floaters need prompt eye care. Do not delay care to take this check.</Text>
    </Card>
    <PrimaryButton label="Start screen setup" onPress={onStart} />
  </>;
}

export function SetupPhase({ setupStep, calibration, onCalibrate, trackWidth, glasses, onGlasses, onNext }: {
  setupStep: number;
  calibration: number;
  onCalibrate: (update: (value: number) => number) => void;
  trackWidth: number;
  glasses: Glasses;
  onGlasses: (value: Glasses) => void;
  onNext: () => void;
}) {
  const { colors } = useTheme();
  const fromTrack = (x: number) => 0.65 + Math.max(0, Math.min(1, x / trackWidth)) * 0.6;
  return <>
    <Text style={s.sectionTitle} accessibilityRole="header">Screen setup · {setupStep + 1}/4</Text>
    <Card>
      {setupStep === 0 && <>
        <Text style={s.cardTitle}>Calibrate with a standard card</Text>
        <Text style={s.body}>Place the short edge of a bank card beside the dashed line. Adjust until their lengths match. This uses the card setup from the reference test, adapted to a phone screen.</Text>
        <View style={[s.cardLine, { height: 340 * calibration, borderColor: colors.primary }]} />
        <View
          onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => true}
          onResponderGrant={event => onCalibrate(() => fromTrack(event.nativeEvent.locationX))}
          onResponderMove={event => onCalibrate(() => fromTrack(event.nativeEvent.locationX))}
          style={[s.calibrationTrack, { width: trackWidth, backgroundColor: colors.glassStroke }]}
          accessibilityRole="adjustable" accessibilityLabel="Card calibration"
          accessibilityValue={{ min: 65, max: 125, now: Math.round(calibration * 100) }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={event => onCalibrate(value => Math.max(0.65, Math.min(1.25, value + (event.nativeEvent.actionName === 'increment' ? 0.05 : -0.05))))}
        >
          <View pointerEvents="none" style={[s.calibrationThumb, { left: ((calibration - 0.65) / 0.6) * (trackWidth - 24), backgroundColor: colors.primary }]} />
        </View>
        <Note>Calibration helps screen sizing but cannot make a phone test clinically exact.</Note>
      </>}
      {setupStep === 1 && <>
        <Text style={s.cardTitle}>Glasses or contacts</Text>
        <Text style={s.body}>Use your usual glasses or contacts if needed. You can repeat the check without them later. Keep the same choice for both eyes.</Text>
        <View style={s.choiceRow} accessibilityRole="radiogroup" accessibilityLabel="Glasses or contacts">
          {(['with', 'without'] as const).map(value => (
            <Pressable
              key={value}
              accessibilityRole="radio"
              accessibilityState={{ checked: glasses === value }}
              onPress={() => onGlasses(value)}
              style={[s.choice, { backgroundColor: glasses === value ? colors.primary : colors.bg, borderColor: colors.glassStroke }]}
            >
              <Text style={[s.choiceText, { color: glasses === value ? colors.onPrimary : colors.text }]}>{value === 'with' ? 'With glasses' : 'Without glasses'}</Text>
            </Pressable>
          ))}
        </View>
      </>}
      {setupStep === 2 && <>
        <Text style={s.cardTitle}>Check one eye at a time</Text>
        <Text style={s.body}>Cover your left eye gently without pressing on it. We will check the right eye first, then switch sides.</Text>
        <Ionicons name="eye-outline" size={100} color={colors.primary} style={s.setupIcon} />
      </>}
      {setupStep === 3 && <>
        <Text style={s.cardTitle}>Keep your distance</Text>
        <Text style={s.body}>Hold your device at arm&apos;s length, face it directly, and keep the distance steady. Set brightness to 100% if comfortable; lower it if glare hurts.</Text>
        <Note>Ask someone to tap the gap directions if you need to stay farther from the phone.</Note>
      </>}
    </Card>
    <PrimaryButton label={setupStep === 3 ? 'Start right eye' : 'Next'} onPress={onNext} />
  </>;
}

export function AcuitySwitch({ rightCorrect, onStartLeft }: { rightCorrect: number; onStartLeft: () => void }) {
  return <>
    <Card>
      <Text style={s.cardTitle}>Now check your left eye</Text>
      <Text style={s.body}>Right eye: {rightCorrect}/{TRIALS_PER_EYE} gaps matched. Cover your right eye gently. Keep the same distance, light and glasses choice.</Text>
    </Card>
    <PrimaryButton label="Start left eye" onPress={onStartLeft} />
  </>;
}

export function AcuityResult({ step, onNext }: { step: CheckStep; onNext: () => void }) {
  return <>
    <Card>
      <Text style={s.cardTitle}>C-gap screen test scores</Text>
      <Text style={s.resultHeading}>Right eye</Text>
      <Text style={s.scoreValue}>{step.rightCorrect}/{TRIALS_PER_EYE}</Text>
      <Text style={s.body}>Screen clarity index: {indexLabel(step.rightCorrect)} · {clearVerdict(step.rightCorrect)} · smallest matched detail level {step.rightCompleted}/{SCREEN_LEVELS}</Text>
      <Text style={s.resultHeading}>Left eye</Text>
      <Text style={s.scoreValue}>{step.leftCorrect}/{TRIALS_PER_EYE}</Text>
      <Text style={s.body}>Screen clarity index: {indexLabel(step.leftCorrect)} · {clearVerdict(step.leftCorrect)} · smallest matched detail level {step.leftCompleted}/{SCREEN_LEVELS}</Text>
      <Note>The −4 to +4 index only remaps your C-gap answers: negative means fewer gaps matched, positive means more. It is not spectacle power (+/− D), eyesight percentage or a prescription.</Note>
    </Card>
    <PrimaryButton label="Next: colour vision" onPress={onNext} />
  </>;
}

export function AcuityTrial({ step, glasses, calibration, ringSize, ringButtonSize, ringRadius, feedback, onAnswer }: {
  step: CheckStep;
  glasses: Glasses;
  calibration: number;
  ringSize: number;
  ringButtonSize: number;
  ringRadius: number;
  feedback: boolean | null;
  onAnswer: (angle: number | null) => void;
}) {
  const { colors } = useTheme();
  const narrow = ringSize < 190;
  return <>
    <Text style={s.sectionTitle} accessibilityRole="header">Visual acuity · {eyeName(step.eye)}</Text>
    <Text style={s.body}>Cover your {otherEye(step.eye)} eye. At arm&apos;s length, match the gap in the top C using the direction buttons below.</Text>
    <Note>Gap {step.trial + 1}/{TRIALS_PER_EYE} · {glasses === 'with' ? 'with glasses' : 'without glasses'}</Note>
    <ChartField>
      <LandoltC size={Math.max(14, Math.min(100, 64 * symbolScale(step.stage) * calibration))} angle={expectedOrientation(step)} />
      <View style={narrow ? s.narrowDirectionGrid : [s.directionRing, { width: ringSize, height: ringSize }]}>
        {DIRECTIONS.map(direction => {
          const rad = direction.angle * Math.PI / 180;
          const place = narrow ? s.narrowDirectionButton : {
            width: ringButtonSize, height: ringButtonSize, borderRadius: ringButtonSize / 2,
            left: (ringSize - ringButtonSize) / 2 + Math.cos(rad) * ringRadius,
            top: (ringSize - ringButtonSize) / 2 + Math.sin(rad) * ringRadius,
          };
          return (
            <Pressable key={direction.angle} accessibilityRole="button" accessibilityLabel={`Gap ${direction.label}`} onPress={() => onAnswer(direction.angle)}
              style={[s.directionButton, place, { backgroundColor: colors.primary }]}>
              <NativeText maxFontSizeMultiplier={1} style={[s.directionArrow, { color: colors.onPrimary }]}>{direction.symbol}</NativeText>
            </Pressable>
          );
        })}
        {!narrow && (
          <View style={[s.ringCenter, { left: (ringSize - 36) / 2, top: (ringSize - 36) / 2 }]}>
            <Ionicons
              name={feedback === null ? 'eye-outline' : feedback ? 'checkmark-circle' : 'close-circle'}
              size={36}
              color={feedback === null ? colors.primary : feedback ? ON_WHITE_FIELD.success : ON_WHITE_FIELD.danger}
            />
          </View>
        )}
      </View>
    </ChartField>
    {/* The ring's centre icon is visual only (and hidden on narrow screens); this says it. */}
    <Feedback value={feedback} />
    <SecondaryButton label="I can't see the gap" onPress={() => onAnswer(null)} />
    <Note>The gap changes direction and the C changes size after each answer. Keep looking at the top C, then tap its direction below.</Note>
  </>;
}

export function ColorTrial({ plate, total, options, digit, variant, chartSize, feedback, onAnswer }: {
  plate: number;
  total: number;
  options: string[];
  digit: string;
  variant: number;
  chartSize: number;
  feedback: boolean | null;
  onAnswer: (value: string) => void;
}) {
  const { colors } = useTheme();
  return <>
    <Text style={s.sectionTitle} accessibilityRole="header">Colour vision · plate {plate}/{total}</Text>
    <Text style={s.body}>Keep both eyes open. Hold the phone at arm&apos;s length. Which number do you see in the circle?</Text>
    <ChartField><ColorPlate digit={digit} variant={variant} size={chartSize} /></ChartField>
    <View style={s.answerGrid}>
      {options.map(value => (
        <Pressable key={value} accessibilityRole="button" onPress={() => onAnswer(value)} style={[s.answerButton, { backgroundColor: colors.surfaceSolid, borderColor: colors.glassStroke }]}>
          <Text style={s.answerLabel}>{value}</Text>
        </Pressable>
      ))}
    </View>
    <SecondaryButton label="Nothing" onPress={() => onAnswer('Nothing')} />
    <Feedback value={feedback} />
    <Note>These original dot patterns are inspired by the portal flow. Phone colours are not calibrated Ishihara plates.</Note>
  </>;
}

export function ColorResult({ correct, total, onNext }: { correct: number; total: number; onNext: () => void }) {
  return <>
    <Card>
      <Text style={s.cardTitle}>Colour vision screen result</Text>
      <Text style={s.body}>{correct}/{total} numbers matched with both eyes open.</Text>
      <Note>A different answer here cannot diagnose a colour-vision deficiency.</Note>
    </Card>
    <PrimaryButton label="Next: astigmatism" onPress={onNext} />
  </>;
}

export function AstigTrial({ eye, chartSize, onAnswer }: { eye: Eye; chartSize: number; onAnswer: (same: boolean) => void }) {
  return <>
    <Text style={s.sectionTitle} accessibilityRole="header">Astigmatism · {eyeName(eye)}</Text>
    <Text style={s.body}>Cover your {otherEye(eye)} eye. At arm&apos;s length, focus on the centre. Do all lines look equally dark?</Text>
    <ChartField><AstigChart size={chartSize} /></ChartField>
    <View style={s.choiceRow}>
      <Choice label="Yes" onPress={() => onAnswer(true)} />
      <Choice label="No / not sure" onPress={() => onAnswer(false)} />
    </View>
  </>;
}

export function AstigResult({ same, onNext }: { same: PerEye<boolean | null>; onNext: () => void }) {
  return <>
    <Card>
      <Text style={s.cardTitle}>Astigmatism line screen</Text>
      <Text style={s.body}>Right eye: {same.right ? 'lines looked equal' : 'difference or uncertainty reported'}</Text>
      <Text style={s.body}>Left eye: {same.left ? 'lines looked equal' : 'difference or uncertainty reported'}</Text>
      <Note>Only an eye examination can diagnose astigmatism.</Note>
    </Card>
    <PrimaryButton label="Next: Amsler grid" onPress={onNext} />
  </>;
}

export function AmslerTrial({ eye, question, chartSize, onAnswer }: { eye: Eye; question: number; chartSize: number; onAnswer: (yes: boolean) => void }) {
  return <>
    <Text style={s.sectionTitle} accessibilityRole="header">Amsler grid · {eyeName(eye)}</Text>
    <Text style={s.body}>Cover your {otherEye(eye)} eye. Hold the phone about 30 cm away. Keep looking at the centre dot.</Text>
    <ChartField><AmslerGrid size={chartSize} /></ChartField>
    <Text style={s.cardTitle}>{question === 0 ? 'Do all lines and squares look regular?' : 'Are any parts missing, distorted or darker?'}</Text>
    <View style={s.choiceRow}>
      <Choice label="Yes" onPress={() => onAnswer(true)} />
      <Choice label="No" onPress={() => onAnswer(false)} />
    </View>
  </>;
}

export function AmslerResult({ concern, onNext }: { concern: PerEye<boolean>; onNext: () => void }) {
  return <>
    <Card>
      <Text style={s.cardTitle}>Amsler grid screen</Text>
      <Text style={s.body}>Right eye: {concern.right ? 'difference reported' : 'no difference reported'}</Text>
      <Text style={s.body}>Left eye: {concern.left ? 'difference reported' : 'no difference reported'}</Text>
      <Note>A grid cannot diagnose or rule out retinal disease.</Note>
    </Card>
    <PrimaryButton label="View all results" onPress={onNext} />
  </>;
}

export function SummaryPhase({ step, astigSame, amslerConcern, colorCorrect, colorTotal, glasses, suggestComfort, needsExam, onPreview, onRestart }: {
  step: CheckStep;
  astigSame: PerEye<boolean | null>;
  amslerConcern: PerEye<boolean>;
  colorCorrect: number;
  colorTotal: number;
  glasses: Glasses;
  suggestComfort: boolean;
  needsExam: boolean;
  onPreview: () => void;
  onRestart: () => void;
}) {
  const { colors } = useTheme();
  const responses = (eye: Eye) => {
    const correct = eye === 'right' ? step.rightCorrect : step.leftCorrect;
    const level = eye === 'right' ? step.rightCompleted : step.leftCompleted;
    return `C gaps ${correct}/${TRIALS_PER_EYE} · detail level ${level}/${SCREEN_LEVELS} · lines ${astigSame[eye] ? 'equal' : 'uneven/unsure'} · grid ${amslerConcern[eye] ? 'difference' : 'no difference'}`;
  };
  return <>
    <Card>
      <Text style={s.cardTitle}>Your screen vision result</Text>
      <Text style={s.body}>Based on the C-gap answers you gave in this test:</Text>
      <Text style={s.resultHeading}>Right eye</Text>
      <Text style={s.scoreValue}>{step.rightCorrect}/{TRIALS_PER_EYE}</Text>
      <Text style={s.body}>Screen clarity index: {indexLabel(step.rightCorrect)} (−4 to +4 scale)</Text>
      <Text style={s.resultHeading}>{clearVerdict(step.rightCorrect)}</Text>
      <Text style={s.body}>C gaps matched · smallest matched detail level {step.rightCompleted}/{SCREEN_LEVELS}</Text>
      <Text style={s.resultHeading}>Left eye</Text>
      <Text style={s.scoreValue}>{step.leftCorrect}/{TRIALS_PER_EYE}</Text>
      <Text style={s.body}>Screen clarity index: {indexLabel(step.leftCorrect)} (−4 to +4 scale)</Text>
      <Text style={s.resultHeading}>{clearVerdict(step.leftCorrect)}</Text>
      <Text style={s.body}>C gaps matched · smallest matched detail level {step.leftCompleted}/{SCREEN_LEVELS}</Text>
      <Text style={s.resultHeading}>Spectacle power (+/− D): not measured</Text>
      <Note>The −4 to +4 index only remaps correct C-gap answers: negative means fewer matched, positive means more. It is not diopters, myopia or hyperopia. An eye examination is needed for a prescription. Detail level 0 means no level was matched.</Note>
    </Card>
    <Card>
      <Text style={s.cardTitle}>Your screening responses</Text>
      <Text style={s.resultHeading}>Right eye</Text>
      <Text style={s.body}>{responses('right')}</Text>
      <Text style={s.resultHeading}>Left eye</Text>
      <Text style={s.body}>{responses('left')}</Text>
      <Text style={s.resultHeading}>Both eyes</Text>
      <Text style={s.body}>Colour plates {colorCorrect}/{colorTotal} · {glasses === 'with' ? 'with glasses/contacts' : 'without glasses/contacts'}</Text>
    </Card>
    <Card>
      <Text style={s.cardTitle}>Suggested app display setup</Text>
      <Text style={s.body}>{suggestComfort ? 'Try at least comfort level 3 of 6: larger text, higher contrast and less transparent backgrounds.' : 'Your current display can stay as it is. You can still adjust Vision Comfort if reading feels uncomfortable.'}</Text>
      <Note>This is a starting point from your screen responses, not an eye treatment. Check the live preview and save only when it looks comfortable.</Note>
      <PrimaryButton label="Preview Vision Comfort suggestion" onPress={onPreview} />
    </Card>
    <Card>
      <Text style={s.cardTitle}>What to do next</Text>
      <Text style={s.body}>{needsExam ? 'One or more responses were unclear. Arrange a professional eye examination, especially for new or unequal changes.' : 'No difficulty was reported on this screen. Continue regular professional eye checks.'}</Text>
      <Text style={s.body}>These detail levels are not 20/20 acuity, eyesight percentages, myopia or hyperopia, or plus/minus prescription values. Results stay on this screen only.</Text>
      <Text style={s.body}>Seek prompt care for sudden sight loss, flashes or eye pain.</Text>
      <Text style={s.body}>{EYE_CHECK_NOTICE}</Text>
    </Card>
    <PrimaryButton label="Re-do test" onPress={onRestart} />
    <Pressable accessibilityRole="link" accessibilityHint="Opens the WHO website" onPress={() => { void Linking.openURL(WHOEYES_URL); }} style={s.linkButton}>
      <Text style={[s.linkLabel, { color: colors.accentOn }]}>Learn about WHOeyes screening</Text>
    </Pressable>
  </>;
}

const s = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 16, padding: 16, marginBottom: 16, gap: 12 },
  cardTitle: { fontSize: 18, fontWeight: '800' },
  sectionTitle: { fontSize: 20, fontWeight: '800', marginBottom: 12 },
  body: { fontSize: 15, lineHeight: 22 },
  smallNote: { fontSize: 13, lineHeight: 19, marginTop: 8 },
  resultHeading: { fontSize: 16, fontWeight: '800', marginTop: 4 },
  scoreValue: { fontSize: 32, lineHeight: 40, fontWeight: '800' },
  primaryButton: { minHeight: 54, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  primaryLabel: { fontSize: 16, fontWeight: '800', textAlign: 'center' },
  secondaryButton: { minHeight: 54, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, alignItems: 'center', justifyContent: 'center', marginTop: 10 },
  secondaryLabel: { fontSize: 15, fontWeight: '700', textAlign: 'center' },
  linkButton: { minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingVertical: 10, marginTop: 8 },
  linkLabel: { fontSize: 14, fontWeight: '700', textAlign: 'center' },
  directionRing: { position: 'relative' },
  directionButton: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  directionArrow: { fontSize: 27, fontWeight: '800' },
  ringCenter: { position: 'absolute', width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  narrowDirectionGrid: { width: '100%', flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  narrowDirectionButton: { position: 'relative', width: '46%', flexGrow: 1, minHeight: 44, borderRadius: 12 },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 10 },
  choice: { flexGrow: 1, minWidth: '44%', minHeight: 54, borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center', padding: 10 },
  choiceText: { fontSize: 15, fontWeight: '700', textAlign: 'center' },
  answerGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  answerButton: { width: '30%', flexGrow: 1, minHeight: 54, borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  answerLabel: { fontSize: 16, fontWeight: '700', textAlign: 'center' },
  feedback: { fontSize: 15, fontWeight: '800', textAlign: 'center', marginTop: 10 },
  cardLine: { width: 28, borderWidth: 2, borderStyle: 'dashed', borderRadius: 5, alignSelf: 'center', marginVertical: 12 },
  calibrationTrack: { minHeight: 30, borderRadius: 15, alignSelf: 'center', justifyContent: 'center' },
  calibrationThumb: { position: 'absolute', width: 24, height: 24, borderRadius: 12 },
  setupIcon: { alignSelf: 'center', marginVertical: 16 },
});
