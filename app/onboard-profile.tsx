// app/onboard-profile.tsx — new-user profile. Email + mobile prefilled & disabled;
// DOB (age ≥ 13); first/last name prefilled from Google, editable; status (≤139,
// emoji allowed). "Next" → security questions. Nothing is sent yet — all held in
// the in-memory onboarding store until /auth/profile/init at the end of the chain.

import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  Alert, Image, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { onboarding } from '../lib/onboarding';
import { Sheet, type SheetAction } from '../components/ui/Sheet';
import { AuroraBackground } from '../components/ui';

function ageOf(d: Date): number {
  const n = new Date();
  let a = n.getFullYear() - d.getFullYear();
  const m = n.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && n.getDate() < d.getDate())) a--;
  return a;
}
const iso = (d: Date) => d.toISOString().slice(0, 10);

export default function OnboardProfile() {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const st = onboarding.get();

  const [firstName, setFirstName] = useState(st.firstName);
  const [lastName, setLastName] = useState(st.lastName);
  const [status, setStatus] = useState(st.status);
  const [dob, setDob] = useState<Date | null>(st.dob ? new Date(st.dob) : null);
  const [showPicker, setShowPicker] = useState(false);
  const [pic, setPic] = useState<string | null>(st.profilePicLocalUri);
  // 4 buttons when a photo exists — over Android's 3-button ceiling.
  const [sheet, setSheet] = useState<{ title: string; message?: string; actions: SheetAction[] } | null>(null);

  const pickFrom = async (source: 'camera' | 'gallery') => {
    const perm = source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert('Permission needed', `Allow ${source} access to set a photo.`); return; }
    const fn = source === 'camera' ? ImagePicker.launchCameraAsync : ImagePicker.launchImageLibraryAsync;
    const res = await fn({ allowsEditing: true, aspect: [1, 1], quality: 0.85 });   // square crop
    if (res.canceled || !res.assets?.[0]) return;
    const uri = res.assets[0].uri;
    setPic(uri);
    onboarding.set({ profilePicLocalUri: uri });
  };
  const choosePhoto = () => setSheet({
    title: 'Profile photo',
    actions: [
      { label: 'Take photo', icon: 'camera-outline', onPress: () => pickFrom('camera') },
      { label: 'Choose from gallery', icon: 'images-outline', onPress: () => pickFrom('gallery') },
      ...(pic ? [{ label: 'Remove', icon: 'trash-outline' as const, destructive: true, onPress: () => { setPic(null); onboarding.set({ profilePicLocalUri: null }); } }] : []),
    ],
  });

  const ageOk = !!dob && ageOf(dob) >= 13;
  const valid = firstName.trim().length > 0 && ageOk;

  const next = () => {
    if (!valid || !dob) return;
    onboarding.set({
      firstName: firstName.trim(), lastName: lastName.trim(),
      status: status.slice(0, 139), dob: iso(dob),
    });
    router.push('/onboard-security' as any);
  };

  return (
    <View style={s.screen}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          <TouchableOpacity onPress={() => router.back()} style={s.back}><Ionicons name="arrow-back" size={24} color={colors.text} /></TouchableOpacity>
          <Text style={s.title}>Set up your profile</Text>
          <Text style={s.step}>Step 1 of 3</Text>

          <TouchableOpacity style={s.avatarWrap} onPress={choosePhoto} activeOpacity={0.8}>
            {pic
              ? <Image source={{ uri: pic }} style={s.avatar} />
              : <View style={[s.avatar, s.avatarEmpty]}><Ionicons name="add" size={34} color={colors.textDim} /></View>}
            <Text style={s.avatarHint}>{pic ? 'Change photo' : 'Add photo'}</Text>
          </TouchableOpacity>

          <Text style={s.label}>EMAIL</Text>
          <TextInput style={[s.input, s.disabled]} value={st.email} editable={false} />

          <Text style={s.label}>MOBILE</Text>
          <TextInput style={[s.input, s.disabled]} value={st.phone} editable={false} />

          <View style={s.rowTwo}>
            <View style={{ flex: 1 }}>
              <Text style={s.label}>FIRST NAME</Text>
              <TextInput style={s.input} value={firstName} onChangeText={setFirstName} placeholder="First" placeholderTextColor={colors.textFaint} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.label}>LAST NAME</Text>
              <TextInput style={s.input} value={lastName} onChangeText={setLastName} placeholder="Last" placeholderTextColor={colors.textFaint} />
            </View>
          </View>

          <Text style={s.label}>DATE OF BIRTH</Text>
          <TouchableOpacity style={s.input} onPress={() => setShowPicker(true)} activeOpacity={0.8}>
            <Text style={{ color: dob ? colors.text : colors.textFaint, fontSize: 16, paddingTop: 2 }}>
              {dob ? dob.toLocaleDateString() : 'Select your date of birth'}
            </Text>
          </TouchableOpacity>
          {!!dob && !ageOk && <Text style={s.warn}>You must be at least 13.</Text>}
          {showPicker && (
            <DateTimePicker
              value={dob ?? new Date(2000, 0, 1)}
              mode="date"
              maximumDate={new Date()}
              display={Platform.OS === 'ios' ? 'spinner' : 'default'}
              onChange={(_, d) => { setShowPicker(Platform.OS === 'ios'); if (d) setDob(d); }}
            />
          )}

          <Text style={s.label}>STATUS</Text>
          <TextInput
            style={s.input}
            value={status}
            onChangeText={(t) => setStatus(t.slice(0, 139))}
            placeholder="Hey there! I'm on VaultChat ✨"
            placeholderTextColor={colors.textFaint}
            maxLength={139}
          />
          <Text style={s.counter}>{status.length}/139</Text>

          <TouchableOpacity style={[s.cta, !valid && s.ctaOff]} onPress={next} disabled={!valid} activeOpacity={0.85}>
            <Text style={s.ctaTxt}>Next</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>

      <Sheet
        visible={!!sheet}
        title={sheet?.title}
        message={sheet?.message}
        actions={sheet?.actions ?? []}
        onClose={() => setSheet(null)}
      />
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  body: { padding: 24, paddingTop: HEADER_TOP, paddingBottom: 48 },
  back: { marginBottom: 8 },
  backTxt: { color: c.text, fontSize: 26 },
  title: { color: c.text, fontSize: 24, fontWeight: '900' },
  step: { color: c.primary, fontSize: 12, fontWeight: '700', marginTop: 4, marginBottom: 16 },
  avatarWrap: { alignItems: 'center', marginBottom: 8 },
  avatar: { width: 96, height: 96, borderRadius: 48 },
  avatarEmpty: { backgroundColor: c.glassSoft, borderWidth: 1, borderColor: c.glassStroke, alignItems: 'center', justifyContent: 'center' },
  avatarPlus: { color: c.textDim, fontSize: 34, fontWeight: '300' },
  avatarHint: { color: c.primary, fontSize: 13, fontWeight: '700', marginTop: 8 },
  label: { color: c.textDim, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginTop: 16, marginBottom: 6 },
  input: { minHeight: 52, borderRadius: 12, borderWidth: 1, borderColor: c.glassStroke, backgroundColor: c.glassSoft, paddingHorizontal: 14, paddingVertical: 14, color: c.text, fontSize: 16 },
  disabled: { opacity: 0.6 },
  rowTwo: { flexDirection: 'row', gap: 12 },
  counter: { color: c.textFaint, fontSize: 11, alignSelf: 'flex-end', marginTop: 4 },
  warn: { color: c.danger, fontSize: 12, marginTop: 6 },
  cta: { marginTop: 28, height: 56, borderRadius: 16, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  ctaOff: { opacity: 0.4 },
  ctaTxt: { color: '#fff', fontSize: 16, fontWeight: '800' },
});
