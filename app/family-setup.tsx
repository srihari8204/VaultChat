// app/family-setup.tsx — create a new Family Circle or join one with a code.
// A Circle is a private group; invite links are the existing group-invite system.

import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { createCircle, joinCircle } from '../lib/family/circle';

export default function FamilySetupScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  // Pushed from an existing space ("create or join another") vs. reached by the
  // zero-circle redirect. Returning is right in the first case; replacing is
  // right in the second, where /family is no longer on the stack.
  const { from } = useLocalSearchParams<{ from?: string }>();
  const done = () => { if (from === 'family') router.back(); else router.replace('/family' as any); };
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy('create');
    try { await createCircle(name); done(); }
    catch (e: any) { Alert.alert('Create failed', e?.message ?? 'Could not create the circle.'); }
    finally { setBusy(null); }
  };
  const join = async () => {
    if (!code.trim() || busy) return;
    setBusy('join');
    try { await joinCircle(code); done(); }
    catch (e: any) { Alert.alert('Join failed', e?.message ?? 'Check the code and try again.'); }
    finally { setBusy(null); }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{
        headerShown: true, title: 'Family Circle', headerTitleAlign: 'center',
        headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text, headerShadowVisible: false,
      }} />
      <ScrollView contentContainerStyle={st.wrap} keyboardShouldPersistTaps="handled">
        <View style={[st.hero, { backgroundColor: colors.primary + '14' }]}>
          <Ionicons name="people-circle" size={44} color={colors.primary} />
          <Text style={[st.heroTitle, { color: colors.text }]}>Your family, privately</Text>
          <Text style={[st.heroSub, { color: colors.textDim }]}>See each other on a live map, get arrive/leave alerts, and send SOS — all end-to-end encrypted. The server never sees a location.</Text>
        </View>

        <Text style={[st.h, { color: colors.text }]}>Create a circle</Text>
        <View style={[st.field, { borderColor: colors.border, backgroundColor: colors.surface }]}>
          <Ionicons name="home" size={18} color={colors.textDim} />
          <TextInput value={name} onChangeText={setName} placeholder="Circle name (e.g. Family)" placeholderTextColor={colors.textFaint}
            style={[st.input, { color: colors.text }]} returnKeyType="done" onSubmitEditing={create} />
        </View>
        <TouchableOpacity onPress={create} disabled={!name.trim() || !!busy} style={[st.btn, { backgroundColor: name.trim() ? colors.primary : colors.border }]}>
          {busy === 'create' ? <ActivityIndicator color="#fff" /> : <><Ionicons name="add" size={18} color="#fff" /><Text style={st.btnTxt}>Create circle</Text></>}
        </TouchableOpacity>

        {/* Groups & Circles: the same flow, but typed — friends, office, riders,
            travel and the rest, each with its own icon, colour and permissions. */}
        <TouchableOpacity
          onPress={() => router.push('/group-create' as any)}
          style={[st.btn, { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border }]}
        >
          <Ionicons name="grid-outline" size={18} color={colors.primary} />
          <Text style={[st.btnTxt, { color: colors.primary }]}>Create another kind of group</Text>
        </TouchableOpacity>

        <View style={st.orRow}><View style={[st.line, { backgroundColor: colors.border }]} /><Text style={{ color: colors.textFaint, fontSize: 12 }}>OR</Text><View style={[st.line, { backgroundColor: colors.border }]} /></View>

        <Text style={[st.h, { color: colors.text }]}>Join with a code</Text>
        <View style={[st.field, { borderColor: colors.border, backgroundColor: colors.surface }]}>
          <Ionicons name="key" size={18} color={colors.textDim} />
          <TextInput value={code} onChangeText={setCode} placeholder="Invite code" placeholderTextColor={colors.textFaint}
            autoCapitalize="none" autoCorrect={false} style={[st.input, { color: colors.text }]} returnKeyType="go" onSubmitEditing={join} />
        </View>
        <TouchableOpacity onPress={join} disabled={!code.trim() || !!busy} style={[st.btn, { backgroundColor: code.trim() ? colors.primary : colors.border }]}>
          {busy === 'join' ? <ActivityIndicator color="#fff" /> : <><Ionicons name="enter" size={18} color="#fff" /><Text style={st.btnTxt}>Join circle</Text></>}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const st = StyleSheet.create({
  wrap: { padding: 16, paddingBottom: 40 },
  hero: { alignItems: 'center', padding: 22, borderRadius: 18, marginBottom: 26, gap: 6 },
  heroTitle: { fontSize: 19, fontWeight: '800', marginTop: 6 },
  heroSub: { fontSize: 13.5, textAlign: 'center', lineHeight: 19 },
  h: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 10 },
  field: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, height: 50 },
  input: { flex: 1, fontSize: 15 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 50, borderRadius: 13, marginTop: 12 },
  btnTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },
  orRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 26 },
  line: { flex: 1, height: 1 },
});
