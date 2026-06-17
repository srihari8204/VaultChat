// app/new-chat.tsx — start a chat. Two ways: pick from your contacts, or type a
// mobile number directly. (Group creation lives on /create-group.)

import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
  ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { PhoneField, toE164 } from '../components/auth/PhoneField';
import { createDirectChat } from '../lib/chatService';

export default function NewChatScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const [dialCode, setDialCode] = useState('+91');
  const [national, setNational] = useState('');
  const [loading, setLoading] = useState(false);
  const [joinLink, setJoinLink] = useState('');

  const e164 = toE164(dialCode, national);

  // Pull the invite code out of a pasted link (https://vaultchat.app/join/CODE,
  // vaultchat://join/CODE) or a bare code.
  const extractCode = (raw: string): string => {
    let v = raw.trim().split('?')[0].split('#')[0];
    const m = v.match(/\/join\/([^/\s]+)\/?$/i);
    if (m) return m[1];
    if (v.includes('/')) { const parts = v.split('/').filter(Boolean); return parts[parts.length - 1] || ''; }
    return v;
  };

  const joinByLink = () => {
    const code = extractCode(joinLink);
    if (!code) { Alert.alert('Invalid link', 'Paste a valid VaultChat invite link or code.'); return; }
    router.push({ pathname: '/join/[code]', params: { code } } as any);
  };

  const startByPhone = async () => {
    if (!e164 || loading) return;
    setLoading(true);
    try {
      const res = await createDirectChat({ phone: e164 });
      router.replace({ pathname: '/chat', params: { id: res.id } } as any);
    } catch (e: any) {
      Alert.alert('Could not start chat', e?.message ?? 'The number may not be on VaultChat yet.');
    } finally { setLoading(false); }
  };

  return (
    <KeyboardAvoidingView style={S.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} style={S.backBtn} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.title}>New chat</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
        <TouchableOpacity style={S.action} onPress={() => router.push('/contacts' as any)} activeOpacity={0.7}>
          <View style={[S.actionIcon, { backgroundColor: colors.primary }]}><Ionicons name="people" size={22} color="#fff" /></View>
          <View style={{ flex: 1 }}>
            <Text style={S.actionTitle}>From contacts</Text>
            <Text style={S.actionSub}>Pick someone already on VaultChat</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.textDim} />
        </TouchableOpacity>

        <TouchableOpacity style={S.action} onPress={() => router.push('/create-group' as any)} activeOpacity={0.7}>
          <View style={[S.actionIcon, { backgroundColor: colors.accent }]}><Ionicons name="people-circle" size={22} color="#fff" /></View>
          <View style={{ flex: 1 }}>
            <Text style={S.actionTitle}>New group</Text>
            <Text style={S.actionSub}>Create a group chat</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.textDim} />
        </TouchableOpacity>

        <Text style={S.orLabel}>OR ADD BY MOBILE NUMBER</Text>
        <PhoneField dialCode={dialCode} national={national} onChange={(d, n) => { setDialCode(d); setNational(n); }} />
        <TouchableOpacity style={[S.cta, !e164 && S.ctaOff]} onPress={startByPhone} disabled={!e164 || loading} activeOpacity={0.85}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={S.ctaTxt}>Start chat</Text>}
        </TouchableOpacity>
        <Text style={S.hint}>The number must belong to someone who has set their phone on VaultChat.</Text>

        <Text style={S.orLabel}>OR JOIN A GROUP BY INVITE LINK</Text>
        <TextInput
          style={S.linkInput}
          value={joinLink}
          onChangeText={setJoinLink}
          placeholder="Paste invite link or code"
          placeholderTextColor={colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="go"
          onSubmitEditing={joinByLink}
        />
        <TouchableOpacity style={[S.cta, S.ctaAlt, !joinLink.trim() && S.ctaOff]} onPress={joinByLink} disabled={!joinLink.trim()} activeOpacity={0.85}>
          <Text style={S.ctaTxt}>Join group</Text>
        </TouchableOpacity>
        <Text style={S.hint}>Someone in the group can share an invite link with you.</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 56, paddingBottom: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { color: c.text, fontSize: 20, fontWeight: '800' },
  action: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, paddingHorizontal: 4 },
  actionIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  actionTitle: { color: c.text, fontSize: 16, fontWeight: '700' },
  actionSub: { color: c.textDim, fontSize: 13, marginTop: 2 },
  orLabel: { color: c.textDim, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginTop: 24, marginBottom: 12 },
  cta: { marginTop: 16, height: 54, borderRadius: 14, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  ctaAlt: { backgroundColor: c.accent },
  ctaOff: { opacity: 0.4 },
  ctaTxt: { color: '#fff', fontSize: 16, fontWeight: '800' },
  linkInput: { height: 50, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.card, color: c.text, paddingHorizontal: 14, fontSize: 15 },
  hint: { color: c.textFaint, fontSize: 12, marginTop: 12, lineHeight: 17 },
});
