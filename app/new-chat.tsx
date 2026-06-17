// app/new-chat.tsx — start a chat. Two ways: pick from your contacts, or type a
// mobile number directly. (Group creation lives on /create-group.)

import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
  ScrollView, StyleSheet, Text, TouchableOpacity, View,
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

  const e164 = toE164(dialCode, national);

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
  ctaOff: { opacity: 0.4 },
  ctaTxt: { color: '#fff', fontSize: 16, fontWeight: '800' },
  hint: { color: c.textFaint, fontSize: 12, marginTop: 12, lineHeight: 17 },
});
