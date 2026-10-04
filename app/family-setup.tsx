// app/family-setup.tsx — create a new Family Circle or join one with a code.
// A Circle is a private group; invite links are the existing group-invite system.
//
// Opened from a non-family space (the hub's "Create or join another space"
// passes ?groupType=), the copy names THAT space's type instead of calling
// everything a family: a school-transport parent is offered "another School
// Transport space", and the family-circle button says plainly that it makes a
// family circle. The actions themselves are the same in every case.

import { AppText as Text } from '../components/ui/Text';
import React, { useState } from 'react';
import { KeyboardSafe } from '../components/ui';
import { View, TextInput, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, ScrollView } from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import SpaceGround, { useSpaceGlass } from '../components/spaces/SpaceGround';
import { SPACE_SHADOW } from '../constants/spaceTheme';
import { createCircle, joinCircle } from '../lib/family/circle';
import { groupTypeInfo } from '../lib/groups/catalog';
import { familyOf } from '../lib/spaces/layout';

export default function FamilySetupScreen() {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  const router = useRouter();
  // Pushed from an existing space ("create or join another", which passes
  // from=family) vs. opened with nothing behind it (deep link). Returning is
  // right in the first case — the hub reloads on focus and opens the new
  // active group; replacing is right in the second.
  const { from, groupType } = useLocalSearchParams<{ from?: string; groupType?: string }>();
  // The space type this was opened from, when it is not a family one.
  const other = groupType && familyOf(groupType) !== 'family' ? groupTypeInfo(groupType) : null;
  const unit = other ? 'space' : 'circle';
  // Both carry ?groupId= so the hub opens on the circle just created/joined.
  const done = (groupId: string) => {
    const href = { pathname: '/family' as const, params: { groupId } };
    if (from === 'family' && router.canGoBack()) router.dismissTo(href);
    else router.replace(href);
  };
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy('create');
    try { const c = await createCircle(name); done(c.id); }
    catch (e: any) { Alert.alert('Create failed', e?.message ?? 'Could not create the circle.'); }
    finally { setBusy(null); }
  };
  const join = async () => {
    if (!code.trim() || busy) return;
    setBusy('join');
    try {
      const r = await joinCircle(code);
      if (r.pending) {
        Alert.alert('Request sent', `An admin of this ${unit} has to approve you. You will be notified when you are in.`);
        if (router.canGoBack()) router.back(); else router.replace('/(tabs)/chats');
        return;
      }
      if (r.alreadyMember) Alert.alert('Already a member', `You are already in "${r.name}".`);
      done(r.id);
    }
    catch (e: any) { Alert.alert('Join failed', e?.message ?? 'Check the code and try again.'); }
    finally { setBusy(null); }
  };

  return (
    <KeyboardSafe style={{ flex: 1, backgroundColor: G.bgMid }}>
      <Stack.Screen options={{
        headerShown: true, title: other ? 'Create or join a space' : 'Family Circle', headerTitleAlign: 'center',
        headerStyle: { backgroundColor: G.bgTop }, headerTintColor: colors.text, headerShadowVisible: false,
      }} />
      <SpaceGround />
      <ScrollView contentContainerStyle={st.wrap} keyboardShouldPersistTaps="handled">
        <View style={[st.hero, { backgroundColor: G.pane, borderColor: G.edge }]}>
          <Ionicons name={other ? other.icon : 'people-circle'} size={44} color={colors.primary} />
          <Text accessibilityRole="header" style={[st.heroTitle, { color: colors.text }]}>
            {other ? `Another ${other.label} space, or something new` : 'Your family, privately'}
          </Text>
          <Text style={[st.heroSub, { color: colors.textDim }]}>
            {other
              ? `Join a ${other.label} space with the code its admin shared, create a family circle, or set up a new ${other.label} or any other kind of space. `
              : 'See each other on a live map, get arrive/leave alerts, and send SOS. '}
            Live updates between your phones are end-to-end encrypted, but each position you share (after your privacy setting) is also stored on crazzychat&apos;s server so the {unit} can see last-known spots and history. The server only shows it to {unit} members. Road distances, routes and history distances send points to crazzychat&apos;s routing server, which does not store them.
          </Text>
        </View>

        <Text accessibilityRole="header" style={[st.h, { color: colors.textDim }]}>{other ? 'Create a family circle' : 'Create a circle'}</Text>
        <View style={[st.field, { borderColor: G.edge, backgroundColor: G.pane }]}>
          <Ionicons name="home" size={18} color={colors.textDim} />
          <TextInput value={name} onChangeText={setName} placeholder="Circle name (e.g. Family)" placeholderTextColor={colors.textFaint}
            accessibilityLabel="Circle name" maxLength={100}
            style={[st.input, { color: colors.text }]} returnKeyType="done" onSubmitEditing={create} />
        </View>
        <TouchableOpacity onPress={create} disabled={!name.trim() || !!busy} accessibilityRole="button" accessibilityLabel={other ? 'Create family circle' : 'Create circle'} accessibilityState={{ disabled: !name.trim() || !!busy, busy: busy === 'create' }} style={[st.btn, { backgroundColor: name.trim() ? colors.primary : colors.border }]}>
          {busy === 'create' ? <ActivityIndicator color={colors.onPrimary} /> : <><Ionicons name="add" size={18} color={colors.onPrimary} /><Text style={[st.btnTxt, { color: colors.onPrimary }]}>{other ? 'Create family circle' : 'Create circle'}</Text></>}
        </TouchableOpacity>

        {/* Groups & Circles: the same flow, but typed — friends, office, riders,
            travel and the rest, each with its own icon, colour and permissions. */}
        <TouchableOpacity
          onPress={() => router.push('/group-create')}
          accessibilityRole="button"
          style={[st.btn, { backgroundColor: G.paneFaint, borderWidth: 1, borderColor: G.chipEdge }]}
        >
          <Ionicons name="grid-outline" size={18} color={colors.primary} />
          <Text style={[st.btnTxt, { color: G.accentText }]}>{other ? `Create a ${other.label} or other space` : 'Create another kind of group'}</Text>
        </TouchableOpacity>

        <View style={st.orRow}><View style={[st.line, { backgroundColor: G.line }]} /><Text style={{ color: colors.textDim, fontSize: 12 }}>OR</Text><View style={[st.line, { backgroundColor: G.line }]} /></View>

        <Text accessibilityRole="header" style={[st.h, { color: colors.textDim }]}>Join with a code</Text>
        <View style={[st.field, { borderColor: G.edge, backgroundColor: G.pane }]}>
          <Ionicons name="key" size={18} color={colors.textDim} />
          <TextInput value={code} onChangeText={setCode} placeholder="Invite code" placeholderTextColor={colors.textFaint}
            accessibilityLabel="Invite code" maxLength={64}
            autoCapitalize="none" autoCorrect={false} style={[st.input, { color: colors.text }]} returnKeyType="go" onSubmitEditing={join} />
        </View>
        <TouchableOpacity onPress={join} disabled={!code.trim() || !!busy} accessibilityRole="button" accessibilityLabel={`Join ${unit}`} accessibilityState={{ disabled: !code.trim() || !!busy, busy: busy === 'join' }} style={[st.btn, { backgroundColor: code.trim() ? colors.primary : colors.border }]}>
          {busy === 'join' ? <ActivityIndicator color={colors.onPrimary} /> : <><Ionicons name="enter" size={18} color={colors.onPrimary} /><Text style={[st.btnTxt, { color: colors.onPrimary }]}>Join {unit}</Text></>}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardSafe>
  );
}

const st = StyleSheet.create({
  wrap: { padding: 16, paddingBottom: 40 },
  hero: { alignItems: 'center', padding: 22, borderWidth: 1, borderRadius: 22, marginBottom: 24, gap: 6, ...SPACE_SHADOW.raised },
  heroTitle: { fontSize: 19, fontWeight: '800', marginTop: 6 },
  heroSub: { fontSize: 13.5, textAlign: 'center', lineHeight: 19 },
  h: { fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.7, marginBottom: 10 },
  field: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, minHeight: 50, ...SPACE_SHADOW.rest },
  input: { flex: 1, fontSize: 15 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 50, borderRadius: 16, marginTop: 12 },
  btnTxt: { fontSize: 15, fontWeight: '800' },
  orRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 26 },
  line: { flex: 1, height: 1 },
});
