import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Switch,
  Text as NativeText, View,
} from 'react-native';
import { AppText as Text, AuroraBackground } from '../components/ui';
import { useTheme } from '../lib/theme';
import { PALETTES } from '../constants/theme';
import { clampVisionLevel, comfortLevelFromTrack } from '../lib/visionComfortModel';
import {
  deriveVisionMetrics, useVisionComfort, type VisionProfile, type VisionProfileKey,
} from '../lib/visionComfort';

const TRACK_HEIGHT = 192;
// Label colour on solid primary fills. The palette has no on-primary token;
// white is the brand's button text in both themes.
const ON_PRIMARY = '#FFFFFF';

// Sight descriptions, keyed by id so the hint logic does not depend on copy.
// `larger`: the description is about near text, so start from a larger level.
const SIGHT_KINDS = [
  { id: 'short', label: 'Short sight / nearsighted (far away blurry)', larger: false },
  { id: 'long', label: 'Long sight / farsighted (near text blurry)', larger: true },
  { id: 'astigmatism', label: 'Astigmatism', larger: true },
  { id: 'reading', label: 'Reading glasses / presbyopia', larger: true },
  { id: 'power', label: 'I know my spectacle power', larger: false },
  { id: 'unknown', label: 'I don’t know', larger: false },
] as const;
type SightKindId = (typeof SIGHT_KINDS)[number]['id'];

const sameProfile = (a: VisionProfile, b: VisionProfile) =>
  a.level === b.level && a.highContrast === b.highContrast && a.reduceTransparency === b.reduceTransparency;

