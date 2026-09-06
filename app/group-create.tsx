// app/group-create.tsx — create a typed group (Groups & Circles, G2).
//
// Replaces the name-only create in family-setup.tsx. A group now carries a type,
// which drives its icon, colour, member cap and default permission matrix. The
// cap shown here comes from the SERVER's group_type_config via the create
// response — this screen never hardcodes one, so raising a cap stays a config
// change rather than an app release.
//
// Privacy is a real setting, not decoration: `invite_only` routes every redeem
// through the admin approval queue that already exists.

import React, { useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput, Alert,
  ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { brandAlpha } from '../constants/theme';
import { GROUP_TYPES, groupTypeInfo, type GroupType } from '../lib/groups/catalog';
import { saveGroup, setActiveGroupId } from '../lib/groups/store';
import { createGroupChat } from '../lib/chatService';

const PALETTE = ['#9D6FD0', '#4A9FFF', '#22C55E', '#F59E0B', '#EC4899', '#14B8A6', '#EF4444', '#8B5CF6'];
const ICONS: (keyof typeof Ionicons.glyphMap)[] = [
  'home', 'people', 'briefcase', 'airplane', 'school', 'football',
  'medkit', 'storefront', 'library', 'leaf', 'car', 'bicycle',
];

export default function GroupCreateScreen() {
  const { colors } = useTheme();
  const router = useRouter();

  const [type, setType] = useState<GroupType>('family');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [privacy, setPrivacy] = useState<'private' | 'invite_only'>('private');
  const [icon, setIcon] = useState<string | null>(null);
  const [color, setColor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const info = useMemo(() => groupTypeInfo(type), [type]);
  // Explicit choice wins; otherwise the type's identity shows through.
  const shownIcon = (icon as keyof typeof Ionicons.glyphMap) || info.icon;
  const shownColor = color || info.color;

  const create = async () => {
    const n = name.trim();
    if (!n) { Alert.alert('Name it', 'Give your group a name.'); return; }
    if (busy) return;
    setBusy(true);
    try {
      const res = await createGroupChat(
        n,
        // Created solo and filled by invitation, exactly as a circle was.
        { allowEmpty: true },
        {
          groupType: type,
          description: description.trim() || undefined,
          privacy,
          // Only send an override when the user actually picked one, so the
          // server's type default remains the source of truth otherwise.
          icon: icon ?? undefined,
          color: color ?? undefined,
        },
      );
      await saveGroup({
        id: String(res.id), name: n, groupType: type,
        icon: icon ?? null, color: color ?? null, privacy,
      });
      await setActiveGroupId(String(res.id));
      // Replace: Back should not return to a half-filled create form.
      router.replace({ pathname: '/group-invites' as any, params: { chatId: String(res.id), name: n } });
    } catch (e: any) {
      Alert.alert('Could not create group', e?.message ?? 'Try again.');
    } finally { setBusy(false); }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: 'New group', headerTitleAlign: 'center' }} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 44 }} keyboardShouldPersistTaps="handled">

        {/* live preview — the identity the group will actually have */}
        <View style={[st.preview, { backgroundColor: colors.glassSoft, borderColor: colors.glassStroke }]}>
          <View style={[st.previewIcon, { backgroundColor: shownColor + '22' }]}>
            <Ionicons name={shownIcon} size={28} color={shownColor} />
          </View>
          <Text style={{ color: colors.text, fontSize: 17, fontWeight: '800' }} numberOfLines={1}>
            {name.trim() || info.label}
          </Text>
          <Text style={{ color: colors.textDim, fontSize: 12.5 }}>{info.blurb}</Text>
        </View>

        <Text style={[st.h, { color: colors.text }]}>Type</Text>
        <View style={st.grid}>
          {GROUP_TYPES.map((g) => {
            const on = g.type === type;
            return (
              <TouchableOpacity
                key={g.type}
                onPress={() => { setType(g.type); setIcon(null); setColor(null); }}
                style={[st.typeCell, { borderColor: on ? g.color : colors.border, backgroundColor: on ? g.color + '1a' : colors.card }]}
              >
                <Ionicons name={g.icon} size={19} color={on ? g.color : colors.textDim} />
                <Text style={{ color: on ? colors.text : colors.textDim, fontSize: 11.5, fontWeight: on ? '700' : '500' }} numberOfLines={1}>
                  {g.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={[st.h, { color: colors.text }]}>Name</Text>
        <View style={[st.field, { borderColor: colors.glassStroke, backgroundColor: colors.glassSoft }]}>
          <Ionicons name={shownIcon} size={17} color={colors.textDim} />
          <TextInput
            value={name} onChangeText={setName} placeholder={`e.g. ${info.label}`}
            placeholderTextColor={colors.textFaint} style={[st.input, { color: colors.text }]}
            maxLength={100} returnKeyType="next"
          />
        </View>

        <View style={[st.field, { borderColor: colors.glassStroke, backgroundColor: colors.glassSoft, marginTop: 10 }]}>
          <Ionicons name="text" size={17} color={colors.textDim} />
          <TextInput
            value={description} onChangeText={setDescription} placeholder="Description (optional)"
            placeholderTextColor={colors.textFaint} style={[st.input, { color: colors.text }]}
            maxLength={300}
          />
        </View>

        <Text style={[st.h, { color: colors.text }]}>Colour</Text>
        <View style={st.swatches}>
          {PALETTE.map((c) => (
            <TouchableOpacity key={c} onPress={() => setColor(c)}
              style={[st.swatch, { backgroundColor: c, borderColor: shownColor === c ? colors.text : 'transparent' }]}>
              {shownColor === c && <Ionicons name="checkmark" size={15} color="#fff" />}
            </TouchableOpacity>
          ))}
        </View>

        <Text style={[st.h, { color: colors.text }]}>Icon</Text>
        <View style={st.swatches}>
          {ICONS.map((ic) => (
            <TouchableOpacity key={ic} onPress={() => setIcon(ic)}
              style={[st.iconCell, { borderColor: shownIcon === ic ? shownColor : colors.border, backgroundColor: shownIcon === ic ? shownColor + '1a' : colors.card }]}>
              <Ionicons name={ic} size={18} color={shownIcon === ic ? shownColor : colors.textDim} />
            </TouchableOpacity>
          ))}
        </View>

        <Text style={[st.h, { color: colors.text }]}>Who can join</Text>
        {([
          ['private', 'lock-closed', 'Private', 'Anyone with an invite can join straight away'],
          ['invite_only', 'shield-checkmark', 'Approval needed', 'An admin approves each person before they join'],
        ] as const).map(([key, ic, label, blurb]) => {
          const on = privacy === key;
          return (
            <TouchableOpacity key={key} onPress={() => setPrivacy(key)}
              style={[st.privacyRow, { borderColor: on ? colors.primary : colors.border, backgroundColor: on ? brandAlpha(0.08) : colors.card }]}>
              <Ionicons name={ic} size={19} color={on ? colors.primary : colors.textDim} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontWeight: '700', fontSize: 14 }}>{label}</Text>
                <Text style={{ color: colors.textDim, fontSize: 11.5 }}>{blurb}</Text>
              </View>
              <Ionicons name={on ? 'radio-button-on' : 'radio-button-off'} size={19} color={on ? colors.primary : colors.textFaint} />
            </TouchableOpacity>
          );
        })}

        <TouchableOpacity onPress={create} disabled={busy || !name.trim()}
          style={[st.btn, { backgroundColor: name.trim() && !busy ? colors.primary : colors.border }]}>
          {busy ? <ActivityIndicator color="#fff" />
            : <><Ionicons name="add-circle" size={18} color="#fff" /><Text style={st.btnTxt}>Create group</Text></>}
        </TouchableOpacity>
        <Text style={{ color: colors.textFaint, fontSize: 11.5, textAlign: 'center', marginTop: 10 }}>
          You can invite people on the next screen.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const st = StyleSheet.create({
  preview: { alignItems: 'center', gap: 5, padding: 20, borderWidth: 1, borderRadius: 18 },
  previewIcon: { width: 58, height: 58, borderRadius: 29, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  h: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3, marginTop: 24, marginBottom: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  typeCell: { flexBasis: '30%', flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 5, height: 62, borderWidth: 1, borderRadius: 14 },
  field: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, minHeight: 50 },
  input: { flex: 1, fontSize: 15 },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: 9 },
  swatch: { width: 38, height: 38, borderRadius: 19, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  iconCell: { width: 44, height: 44, borderRadius: 13, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  privacyRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 13, borderWidth: 1, borderRadius: 14, marginBottom: 9 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 52, borderRadius: 14, marginTop: 26 },
  btnTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },
});
