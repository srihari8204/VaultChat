import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Switch,
  Text as NativeText, TextInput, View,
} from 'react-native';
import { AppText as Text, AuroraBackground } from '../components/ui';
import { useTheme } from '../lib/theme';
import { PALETTES } from '../constants/theme';
import { clampVisionLevel, comfortLevelFromTrack } from '../lib/visionComfortModel';
import {
  deriveVisionMetrics, useVisionComfort, type VisionProfile, type VisionProfileKey,
} from '../lib/visionComfort';

const TRACK_HEIGHT = 192;

export default function VisionComfortScreen() {
  const router = useRouter();
  const { colors, scheme } = useTheme();
  const previewColors = PALETTES[scheme];
  const { ready, activeProfile, profiles, saveProfile, setActiveProfile, resetProfile } = useVisionComfort();
  const [selected, setSelected] = useState<VisionProfileKey>('with-glasses');
  const [draft, setDraft] = useState<VisionProfile>({ level: 0, highContrast: false, reduceTransparency: false });
  const [busy, setBusy] = useState(false);
  const [sightStep, setSightStep] = useState(true);
  const [sightKind, setSightKind] = useState<string | null>(null);
  const [spectaclePower, setSpectaclePower] = useState('');
  const initialized = useRef(false);

  useEffect(() => {
    if (!ready || initialized.current) return;
    initialized.current = true;
    setSelected(activeProfile);
    setDraft(profiles[activeProfile]);
  }, [ready, activeProfile, profiles]);

  const chooseProfile = (key: VisionProfileKey) => {
    if (key === selected) return;
    if (JSON.stringify(draft) !== JSON.stringify(profiles[selected])) {
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
  const reset = async () => {
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

  const textColor = previewColors.bubbleInText;
  const bubbleColor = draft.highContrast ? previewColors.surfaceSolid : previewColors.bubbleIn;
  const metrics = deriveVisionMetrics(draft);
  const fontSize = Math.round(16 * metrics.textScale);
  const spacing = Math.round(12 * metrics.spacingScale);

  const finishSightStep = (useHint: boolean) => {
    if (useHint && sightKind && sightKind !== 'I don’t know' && sightKind !== 'I know my spectacle power' && sightKind !== 'Short sight / nearsighted (far away blurry)' && draft.level === 0) changeLevel(2);
    setSightKind(null);
    setSpectaclePower('');
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
            <Text style={s.title}>Vision Comfort</Text>
          </View>
          {!ready ? <ActivityIndicator color={colors.primary} style={s.loading} /> : (
            <>
              <Text style={[s.intro, { color: colors.textDim }]}>Drag until this chat looks clear and comfortable. You decide what works best for your sight.</Text>

              <Text style={[s.sectionTitle, { color: colors.textDim }]}>PROFILE</Text>
              <View style={s.profileRow}>
                {([
                  ['with-glasses', 'With glasses', 'glasses-outline'],
                  ['without-glasses', 'Without glasses', 'eye-outline'],
                ] as const).map(([key, label, icon]) => (
                  <Pressable key={key} accessibilityRole="button" accessibilityState={{ selected: selected === key }}
                    onPress={() => chooseProfile(key)}
                    style={[s.profileButton, { backgroundColor: selected === key ? colors.primary : colors.surfaceSolid, borderColor: selected === key ? colors.primary : colors.glassStroke }]}>
                    <Ionicons name={icon} size={20} color={selected === key ? '#FFFFFF' : colors.text} />
                    <Text style={[s.profileLabel, { color: selected === key ? '#FFFFFF' : colors.text }]}>{label}</Text>
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
                    <NativeText style={{ color: '#FFFFFF', fontSize: Math.max(15, fontSize - 1), fontWeight: '700' }}>Reply</NativeText>
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
                <Pressable accessibilityRole="button" accessibilityLabel="Open Eye Check" onPress={() => router.push('/eye-check' as any)} style={[s.checkAction, { borderColor: colors.glassStroke }]}>
                  <Ionicons name="eye-outline" size={22} color={colors.accentOn} />
                  <Text style={[s.checkActionLabel, { color: colors.text }]}>Try the separate-eye symbol check</Text>
                  <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
                </Pressable>
              </View>

              {sightStep && <View style={[s.sightCard, { backgroundColor: colors.surfaceSolid, borderColor: colors.glassStroke }]}>
                <Text style={s.sightTitle}>Which sight description feels familiar?</Text>
                <Text style={[s.optionHint, { color: colors.textDim }]}>Optional. This suggests a general starting level only. Your spectacle number is never interpreted or saved. It does not correct eyesight or replace glasses or an eye examination.</Text>
                <View style={s.sightChoices}>
                  {['Short sight / nearsighted (far away blurry)', 'Long sight / farsighted (near text blurry)', 'Astigmatism', 'Reading glasses / presbyopia', 'I know my spectacle power', 'I don’t know'].map(kind => (
                    <Pressable key={kind} accessibilityRole="button" accessibilityState={{ selected: sightKind === kind }} onPress={() => setSightKind(kind)}
                      style={[s.sightChoice, { borderColor: sightKind === kind ? colors.primary : colors.glassStroke, backgroundColor: sightKind === kind ? colors.glassSoft : colors.bg }]}>
                      <Text style={s.sightChoiceText}>{kind}</Text>
                    </Pressable>
                  ))}
                </View>
                {sightKind === 'I know my spectacle power' && <>
                  <TextInput accessibilityLabel="Known spectacle power, optional" placeholder="For example, -2.00 D or +4.00 D" placeholderTextColor={colors.textDim} value={spectaclePower} onChangeText={setSpectaclePower} maxLength={24}
                    style={[s.sightInput, { borderColor: colors.glassStroke, color: colors.text }]} />
                  <Text style={[s.optionHint, { color: colors.textDim }]}>You can enter a known power from -4.00 D to +4.00 D. This is not measured by the app, and the number is discarded when you leave this step. Adjust the preview until it looks clear.</Text>
                </>}
                {sightKind === 'Short sight / nearsighted (far away blurry)' && <Text style={[s.optionHint, { color: colors.textDim }]}>This phone preview checks near-screen comfort only. Distance sight needs a measured-distance chart or an eye examination.</Text>}
                <View style={s.sightActions}>
                  <Pressable accessibilityRole="button" onPress={() => finishSightStep(false)} style={s.sightAction}><Text style={{ color: colors.textDim }}>Skip</Text></Pressable>
                  <Pressable accessibilityRole="button" onPress={() => finishSightStep(true)} style={[s.sightAction, { backgroundColor: colors.primary }]}><Text style={{ color: '#FFFFFF', fontWeight: '700' }}>Use starting hint</Text></Pressable>
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
              <Pressable accessibilityRole="button" accessibilityLabel="Save my Vision Comfort settings" disabled={busy} onPress={save}
                style={[s.saveButton, { backgroundColor: colors.primary, opacity: busy ? 0.6 : 1 }]}>
                {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={s.saveLabel}>✓ This looks clear · Save</Text>}
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Reset selected Vision Comfort profile" disabled={busy} onPress={reset} style={s.resetButton}>
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
  sightInput: { borderWidth: 1, borderRadius: 12, minHeight: 48, marginTop: 12, paddingHorizontal: 12, fontSize: 16 },
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
  saveLabel: { color: '#FFFFFF', fontSize: 16, fontWeight: '800', textAlign: 'center' },
  resetButton: { minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  resetLabel: { fontSize: 14, fontWeight: '600' },
});
