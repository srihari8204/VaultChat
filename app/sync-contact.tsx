import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  Alert, SafeAreaView, ScrollView, Share, Platform,
  ActivityIndicator
} from 'react-native';
// FIX: replaced deprecated Clipboard from 'react-native' with expo-clipboard
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { getAuth } from 'firebase/auth';

// REPLACE with your actual backend IP
const API = 'http://YOUR_BACKEND_IP:3001/api/sync-contact';

const C = {
  purple: '#A78BFA',
  bg:     '#030912',
  card:   '#0D1B2E',
  border: 'rgba(255,255,255,0.09)',
  text:   '#fff',
  sub:    'rgba(255,255,255,0.4)',
};

type Tab   = 'my-code' | 'enter-code';
type Phase = 'idle' | 'generating' | 'waiting' | 'verifying' | 'done' | 'error';

export default function SyncContactScreen() {
  const router = useRouter();
  const auth   = getAuth();
  const user   = auth.currentUser;

  const [tab,       setTab]       = useState<Tab>('my-code');
  const [phase,     setPhase]     = useState<Phase>('idle');
  const [myCode,    setMyCode]    = useState('');
  const [enterCode, setEnterCode] = useState('');
  const [timeLeft,  setTimeLeft]  = useState(0);
  const [synced,    setSynced]    = useState<{ name: string; phone?: string | null; email?: string | null } | null>(null);
  const [errMsg,    setErrMsg]    = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Countdown timer
  useEffect(() => {
    if (phase !== 'waiting' || timeLeft <= 0) return;
    const t = setInterval(() => {
      setTimeLeft(v => {
        if (v <= 1) {
          clearInterval(t);
          setPhase('idle');
          setMyCode('');
          return 0;
        }
        return v - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [phase]);

  // Poll for other user verifying
  useEffect(() => {
    if (phase !== 'waiting' || !myCode) return;
    pollRef.current = setInterval(async () => {
      try {
        const resp = await fetch(`${API}/${myCode}`);
        if (resp.status === 404 || resp.status === 410) {
          if (pollRef.current) clearInterval(pollRef.current);
          setPhase('idle');
          setMyCode('');
          return;
        }
        const data = await resp.json();
        if (data.verified) {
          if (pollRef.current) clearInterval(pollRef.current);
          setPhase('done');
          setSynced({ name: 'Contact synced!' });
        }
      } catch {}
    }, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [phase, myCode]);

  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  const generateCode = async () => {
    setPhase('generating');
    try {
      const resp = await fetch(`${API}/create`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uid:         user?.uid          || 'user123',
          displayName: user?.displayName  || 'VaultChat User',
          email:       user?.email        || '',
          phoneNumber: user?.phoneNumber  || '',
        }),
      });
      const data = await resp.json();
      if (data.success) {
        setMyCode(data.code);
        setTimeLeft(300);
        setPhase('waiting');
      } else {
        throw new Error(data.error);
      }
    } catch (e: any) {
      setErrMsg(e.message || 'Failed to generate code');
      setPhase('error');
    }
  };

  const verifyCode = async () => {
    if (enterCode.length !== 6) { Alert.alert('Invalid', 'Enter a 6-digit code'); return; }
    setPhase('verifying');
    try {
      const resp = await fetch(`${API}/verify`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code:        enterCode,
          uid:         user?.uid          || 'user456',
          displayName: user?.displayName  || 'VaultChat User',
          email:       user?.email        || '',
          phoneNumber: user?.phoneNumber  || '',
        }),
      });
      const data = await resp.json();
      if (data.success) {
        setPhase('done');
        setSynced({
          name:  data.initiator.displayName,
          email: data.initiator.email,
          phone: data.initiator.phoneNumber,
        });
      } else {
        throw new Error(data.error);
      }
    } catch (e: any) {
      setPhase('error');
      setErrMsg(e.message || 'Verification failed');
    }
  };

  // FIX: was Clipboard.setString (deprecated) — now uses expo-clipboard async API
  const copyCode = async () => {
    await Clipboard.setStringAsync(myCode);
    Alert.alert('Copied!', 'Code copied to clipboard');
  };

  const shareCode = () => {
    Share.share({ message: `My VaultChat Sync Code: ${myCode} (valid 5 min)` });
  };

  const reset = () => {
    setPhase('idle');
    setMyCode('');
    setEnterCode('');
    setSynced(null);
    setErrMsg('');
    if (pollRef.current) clearInterval(pollRef.current);
  };

  // Done screen
  if (phase === 'done' && synced) {
    return (
      <SafeAreaView style={s.root}>
        <View style={{ flex: 1, padding: 24, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 56, marginBottom: 16 }}>??</Text>
          <Text style={[s.heading, { color: C.purple, textAlign: 'center', marginBottom: 8 }]}>Contact Synced!</Text>
          <Text style={[s.sub, { textAlign: 'center', marginBottom: 24 }]}>
            Both users have consented. Contact saved securely.
          </Text>

          <View style={[s.card, { width: '100%', marginBottom: 20 }]}>
            <Text style={[s.label, { marginBottom: 10 }]}>SYNCED CONTACT</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: `${C.purple}22`,
                alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: 22 }}>??</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.heading}>{synced.name}</Text>
                {synced.email ? <Text style={s.sub}>{synced.email}</Text> : null}
                {synced.phone ? <Text style={s.sub}>{synced.phone}</Text> : null}
              </View>
            </View>
          </View>

          <TouchableOpacity style={[s.btn, { backgroundColor: C.purple, width: '100%', marginBottom: 10 }]} onPress={() => router.back()}>
            <Text style={s.btnTxt}>? Done</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.btn, { backgroundColor: 'rgba(255,255,255,0.06)', width: '100%' }]} onPress={reset}>
            <Text style={[s.btnTxt, { color: C.sub }]}>Sync Another</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.root}>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <TouchableOpacity onPress={() => router.back()} style={{ marginBottom: 16 }}>
          <Text style={{ color: C.purple, fontSize: 15 }}>? Back</Text>
        </TouchableOpacity>

        <Text style={s.label}>SYNC CONTACT</Text>
        <Text style={s.heading}>Add Contact Securely</Text>
        <Text style={[s.sub, { marginBottom: 24 }]}>
          Both people must agree. One generates a code, the other enters it.
        </Text>

        {/* How it works */}
        <View style={[s.card, { marginBottom: 20, borderColor: `${C.purple}22` }]}>
          {[
            ['1??', 'Person A taps "Show My Code" and shares the 6-digit code verbally'],
            ['2??', 'Person B taps "Enter Their Code" and types it in'],
            ['3??', 'Both contacts are saved — mutual consent confirmed'],
          ].map(([icon, text]) => (
            <View key={icon} style={{ flexDirection: 'row', gap: 10, marginBottom: 8 }}>
              <Text style={{ fontSize: 16 }}>{icon}</Text>
              <Text style={[s.sub, { flex: 1 }]}>{text}</Text>
            </View>
          ))}
        </View>

        {/* Tabs */}
        <View style={s.tabRow}>
          <TouchableOpacity
            style={[s.tabBtn, tab === 'my-code' && { backgroundColor: `${C.purple}18`, borderColor: `${C.purple}44` }]}
            onPress={() => { setTab('my-code'); reset(); }}
          >
            <Text style={[s.tabTxt, { color: tab === 'my-code' ? C.purple : C.sub }]}>?? Show My Code</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.tabBtn, tab === 'enter-code' && { backgroundColor: `${C.purple}18`, borderColor: `${C.purple}44` }]}
            onPress={() => { setTab('enter-code'); reset(); }}
          >
            <Text style={[s.tabTxt, { color: tab === 'enter-code' ? C.purple : C.sub }]}>?? Enter Their Code</Text>
          </TouchableOpacity>
        </View>

        {/* MY CODE TAB */}
        {tab === 'my-code' && (
          <View style={s.card}>
            {phase === 'idle' && (
              <>
                <Text style={[s.sub, { marginBottom: 16, textAlign: 'center' }]}>
                  Generate a 6-digit code valid for{' '}
                  <Text style={{ color: C.purple }}>5 minutes</Text>.
                </Text>
                <TouchableOpacity style={[s.btn, { backgroundColor: C.purple }]} onPress={generateCode}>
                  <Text style={s.btnTxt}>?? Generate My Code</Text>
                </TouchableOpacity>
              </>
            )}

            {phase === 'generating' && (
              <View style={{ alignItems: 'center', padding: 20 }}>
                <ActivityIndicator color={C.purple} size="large" />
                <Text style={[s.sub, { marginTop: 12 }]}>Generating secure code…</Text>
              </View>
            )}

            {phase === 'error' && tab === 'my-code' && (
              <>
                <Text style={[s.sub, { color: 'rgba(239,68,68,0.8)', textAlign: 'center', marginBottom: 12 }]}>
                  {errMsg}
                </Text>
                <TouchableOpacity style={[s.btn, { backgroundColor: C.purple }]} onPress={generateCode}>
                  <Text style={s.btnTxt}>Try Again</Text>
                </TouchableOpacity>
              </>
            )}

            {phase === 'waiting' && myCode.length > 0 && (
              <>
                <Text style={[s.label, { textAlign: 'center', marginBottom: 12 }]}>YOUR CODE — SHARE VERBALLY</Text>
                <View style={[s.codeBox, { borderColor: `${C.purple}55` }]}>
                  <Text style={[s.codeText, { color: C.purple }]}>
                    {myCode.slice(0, 3)}  {myCode.slice(3)}
                  </Text>
                </View>
                <Text style={[s.sub, { textAlign: 'center', marginBottom: 16 }]}>
                  Expires in{' '}
                  <Text style={{ color: C.purple, fontWeight: '700' }}>{fmt(timeLeft)}</Text>
                </Text>
                <View style={{ flexDirection: 'row', gap: 10, marginBottom: 14 }}>
                  <TouchableOpacity style={[s.smallBtn, { flex: 1, borderColor: `${C.purple}44` }]} onPress={copyCode}>
                    <Text style={[s.smallBtnTxt, { color: C.purple }]}>?? Copy</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[s.smallBtn, { flex: 1, borderColor: `${C.purple}44` }]} onPress={shareCode}>
                    <Text style={[s.smallBtnTxt, { color: C.purple }]}>?? Share</Text>
                  </TouchableOpacity>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <ActivityIndicator color={C.purple} size="small" />
                  <Text style={[s.sub, { flex: 1 }]}>Waiting for the other person to enter this code…</Text>
                </View>
              </>
            )}
          </View>
        )}

        {/* ENTER CODE TAB */}
        {tab === 'enter-code' && (
          <View style={s.card}>
            {(phase === 'idle' || phase === 'error') && (
              <>
                <Text style={[s.sub, { marginBottom: 16 }]}>
                  Ask the other person to generate their code, then type it here.
                </Text>

                <TextInput
                  style={[s.codeInput, { borderColor: enterCode.length === 6 ? `${C.purple}88` : C.border }]}
                  value={enterCode}
                  onChangeText={t => setEnterCode(t.replace(/\D/g, '').slice(0, 6))}
                  placeholder="? ? ? ? ? ?"
                  placeholderTextColor={C.sub}
                  keyboardType="number-pad"
                  maxLength={6}
                  textAlign="center"
                />

                <View style={s.dotRow}>
                  {Array.from({ length: 6 }).map((_, i) => (
                    <View
                      key={i}
                      style={[s.dotIndicator, { backgroundColor: i < enterCode.length ? C.purple : 'rgba(255,255,255,0.15)' }]}
                    />
                  ))}
                </View>

                {phase === 'error' && (
                  <Text style={[s.sub, { color: 'rgba(239,68,68,0.8)', textAlign: 'center', marginBottom: 12 }]}>
                    {errMsg}
                  </Text>
                )}

                <TouchableOpacity
                  style={[s.btn, { backgroundColor: enterCode.length === 6 ? C.purple : 'rgba(255,255,255,0.06)' }]}
                  onPress={verifyCode}
                  disabled={enterCode.length !== 6}
                >
                  <Text style={[s.btnTxt, { color: enterCode.length === 6 ? '#fff' : C.sub }]}>
                    ?? Verify & Sync Contact
                  </Text>
                </TouchableOpacity>
              </>
            )}

            {phase === 'verifying' && (
              <View style={{ alignItems: 'center', padding: 20 }}>
                <ActivityIndicator color={C.purple} size="large" />
                <Text style={[s.sub, { marginTop: 12 }]}>Verifying code…</Text>
              </View>
            )}
          </View>
        )}

        <View style={[s.card, { marginTop: 8, borderColor: 'rgba(255,255,255,0.05)' }]}>
          <Text style={[s.sub, { lineHeight: 20 }]}>
            ??{' '}
            <Text style={{ color: 'rgba(255,255,255,0.6)', fontWeight: '700' }}>Privacy-first:</Text>
            {' '}No contact is saved unless both users consent. Code expires in 5 min and is single-use only.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:        { flex: 1, backgroundColor: '#030912' },
  heading:     { fontSize: 20, fontWeight: '900', color: '#fff', marginBottom: 4 },
  sub:         { fontSize: 12, color: 'rgba(255,255,255,0.4)', lineHeight: 18 },
  label:       { fontSize: 9, fontWeight: '700', color: 'rgba(255,255,255,0.3)', letterSpacing: 2, marginBottom: 4 },
  card:        { backgroundColor: '#0D1B2E', borderRadius: 16, padding: 16, borderWidth: 1,
                 borderColor: 'rgba(255,255,255,0.09)', marginBottom: 12 },
  tabRow:      { flexDirection: 'row', gap: 8, marginBottom: 16 },
  tabBtn:      { flex: 1, padding: 11, borderRadius: 12, alignItems: 'center',
                 backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1,
                 borderColor: 'rgba(255,255,255,0.08)' },
  tabTxt:      { fontSize: 12, fontWeight: '700' },
  btn:         { borderRadius: 14, padding: 14, alignItems: 'center', marginBottom: 8 },
  btnTxt:      { fontSize: 14, fontWeight: '800', color: '#fff' },
  smallBtn:    { padding: 10, borderRadius: 10, alignItems: 'center',
                 backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1 },
  smallBtnTxt: { fontSize: 12, fontWeight: '700' },
  codeBox:     { backgroundColor: 'rgba(167,139,250,0.08)', borderRadius: 16, borderWidth: 1.5,
                 padding: 20, alignItems: 'center', marginBottom: 12 },
  codeText:    { fontSize: 38, fontWeight: '900', letterSpacing: 14,
                 fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace' },
  codeInput:   { backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 14, borderWidth: 1.5,
                 color: '#fff', fontSize: 32, fontWeight: '900', padding: 16, letterSpacing: 12,
                 fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace', marginBottom: 12 },
  dotRow:      { flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 16 },
  dotIndicator:{ width: 10, height: 10, borderRadius: 5 },
  optTitle:    { fontSize: 14, fontWeight: '800', color: '#fff' },
});
