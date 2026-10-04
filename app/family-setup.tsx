// app/family-setup.tsx — create a new Family Circle or join one with a code.
// A Circle is a private group; invite links are the existing group-invite system.

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

export default function FamilySetupScreen() {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  const router = useRouter();
  // Pushed from an existing space ("create or join another", which passes
  // from=family) vs. opened with nothing behind it (deep link). Returning is
  // right in the first case — the hub reloads on focus and opens the new
  // active group; replacing is right in the second.
  const { from } = useLocalSearchParams<{ from?: string }>();
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
        Alert.alert('Request sent', 'An admin of this circle has to approve you. You will be notified when you are in.');
        router.back();
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
        headerShown: true, title: 'Family Circle', headerTitleAlign: 'center',
        headerStyle: { backgroundColor: G.bgTop }, headerTintColor: colors.text, headerShadowVisible: false,
      }} />
      <SpaceGround />
      <ScrollView contentContainerStyle={st.wrap} keyboardShouldPersistTaps="handled">
        <View style={[st.hero, { backgroundColor: G.pane, borderColor: G.edge }]}>
          <Ionicons name="people-circle" size={44} color={colors.primary} />
          <Text style={[st.heroTitle, { color: colors.text }]}>Your family, privately</Text>
          <Text style={[st.heroSub, { color: colors.textDim }]}>See each other on a live map, get arrive/leave alerts, and send SOS. Live updates between your phones are end-to-end encrypted, but each position you share (after your privacy setting) is also stored on crazzychat&apos;s server so the circle can see last-known spots and history. The server only shows it to circle members. Road distances, routes and history distances send points to crazzychat&apos;s routing server, which does not store them.</Text>
        </View>

        <Text style={[st.h, { color: colors.textDim }]}>Create a circle</Text>
        <View style={[st.field, { borderColor: G.edge, backgroundColor: G.pane }]}>
          <Ionicons name="home" size={18} color={colors.textDim} />
          <TextInput value={name} onChangeText={setName} placeholder="Circle name (e.g. Family)" placeholderTextColor={colors.textFaint}
            accessibilityLabel="Circle name" maxLength={100}
            style={[st.input, { color: colors.text }]} returnKeyType="done" onSubmitEditing={create} />
        </View>
        <TouchableOpacity onPress={create} disabled={!name.trim() || !!busy} accessibilityRole="button" accessibilityLabel="Create circle" accessibilityState={{ disabled: !name.trim() || !!busy, busy: busy === 'create' }} style={[st.btn, { backgroundColor: name.trim() ? colors.primary : colors.border }]}>
          {busy === 'create' ? <ActivityIndicator color="#fff" /> : <><Ionicons name="add" size={18} color="#fff" /><Text style={st.btnTxt}>Create circle</Text></>}
        </TouchableOpacity>

        {/* Groups & Circles: the same flow, but typed — friends, office, riders,
            travel and the rest, each with its own icon, colour and permissions. */}
        <TouchableOpacity
          onPress={() => router.push('/group-create')}
          accessibilityRole="button"
          style={[st.btn, { backgroundColor: G.paneFaint, borderWidth: 1, borderColor: G.chipEdge }]}
        >
          <Ionicons name="grid-outline" size={18} color={colors.primary} />
          <Text style={[st.btnTxt, { color: G.accentText }]}>Create another kind of group</Text>
        </TouchableOpacity>

        <View style={st.orRow}><View style={[st.line, { backgroundColor: G.line }]} /><Text style={{ color: colors.textDim, fontSize: 12 }}>OR</Text><View style={[st.line, { backgroundColor: G.line }]} /></View>

        <Text style={[st.h, { color: colors.textDim }]}>Join with a code</Text>
        <View style={[st.field, { borderColor: G.edge, backgroundColor: G.pane }]}>
          <Ionicons name="key" size={18} color={colors.textDim} />
          <TextInput value={code} onChangeText={setCode} placeholder="Invite code" placeholderTextColor={colors.textFaint}
            accessibilityLabel="Invite code" maxLength={64}
            autoCapitalize="none" autoCorrect={false} style={[st.input, { color: colors.text }]} returnKeyType="go" onSubmitEditing={join} />
        </View>
        <TouchableOpacity onPress={join} disabled={!code.trim() || !!busy} accessibilityRole="button" accessibilityLabel="Join circle" accessibilityState={{ disabled: !code.trim() || !!busy, busy: busy === 'join' }} style={[st.btn, { backgroundColor: code.trim() ? colors.primary : colors.border }]}>
          {busy === 'join' ? <ActivityIndicator color="#fff" /> : <><Ionicons name="enter" size={18} color="#fff" /><Text style={st.btnTxt}>Join circle</Text></>}
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
  btnTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },
  orRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 26 },
  line: { flex: 1, height: 1 },
});
