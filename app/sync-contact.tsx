// app/sync-contact.tsx — Mutual-consent contact sync (Postgres-backed).
//
// One person generates a 6-digit code (5-min, single-use); the other enters
// it. On consent both learn each other's stub and can open a direct chat.
// Backed by /contacts/sync/{create,:code,verify}. No Firebase.

import React, { useState, useEffect, useRef , useMemo} from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, Alert, SafeAreaView,
  ScrollView, Share, Platform, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { copyAndAutoClear } from '../lib/clipboardSafe';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import {
  createSyncCode, getSyncStatus, verifySyncCode, createDirectChat,
  type SyncInitiator,
} from '../lib/chatService';

type Tab = 'my-code' | 'enter-code';
type Phase = 'idle' | 'generating' | 'waiting' | 'verifying' | 'done' | 'error';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function SyncContactScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('my-code');
  const [phase, setPhase] = useState<Phase>('idle');
  const [myCode, setMyCode] = useState('');
  const [enterCode, setEnterCode] = useState('');
  const [timeLeft, setTimeLeft] = useState(0);
  const [synced, setSynced] = useState<SyncInitiator | null>(null);
  const [errMsg, setErrMsg] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Countdown
  useEffect(() => {
    if (phase !== 'waiting' || timeLeft <= 0) return;
    const t = setInterval(() => {
      setTimeLeft(v => {
        if (v <= 1) { clearInterval(t); setPhase('idle'); setMyCode(''); return 0; }
        return v - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [phase, timeLeft]);

  // Poll for the other party's consent
  useEffect(() => {
    if (phase !== 'waiting' || !myCode) return;
    pollRef.current = setInterval(async () => {
      try {
        const { verified } = await getSyncStatus(myCode);
        if (verified) {
          if (pollRef.current) clearInterval(pollRef.current);
          setPhase('done');
          setSynced({ userId: '', displayName: 'Contact synced!', email: null, phoneNumber: null });
        }
      } catch {
        // 404/410 → code gone/expired
        if (pollRef.current) clearInterval(pollRef.current);
        setPhase('idle'); setMyCode('');
      }
    }, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [phase, myCode]);

  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  const generateCode = async () => {
    setPhase('generating');
    try {
      const { code } = await createSyncCode();
      setMyCode(code); setTimeLeft(300); setPhase('waiting');
    } catch (e: any) { setErrMsg(e?.message || 'Failed to generate code'); setPhase('error'); }
  };

  const verify = async () => {
    if (enterCode.length !== 6) { Alert.alert('Invalid', 'Enter a 6-digit code'); return; }
    setPhase('verifying');
    try {
      const { initiator } = await verifySyncCode(enterCode);
      setSynced(initiator); setPhase('done');
    } catch (e: any) { setErrMsg(e?.message || 'Verification failed'); setPhase('error'); }
  };

  const copyCode = async () => { await copyAndAutoClear(myCode); Alert.alert('Copied', 'Code copied to clipboard'); };
  const shareCode = () => Share.share({ message: `My VaultChat Sync Code: ${myCode} (valid 5 min)` });

  const reset = () => {
    setPhase('idle'); setMyCode(''); setEnterCode(''); setSynced(null); setErrMsg('');
    if (pollRef.current) clearInterval(pollRef.current);
  };

  const messageContact = async () => {
    if (!synced?.userId) { router.back(); return; }
    try {
      const { id } = await createDirectChat({ userId: synced.userId });
      router.replace({ pathname: '/chat', params: { id, peerName: synced.displayName ?? '' } } as any);
    } catch (e: any) { Alert.alert('Error', e?.message ?? 'Could not start chat'); }
  };

  // Done screen
  if (phase === 'done' && synced) {
    return (
      <SafeAreaView style={s.root}>
        <View style={{ flex: 1, padding: 24, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 56, marginBottom: 16 }}>✅</Text>
          <Text style={[s.heading, { color: colors.purple, textAlign: 'center', marginBottom: 8 }]}>Contact Synced!</Text>
          <Text style={[s.sub, { textAlign: 'center', marginBottom: 24 }]}>Both users consented. Contact saved securely.</Text>

          <View style={[s.card, { width: '100%', marginBottom: 20 }]}>
            <Text style={[s.label, { marginBottom: 10 }]}>SYNCED CONTACT</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={s.avatar}><Text style={{ fontSize: 22 }}>👤</Text></View>
              <View style={{ flex: 1 }}>
                <Text style={s.heading}>{synced.displayName || 'Contact'}</Text>
                {!!synced.email && <Text style={s.sub}>{synced.email}</Text>}
                {!!synced.phoneNumber && <Text style={s.sub}>{synced.phoneNumber}</Text>}
              </View>
            </View>
          </View>

          {!!synced.userId && (
            <TouchableOpacity style={[s.btn, { backgroundColor: colors.primary, width: '100%', marginBottom: 10 }]} onPress={messageContact}>
              <Text style={[s.btnTxt, { color: '#04130D' }]}>Message</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={[s.btn, { backgroundColor: colors.purple, width: '100%', marginBottom: 10 }]} onPress={() => router.back()}>
            <Text style={s.btnTxt}>Done</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.btn, { backgroundColor: colors.surface, width: '100%' }]} onPress={reset}>
            <Text style={[s.btnTxt, { color: colors.textDim }]}>Sync Another</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.root}>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <TouchableOpacity onPress={() => router.back()} style={{ marginBottom: 16 }}>
          <Text style={{ color: colors.purple, fontSize: 15 }}>← Back</Text>
        </TouchableOpacity>

        <Text style={s.label}>SYNC CONTACT</Text>
        <Text style={s.heading}>Add Contact Securely</Text>
        <Text style={[s.sub, { marginBottom: 24 }]}>Both people must agree. One generates a code, the other enters it.</Text>

        <View style={[s.card, { marginBottom: 20, borderColor: 'rgba(139,92,246,0.2)' }]}>
          {[
            ['1', 'Person A taps "Show My Code" and shares the 6-digit code'],
            ['2', 'Person B taps "Enter Their Code" and types it in'],
            ['3', 'Both contacts are saved — mutual consent confirmed'],
          ].map(([n, text]) => (
            <View key={n} style={{ flexDirection: 'row', gap: 10, marginBottom: 8 }}>
              <Text style={s.stepNum}>{n}</Text>
              <Text style={[s.sub, { flex: 1 }]}>{text}</Text>
            </View>
          ))}
        </View>

        <View style={s.tabRow}>
          <TouchableOpacity style={[s.tabBtn, tab === 'my-code' && s.tabActive]} onPress={() => { setTab('my-code'); reset(); }}>
            <Text style={[s.tabTxt, { color: tab === 'my-code' ? colors.purple : colors.textDim }]}>Show My Code</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.tabBtn, tab === 'enter-code' && s.tabActive]} onPress={() => { setTab('enter-code'); reset(); }}>
            <Text style={[s.tabTxt, { color: tab === 'enter-code' ? colors.purple : colors.textDim }]}>Enter Their Code</Text>
          </TouchableOpacity>
        </View>

        {tab === 'my-code' && (
          <View style={s.card}>
            {phase === 'idle' && (
              <>
                <Text style={[s.sub, { marginBottom: 16, textAlign: 'center' }]}>Generate a 6-digit code valid for <Text style={{ color: colors.purple }}>5 minutes</Text>.</Text>
                <TouchableOpacity style={[s.btn, { backgroundColor: colors.purple }]} onPress={generateCode}><Text style={s.btnTxt}>Generate My Code</Text></TouchableOpacity>
              </>
            )}
            {phase === 'generating' && <View style={{ alignItems: 'center', padding: 20 }}><ActivityIndicator color={colors.purple} size="large" /><Text style={[s.sub, { marginTop: 12 }]}>Generating secure code…</Text></View>}
            {phase === 'error' && tab === 'my-code' && (
              <>
                <Text style={[s.sub, { color: colors.danger, textAlign: 'center', marginBottom: 12 }]}>{errMsg}</Text>
                <TouchableOpacity style={[s.btn, { backgroundColor: colors.purple }]} onPress={generateCode}><Text style={s.btnTxt}>Try Again</Text></TouchableOpacity>
              </>
            )}
            {phase === 'waiting' && myCode.length > 0 && (
              <>
                <Text style={[s.label, { textAlign: 'center', marginBottom: 12 }]}>YOUR CODE — SHARE IT</Text>
                <View style={s.codeBox}><Text style={s.codeText}>{myCode.slice(0, 3)}  {myCode.slice(3)}</Text></View>
                <Text style={[s.sub, { textAlign: 'center', marginBottom: 16 }]}>Expires in <Text style={{ color: colors.purple, fontWeight: '700' }}>{fmt(timeLeft)}</Text></Text>
                <View style={{ flexDirection: 'row', gap: 10, marginBottom: 14 }}>
                  <TouchableOpacity style={s.smallBtn} onPress={copyCode}><Text style={s.smallBtnTxt}>Copy</Text></TouchableOpacity>
                  <TouchableOpacity style={s.smallBtn} onPress={shareCode}><Text style={s.smallBtnTxt}>Share</Text></TouchableOpacity>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <ActivityIndicator color={colors.purple} size="small" />
                  <Text style={[s.sub, { flex: 1 }]}>Waiting for the other person to enter this code…</Text>
                </View>
              </>
            )}
          </View>
        )}

        {tab === 'enter-code' && (
          <View style={s.card}>
            {(phase === 'idle' || phase === 'error') && (
              <>
                <Text style={[s.sub, { marginBottom: 16 }]}>Ask the other person to generate their code, then type it here.</Text>
                <TextInput
                  style={[s.codeInput, { borderColor: enterCode.length === 6 ? colors.purple : colors.border }]}
                  value={enterCode}
                  onChangeText={t => setEnterCode(t.replace(/\D/g, '').slice(0, 6))}
                  placeholder="------"
                  placeholderTextColor={colors.textFaint}
                  keyboardType="number-pad"
                  maxLength={6}
                  textAlign="center"
                />
                <View style={s.dotRow}>
                  {Array.from({ length: 6 }).map((_, i) => (
                    <View key={i} style={[s.dotIndicator, { backgroundColor: i < enterCode.length ? colors.purple : 'rgba(255,255,255,0.15)' }]} />
                  ))}
                </View>
                {phase === 'error' && <Text style={[s.sub, { color: colors.danger, textAlign: 'center', marginBottom: 12 }]}>{errMsg}</Text>}
                <TouchableOpacity
                  style={[s.btn, { backgroundColor: enterCode.length === 6 ? colors.purple : colors.surface }]}
                  onPress={verify}
                  disabled={enterCode.length !== 6}
                >
                  <Text style={[s.btnTxt, { color: enterCode.length === 6 ? '#fff' : colors.textDim }]}>Verify & Sync Contact</Text>
                </TouchableOpacity>
              </>
            )}
            {phase === 'verifying' && <View style={{ alignItems: 'center', padding: 20 }}><ActivityIndicator color={colors.purple} size="large" /><Text style={[s.sub, { marginTop: 12 }]}>Verifying code…</Text></View>}
          </View>
        )}

        <View style={[s.card, { marginTop: 8, borderColor: colors.separator }]}>
          <Text style={[s.sub, { lineHeight: 20 }]}>
            <Text style={{ color: colors.textDim, fontWeight: '700' }}>Privacy-first:</Text> No contact is saved unless both users consent. Code expires in 5 min and is single-use.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg },
  heading: { fontSize: 20, fontWeight: '900', color: c.text, marginBottom: 4 },
  sub: { fontSize: 12, color: c.textDim, lineHeight: 18 },
  label: { fontSize: 9, fontWeight: '700', color: c.textFaint, letterSpacing: 2, marginBottom: 4 },
  card: { backgroundColor: c.card, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: c.border, marginBottom: 12 },
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(139,92,246,0.13)', alignItems: 'center', justifyContent: 'center' },
  stepNum: { width: 20, height: 20, borderRadius: 10, backgroundColor: 'rgba(139,92,246,0.2)', color: c.purple, textAlign: 'center', fontSize: 12, fontWeight: '800', overflow: 'hidden' },
  tabRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  tabBtn: { flex: 1, padding: 11, borderRadius: 12, alignItems: 'center', backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  tabActive: { backgroundColor: 'rgba(139,92,246,0.13)', borderColor: 'rgba(139,92,246,0.4)' },
  tabTxt: { fontSize: 12, fontWeight: '700' },
  btn: { borderRadius: 14, padding: 14, alignItems: 'center', marginBottom: 8 },
  btnTxt: { fontSize: 14, fontWeight: '800', color: '#fff' },
  smallBtn: { flex: 1, padding: 10, borderRadius: 10, alignItems: 'center', backgroundColor: c.surface, borderWidth: 1, borderColor: 'rgba(139,92,246,0.3)' },
  smallBtnTxt: { fontSize: 12, fontWeight: '700', color: c.purple },
  codeBox: { backgroundColor: 'rgba(139,92,246,0.08)', borderRadius: 16, borderWidth: 1.5, borderColor: 'rgba(139,92,246,0.35)', padding: 20, alignItems: 'center', marginBottom: 12 },
  codeText: { fontSize: 38, fontWeight: '900', letterSpacing: 14, color: c.purple, fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace' },
  codeInput: { backgroundColor: c.surface, borderRadius: 14, borderWidth: 1.5, color: c.text, fontSize: 32, fontWeight: '900', padding: 16, letterSpacing: 12, fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace', marginBottom: 12 },
  dotRow: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 16 },
  dotIndicator: { width: 10, height: 10, borderRadius: 5 },
});