export default function VisionComfortScreen() {
  const router = useRouter();
  const { eyeCheckSuggestion, eyeCheckGlasses } = useLocalSearchParams<{ eyeCheckSuggestion?: string; eyeCheckGlasses?: string }>();
  const { colors, scheme } = useTheme();
  const previewColors = PALETTES[scheme];
  const { ready, activeProfile, profiles, saveProfile, setActiveProfile, resetProfile } = useVisionComfort();
  const [selected, setSelected] = useState<VisionProfileKey>('with-glasses');
  const [draft, setDraft] = useState<VisionProfile>({ level: 0, highContrast: false, reduceTransparency: false });
  const [busy, setBusy] = useState(false);
  const [sightStep, setSightStep] = useState(true);
  const [sightKind, setSightKind] = useState<SightKindId | null>(null);
  const initialized = useRef(false);

  // Leaving with unsaved edits asks first, the same way switching profile does.
  // beforeRemove covers the Back button, hardware back and the swipe gesture.
  const dirty = ready && !sameProfile(draft, profiles[selected]);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const navigation = useNavigation();
  useEffect(() => navigation.addListener('beforeRemove', (ev) => {
    // beforeRemove is preventable at runtime; the generic navigation type says otherwise.
    const e = ev as typeof ev & { preventDefault(): void };
    if (!dirtyRef.current) return;
    e.preventDefault();
    Alert.alert('Discard unsaved changes?', 'Save this profile first if you want to keep your adjustments.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => navigation.dispatch(e.data.action) },
    ]);
  }), [navigation]);

  useEffect(() => {
    if (!ready || initialized.current) return;
    initialized.current = true;
    const key = eyeCheckSuggestion !== undefined ? (eyeCheckGlasses === 'without' ? 'without-glasses' : 'with-glasses') : activeProfile;
    setSelected(key);
    setDraft(eyeCheckSuggestion === '1'
      ? { ...profiles[key], level: Math.max(2, profiles[key].level), highContrast: true, reduceTransparency: true }
      : profiles[key]);
  }, [ready, activeProfile, profiles, eyeCheckSuggestion, eyeCheckGlasses]);

  const chooseProfile = (key: VisionProfileKey) => {
    if (key === selected) return;
    if (!sameProfile(draft, profiles[selected])) {
      Alert.alert('Discard unsaved changes?', 'Save this profile first if you want to keep your adjustments.', [
        { text: 'Keep editing', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: () => { setSelected(key); setDraft(profiles[key]); } },
      ]);
      return;
    }
    setSelected(key);
    setDraft(profiles[key]);
  };
  const changeLevel = (level: number) => setDraft(current => ({ ...current, level: clampVisionLevel(level) }));
  const updateFromTrack = (y: number) => changeLevel(comfortLevelFromTrack(y, TRACK_HEIGHT));

  const save = async () => {
    if (busy) return;
    setBusy(true);
    let saved = false;
    try {
      await saveProfile(selected, draft);
      saved = true;
      if (selected !== activeProfile) await setActiveProfile(selected);
      Alert.alert('Vision Comfort saved', 'Your display settings are ready.');
    } catch {
      Alert.alert(saved ? 'Profile saved, but not active' : 'Could not save',
        saved ? 'Try switching to this profile again.' : 'Your changes are still shown here. Please try again.');
    } finally {
      setBusy(false);
    }
  };
  const doReset = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await resetProfile(selected);
      setDraft({ level: 0, highContrast: false, reduceTransparency: false });
    } catch {
      Alert.alert('Could not reset', 'Please try again.');
    } finally {
      setBusy(false);
    }
  };
  const reset = () => {
    if (busy) return;
    const name = selected === 'with-glasses' ? 'With glasses' : 'Without glasses';
    Alert.alert(`Reset “${name}”?`, 'This profile goes back to the standard display: normal text size, contrast and transparency.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reset', style: 'destructive', onPress: () => { void doReset(); } },
    ]);
  };

  const textColor = previewColors.bubbleInText;
  const bubbleColor = draft.highContrast ? previewColors.surfaceSolid : previewColors.bubbleIn;
  const metrics = deriveVisionMetrics(draft);
  const fontSize = Math.round(16 * metrics.textScale);
  const spacing = Math.round(12 * metrics.spacingScale);

  const finishSightStep = (useHint: boolean) => {
    const kind = SIGHT_KINDS.find(k => k.id === sightKind);
    if (useHint && kind?.larger && draft.level === 0) changeLevel(2);
    setSightKind(null);
    setSightStep(false);
  };

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <AuroraBackground />
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        <View style={s.container}>
          <View style={s.header}>
            <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={s.iconButton}>
              <Ionicons name="arrow-back" size={24} color={colors.text} />
            </Pressable>
            <Text style={s.title} accessibilityRole="header">Vision Comfort</Text>
          </View>
          {!ready ? <ActivityIndicator color={colors.primary} style={s.loading} /> : (
            <>
              <Text style={[s.intro, { color: colors.textDim }]}>Drag until this chat looks clear and comfortable. You decide what works best for your sight.</Text>
              {eyeCheckSuggestion !== undefined && <View style={[s.checkCard, { backgroundColor: colors.surfaceSolid, borderColor: colors.glassStroke }]}><Text style={s.checkTitle}>Eye Check display suggestion</Text><Text style={[s.checkStep, { color: colors.textDim }]}>{eyeCheckSuggestion === '1' ? 'A starting preview with larger text, higher contrast and solid backgrounds is ready below.' : 'Your existing display profile is ready below. Adjust it if reading feels uncomfortable.'} Check the sample chat with both eyes and change anything you need before saving.</Text><Text style={[s.checkNote, { color: colors.textDim }]}>This changes app readability only. It does not measure or correct spectacle power.</Text></View>}

              <Text style={[s.sectionTitle, { color: colors.textDim }]}>PROFILE</Text>
              <View style={s.profileRow}>
                {([
                  ['with-glasses', 'With glasses', 'glasses-outline'],
                  ['without-glasses', 'Without glasses', 'eye-outline'],
                ] as const).map(([key, label, icon]) => (
                  <Pressable key={key} accessibilityRole="button" accessibilityState={{ selected: selected === key }}
                    onPress={() => chooseProfile(key)}
                    style={[s.profileButton, { backgroundColor: selected === key ? colors.primary : colors.surfaceSolid, borderColor: selected === key ? colors.primary : colors.glassStroke }]}>
                    <Ionicons name={icon} size={20} color={selected === key ? ON_PRIMARY : colors.text} />
                    <Text style={[s.profileLabel, { color: selected === key ? ON_PRIMARY : colors.text }]}>{label}</Text>
                  </Pressable>
                ))}
              </View>

              <Text style={[s.sectionTitle, { color: colors.textDim }]}>LIVE PREVIEW</Text>
              <View style={[s.previewRow, { backgroundColor: draft.reduceTransparency || draft.highContrast ? previewColors.surfaceSolid : previewColors.glassSoft, borderColor: previewColors.glassStroke }]}>
                <View style={s.chatPreview}>
                  <NativeText style={[s.sender, { color: previewColors.text, fontSize: fontSize + 1, lineHeight: Math.ceil((fontSize + 1) * 1.4 * metrics.lineScale), fontWeight: metrics.bold ? '700' : '600' }]}>Ravi</NativeText>
                  <View style={[s.bubble, { backgroundColor: bubbleColor, padding: spacing }]}>
                    <NativeText style={{ color: textColor, fontSize, lineHeight: Math.ceil(fontSize * 1.45 * metrics.lineScale), fontWeight: metrics.bold ? '600' : '400' }}>Can you meet me at 6:30 PM?</NativeText>
                    <NativeText style={{ color: textColor, fontSize, lineHeight: Math.ceil(fontSize * 1.45 * metrics.lineScale), fontWeight: metrics.bold ? '600' : '400', marginTop: 6 }}>ఈ రోజు కలుద్దామా?</NativeText>
                    <NativeText style={{ color: draft.highContrast ? textColor : previewColors.bubbleMetaIn, fontSize: Math.max(13, fontSize - 3), marginTop: 6 }}>Today · 6:12 PM</NativeText>
                  </View>
                  <View style={[s.sampleControl, { backgroundColor: previewColors.primary, minHeight: Math.max(44, Math.round(44 * metrics.controlScale)) }]}>
                    <NativeText style={{ color: ON_PRIMARY, fontSize: Math.max(15, fontSize - 1), fontWeight: '700' }}>Reply</NativeText>
                  </View>
                </View>
                <View style={s.sliderColumn}>
                  <Pressable accessibilityRole="button" accessibilityLabel="Increase comfort level" onPress={() => changeLevel(draft.level + 1)} style={[s.adjustButton, { borderColor: colors.glassStroke }]}>
                    <Ionicons name="add" size={24} color={colors.text} />
                  </Pressable>
                  <View accessible accessibilityRole="adjustable" accessibilityLabel="Vision Comfort level"
                    accessibilityValue={{ min: 0, max: 5, now: draft.level, text: `Level ${draft.level + 1} of 6` }}
                    accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
                    onAccessibilityAction={event => changeLevel(draft.level + (event.nativeEvent.actionName === 'increment' ? 1 : -1))}
                    onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => true}
                    onResponderGrant={event => updateFromTrack(event.nativeEvent.locationY)}
                    onResponderMove={event => updateFromTrack(event.nativeEvent.locationY)}
                    style={s.track}>
                    <View pointerEvents="none" style={[s.trackLine, { backgroundColor: colors.glassStroke }]} />
                    <View pointerEvents="none" style={[s.thumb, { backgroundColor: colors.primary, bottom: `${(draft.level / 5) * 100}%` }]} />
                  </View>
                  <Pressable accessibilityRole="button" accessibilityLabel="Decrease comfort level" onPress={() => changeLevel(draft.level - 1)} style={[s.adjustButton, { borderColor: colors.glassStroke }]}>
                    <Ionicons name="remove" size={24} color={colors.text} />
                  </Pressable>
                </View>
              </View>
              <Text style={[s.levelLabel, { color: colors.textDim }]}>Comfort level {draft.level + 1} of 6 · Text enlargement +{Math.round((metrics.textScale - 1) * 100)}%</Text>

              <View style={[s.checkCard, { backgroundColor: colors.surfaceSolid, borderColor: colors.glassStroke }]}>
                <Text style={s.checkTitle}>Check your screen comfort</Text>
                <Text style={[s.checkStep, { color: colors.textDim }]}>1. Hold the phone at your usual reading distance. Use your usual glasses for the selected profile.</Text>
                <Text style={[s.checkStep, { color: colors.textDim }]}>2. Read both the English and Telugu messages. Try each eye separately, then both together.</Text>
                <Text style={[s.checkStep, { color: colors.textDim }]}>3. Drag or use +/− until the words and Reply button feel most comfortable. Adjust contrast if needed, then save.</Text>
                <Text style={[s.checkNote, { color: colors.textDim }]}>This is a screen comfort check. The enlargement percentage is a display setting, not an eyesight percentage or prescription.</Text>
                <Pressable accessibilityRole="button" accessibilityLabel="Open Eye Check" onPress={() => router.push('/eye-check')} style={[s.checkAction, { borderColor: colors.glassStroke }]}>
                  <Ionicons name="eye-outline" size={22} color={colors.accentOn} />
                  <Text style={[s.checkActionLabel, { color: colors.text }]}>Try the separate-eye symbol check</Text>
                  <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
                </Pressable>
              </View>

              {sightStep && <View style={[s.sightCard, { backgroundColor: colors.surfaceSolid, borderColor: colors.glassStroke }]}>
                <Text style={s.sightTitle}>Which sight description feels familiar?</Text>
                <Text style={[s.optionHint, { color: colors.textDim }]}>Optional. This suggests a general starting level only. It does not correct eyesight or replace glasses or an eye examination.</Text>
                <View style={s.sightChoices} accessibilityRole="radiogroup" accessibilityLabel="Sight description">
                  {SIGHT_KINDS.map(kind => (
                    <Pressable key={kind.id} accessibilityRole="radio" accessibilityState={{ checked: sightKind === kind.id }} onPress={() => setSightKind(kind.id)}
                      style={[s.sightChoice, { borderColor: sightKind === kind.id ? colors.primary : colors.glassStroke, backgroundColor: sightKind === kind.id ? colors.glassSoft : colors.bg }]}>
                      <Text style={s.sightChoiceText}>{kind.label}</Text>
                    </Pressable>
                  ))}
                </View>
                {/* The app never reads a spectacle power, so it no longer asks for one. */}
                {sightKind === 'power' && <Text style={[s.optionHint, { color: colors.textDim }]}>The app does not use your spectacle power. Use the profile for the glasses you wear and adjust the preview until it looks clear.</Text>}
                {sightKind === 'short' && <Text style={[s.optionHint, { color: colors.textDim }]}>This phone preview checks near-screen comfort only. Distance sight needs a measured-distance chart or an eye examination.</Text>}
                <View style={s.sightActions}>
                  <Pressable accessibilityRole="button" onPress={() => finishSightStep(false)} style={s.sightAction}><Text style={{ color: colors.textDim }}>Skip</Text></Pressable>
                  <Pressable accessibilityRole="button" onPress={() => finishSightStep(true)} style={[s.sightAction, { backgroundColor: colors.primary }]}><Text style={{ color: ON_PRIMARY, fontWeight: '700' }}>Use starting hint</Text></Pressable>
                </View>
              </View>}

              <View style={[s.optionCard, { backgroundColor: colors.surfaceSolid, borderColor: colors.glassStroke }]}>
                <View style={s.optionRow}>
                  <View style={s.optionCopy}>
                    <Text style={s.optionTitle}>Higher contrast</Text>
                    <Text style={[s.optionHint, { color: colors.textDim }]}>Make chat text and surfaces easier to distinguish</Text>
                  </View>
                  <Switch accessibilityLabel="Higher contrast" value={draft.highContrast} onValueChange={highContrast => setDraft(current => ({ ...current, highContrast }))} trackColor={{ true: colors.primary }} />
                </View>
                <View style={s.optionRow}>
                  <View style={s.optionCopy}>
                    <Text style={s.optionTitle}>Reduce transparency</Text>
                    <Text style={[s.optionHint, { color: colors.textDim }]}>Use solid surfaces behind content</Text>
                  </View>
                  <Switch accessibilityLabel="Reduce transparency" value={draft.reduceTransparency} onValueChange={reduceTransparency => setDraft(current => ({ ...current, reduceTransparency }))} trackColor={{ true: colors.primary }} />
                </View>
              </View>

              <Text style={[s.note, { color: colors.textDim }]}>This adjusts the app display for comfort. It does not correct eyesight or replace glasses or an eye examination.</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Save my Vision Comfort settings" accessibilityState={{ disabled: busy, busy }} disabled={busy} onPress={save}
                style={[s.saveButton, { backgroundColor: colors.primary, opacity: busy ? 0.6 : 1 }]}>
                {busy ? <ActivityIndicator color={ON_PRIMARY} /> : <Text style={s.saveLabel}>✓ This looks clear · Save</Text>}
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Reset selected Vision Comfort profile" accessibilityState={{ disabled: busy }} disabled={busy} onPress={reset} style={s.resetButton}>
                <Text style={[s.resetLabel, { color: colors.textDim }]}>Reset this profile</Text>
              </Pressable>
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { paddingHorizontal: 16, paddingBottom: 40 },
  container: { width: '100%', maxWidth: 680, alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 22, fontWeight: '800', flexShrink: 1 },
  loading: { marginTop: 48 },
  intro: { fontSize: 15, lineHeight: 22, marginBottom: 20 },
  sightCard: { borderWidth: 1, borderRadius: 16, padding: 16, marginTop: 20 },
  sightTitle: { fontSize: 17, fontWeight: '700', marginBottom: 8 },
  sightChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16 },
  sightChoice: { maxWidth: '100%', borderWidth: 1, borderRadius: 12, minHeight: 44, paddingHorizontal: 12, paddingVertical: 9, justifyContent: 'center' },
  sightChoiceText: { fontSize: 13, fontWeight: '600', flexShrink: 1 },
  sightActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, marginTop: 16 },
  sightAction: { minHeight: 48, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 12 },
  sectionTitle: { fontSize: 12, fontWeight: '700', letterSpacing: 1, marginBottom: 8, marginTop: 16 },
  profileRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  profileButton: { flexGrow: 1, minWidth: 130, minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1, borderRadius: 12 },
  profileLabel: { fontSize: 14, fontWeight: '700', flexShrink: 1 },
  previewRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 16, borderWidth: 1, padding: 12 },
  chatPreview: { flex: 1, minWidth: 0, alignItems: 'flex-start' },
  sender: { marginBottom: 8 },
  bubble: { maxWidth: '100%', borderRadius: 16 },
  sampleControl: { marginTop: 14, minWidth: 64, paddingHorizontal: 14, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  sliderColumn: { width: 48, alignItems: 'center', gap: 8 },
  adjustButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderRadius: 12 },
  track: { width: 48, height: TRACK_HEIGHT, marginVertical: 8 },
  trackLine: { position: 'absolute', width: 8, height: '100%', borderRadius: 4, left: 20 },
  thumb: { position: 'absolute', width: 30, height: 30, borderRadius: 15, left: 9, marginBottom: -15 },
  levelLabel: { marginTop: 10, fontSize: 13 },
  checkCard: { marginTop: 18, borderWidth: 1, borderRadius: 16, padding: 16, gap: 8 },
  checkTitle: { fontSize: 16, fontWeight: '700' },
  checkStep: { fontSize: 13, lineHeight: 20 },
  checkNote: { fontSize: 12, lineHeight: 18, marginTop: 4 },
  checkAction: { minHeight: 52, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 10 },
  checkActionLabel: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: '700' },
  optionCard: { marginTop: 22, borderRadius: 14, borderWidth: 1, paddingHorizontal: 14 },
  optionRow: { flexDirection: 'row', alignItems: 'center', minHeight: 72, paddingVertical: 10, gap: 12 },
  optionCopy: { flex: 1, minWidth: 0 },
  optionTitle: { fontSize: 15, fontWeight: '700' },
  optionHint: { fontSize: 12, lineHeight: 18, marginTop: 3 },
  note: { marginTop: 18, fontSize: 12, lineHeight: 18 },
  saveButton: { marginTop: 18, minHeight: 52, borderRadius: 12, alignItems: 'center', justifyContent: 'center', padding: 10 },
  saveLabel: { color: ON_PRIMARY, fontSize: 16, fontWeight: '800', textAlign: 'center' },
  resetButton: { minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  resetLabel: { fontSize: 14, fontWeight: '600' },
});
