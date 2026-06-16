// app/new-chat.tsx — Phase 3a new chat picker.
//
// Two modes via a top toggle: Direct (one email) and Group (name + multiple
// emails as chips). No contact discovery yet — users have to type emails of
// people who are already signed up.

import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text, TextInput, TouchableOpacity,
  View,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { createDirectChat, createGroupChat } from '../lib/chatService';

type Mode = 'direct' | 'group';
type DirectBy = 'email' | 'phone';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Accept 8-15 digits in the entered phone (will be normalized server-side)
const PHONE_RE = /^[0-9+()\-\s]{8,20}$/;

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function NewChatScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const [mode,    setMode]    = useState<Mode>('direct');
  const [loading, setLoading] = useState(false);

  // direct mode
  const [directBy, setDirectBy] = useState<DirectBy>('email');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');

  // group mode
  const [groupName, setGroupName] = useState('');
  const [emailInput, setEmailInput] = useState('');
  const [emails, setEmails] = useState<string[]>([]);

  const directValid = directBy === 'email'
    ? EMAIL_RE.test(email.trim())
    : PHONE_RE.test(phone.trim()) && phone.replace(/\D/g, '').length >= 7;
  const groupValid  = useMemo(
    () => groupName.trim().length > 0 && emails.length > 0,
    [groupName, emails],
  );

  const addEmail = () => {
    const e = emailInput.trim().toLowerCase();
    if (!EMAIL_RE.test(e)) {
      Alert.alert('Invalid', 'Enter a valid email');
      return;
    }
    if (emails.includes(e)) {
      setEmailInput('');
      return;
    }
    setEmails(prev => [...prev, e]);
    setEmailInput('');
  };

  const removeEmail = (e: string) => setEmails(prev => prev.filter(x => x !== e));

  const onStart = async () => {
    if (loading) return;
    setLoading(true);
    try {
      if (mode === 'direct') {
        if (!directValid) return;
        const res = directBy === 'email'
          ? await createDirectChat({ email: email.trim().toLowerCase() })
          : await createDirectChat({ phone: phone.trim() });
        router.replace({ pathname: '/chat', params: { id: res.id } } as any);
      } else {
        if (!groupValid) return;
        const res = await createGroupChat(groupName.trim(), { emails });
        router.replace({ pathname: '/chat', params: { id: res.id } } as any);
      }
    } catch (e: any) {
      Alert.alert('Could not create chat', e?.message ?? 'Try again');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView style={S.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} style={S.backBtn} activeOpacity={0.7}>
          <Text style={S.backTxt}>←</Text>
        </TouchableOpacity>
        <Text style={S.title}>New chat</Text>
      </View>

      {/* Mode toggle */}
      <View style={S.toggle}>
        <Pressable
          style={[S.toggleBtn, mode === 'direct' && S.toggleBtnActive]}
          onPress={() => setMode('direct')}
        >
          <Text style={[S.toggleTxt, mode === 'direct' && S.toggleTxtActive]}>Direct</Text>
        </Pressable>
        <Pressable
          style={[S.toggleBtn, mode === 'group' && S.toggleBtnActive]}
          onPress={() => setMode('group')}
        >
          <Text style={[S.toggleTxt, mode === 'group' && S.toggleTxtActive]}>Group</Text>
        </Pressable>
      </View>

      {mode === 'direct' ? (
        <View style={S.body}>
          {/* Direct sub-toggle: Email / Phone */}
          <View style={S.subToggle}>
            <Pressable
              style={[S.subBtn, directBy === 'email' && S.subBtnActive]}
              onPress={() => setDirectBy('email')}
            >
              <Text style={[S.subTxt, directBy === 'email' && S.subTxtActive]}>Email</Text>
            </Pressable>
            <Pressable
              style={[S.subBtn, directBy === 'phone' && S.subBtnActive]}
              onPress={() => setDirectBy('phone')}
            >
              <Text style={[S.subTxt, directBy === 'phone' && S.subTxtActive]}>Phone</Text>
            </Pressable>
          </View>

          {directBy === 'email' ? (
            <>
              <Text style={S.label}>RECIPIENT EMAIL</Text>
              <TextInput
                style={S.input}
                value={email}
                onChangeText={setEmail}
                placeholder="them@example.com"
                placeholderTextColor="rgba(255,255,255,0.25)"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                autoFocus
                maxLength={120}
              />
              <Text style={S.hint}>The recipient needs to be signed up on VaultChat too.</Text>
            </>
          ) : (
            <>
              <Text style={S.label}>RECIPIENT PHONE</Text>
              <TextInput
                style={S.input}
                value={phone}
                onChangeText={setPhone}
                placeholder="+91 9876543210 or 9876543210"
                placeholderTextColor="rgba(255,255,255,0.25)"
                keyboardType="phone-pad"
                autoComplete="tel"
                autoFocus
                maxLength={20}
              />
              <Text style={S.hint}>
                Enter the phone number with country code (e.g. +1 555 1234) — or just 10 digits for India. The recipient must have set their phone in Profile.
              </Text>
            </>
          )}

          <TouchableOpacity
            style={[S.btn, (!directValid || loading) && S.btnOff]}
            disabled={!directValid || loading}
            onPress={onStart}
            activeOpacity={0.85}
          >
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={S.btnTxt}>Start chat</Text>}
          </TouchableOpacity>
        </View>
      ) : (
        <View style={S.body}>
          <Text style={S.label}>GROUP NAME</Text>
          <TextInput
            style={S.input}
            value={groupName}
            onChangeText={setGroupName}
            placeholder="e.g. Weekend Trip"
            placeholderTextColor="rgba(255,255,255,0.25)"
            maxLength={100}
          />

          <Text style={S.label}>ADD MEMBERS BY EMAIL</Text>
          <View style={S.row}>
            <TextInput
              style={[S.input, { flex: 1, marginBottom: 0 }]}
              value={emailInput}
              onChangeText={setEmailInput}
              placeholder="member@example.com"
              placeholderTextColor="rgba(255,255,255,0.25)"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={addEmail}
              maxLength={120}
            />
            <TouchableOpacity onPress={addEmail} style={S.addBtn} activeOpacity={0.7}>
              <Text style={S.addBtnTxt}>＋</Text>
            </TouchableOpacity>
          </View>

          {/* Chips */}
          {emails.length > 0 && (
            <View style={S.chips}>
              {emails.map(e => (
                <Pressable key={e} style={S.chip} onPress={() => removeEmail(e)}>
                  <Text style={S.chipTxt}>{e}</Text>
                  <Text style={S.chipX}>×</Text>
                </Pressable>
              ))}
            </View>
          )}

          <Text style={S.hint}>
            Each email must be a registered VaultChat user. The backend will reject the request if any aren't.
          </Text>

          <TouchableOpacity
            style={[S.btn, (!groupValid || loading) && S.btnOff]}
            disabled={!groupValid || loading}
            onPress={onStart}
            activeOpacity={0.85}
          >
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={S.btnTxt}>Create group</Text>}
          </TouchableOpacity>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}


const makeStyles = (c: Palette) => StyleSheet.create({
  screen:    { flex: 1, backgroundColor: c.bg },
  header:    { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 56, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border, gap: 8 },
  backBtn:   { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  backTxt:   { color: c.text, fontSize: 24 },
  title:     { color: c.text, fontSize: 18, fontWeight: '700' },

  toggle:    { flexDirection: 'row', margin: 20, backgroundColor: c.card, borderRadius: 12, padding: 4, gap: 4 },
  toggleBtn: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 8 },
  toggleBtnActive: { backgroundColor: c.primary },
  toggleTxt: { color: c.textDim, fontWeight: '600' },
  toggleTxtActive: { color: '#fff' },

  subToggle:    { flexDirection: 'row', backgroundColor: c.card, borderRadius: 10, padding: 3, gap: 3, marginBottom: 12 },
  subBtn:       { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 7 },
  subBtnActive: { backgroundColor: 'rgba(108,99,255,0.25)', borderWidth: 1, borderColor: c.primary },
  subTxt:       { color: c.textDim, fontSize: 13, fontWeight: '600' },
  subTxtActive: { color: c.text },

  body:      { paddingHorizontal: 20, gap: 8 },
  label:     { color: c.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, marginTop: 12 },
  input:     { color: c.text, backgroundColor: c.card, borderColor: c.border, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, marginBottom: 8 },
  hint:      { color: c.textDim, fontSize: 13, lineHeight: 18, marginTop: 6 },

  row:       { flexDirection: 'row', alignItems: 'center', gap: 8 },
  addBtn:    { width: 44, height: 44, borderRadius: 12, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  addBtnTxt: { color: '#fff', fontSize: 24, fontWeight: '600', marginTop: -2 },

  chips:     { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  chip:      { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(108,99,255,0.15)', borderColor: c.primary, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, gap: 6 },
  chipTxt:   { color: c.text, fontSize: 13 },
  chipX:     { color: c.textDim, fontSize: 16, marginTop: -2 },

  btn:       { backgroundColor: c.primary, paddingVertical: 14, borderRadius: 24, alignItems: 'center', marginTop: 20 },
  btnOff:    { backgroundColor: '#374151' },
  btnTxt:    { color: '#fff', fontWeight: '700', fontSize: 15 },
});
