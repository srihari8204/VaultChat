// app/dark-web-guard.tsx — Dark Web Guard (real, no Firebase).
//
// Password check: REAL and keyless — uses the Have I Been Pwned "Pwned
// Passwords" range API with k-anonymity (only a 5-char SHA-1 prefix leaves the
// device; the full password never does). Works out of the box.
//
// Email breach check: real HIBP breach API, which requires a paid api key. The
// user pastes their key (stored in SecureStore); without one, that tab simply
// asks for a key instead of showing fake data.

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, TextInput, Alert, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { Ionicons } from '@expo/vector-icons';
import { Aurora } from '../constants/theme';
import { getMyProfile } from '../lib/chatService';

interface Breach {
  name: string; domain: string; breachDate: string; pwnCount: number;
  dataClasses: string[]; description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

// ── Real keyless password breach check (HIBP range API, k-anonymity) ──
async function checkPasswordPwned(password: string): Promise<number> {
  const hash = (await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA1, password)).toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, { headers: { 'Add-Padding': 'true' } });
  if (!res.ok) throw new Error('Breach service unavailable');
  const text = await res.text();
  for (const line of text.split('\n')) {
    const [suf, count] = line.trim().split(':');
    if (suf === suffix) return parseInt(count, 10) || 0;
  }
  return 0;
}

// ── Real email breach check (HIBP breach API — needs a paid key) ──
async function checkEmailBreaches(email: string, key: string): Promise<Breach[]> {
  const res = await fetch(
    `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=false`,
    { headers: { 'hibp-api-key': key, 'User-Agent': 'VaultChat-SecurityApp' } },
  );
  if (res.status === 404) return [];
  if (res.status === 401) throw new Error('Invalid HIBP API key');
  if (res.status === 429) throw new Error('Rate limited — wait a minute');
  if (!res.ok) throw new Error(`HIBP error: ${res.status}`);
  const data = await res.json();
  return data.map((b: any): Breach => ({
    name: b.Name, domain: b.Domain, breachDate: b.BreachDate, pwnCount: b.PwnCount,
    dataClasses: b.DataClasses || [], description: (b.Description || '').replace(/<[^>]*>/g, ''),
    severity: b.PwnCount > 100_000_000 ? 'critical' : b.PwnCount > 10_000_000 ? 'high' : b.PwnCount > 1_000_000 ? 'medium' : 'low',
  }));
}

const fmt = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : `${n}`;
const sevColor = (s: Breach['severity']) => s === 'critical' ? Aurora.danger : s === 'high' ? '#F97316' : s === 'medium' ? '#F5C842' : Aurora.primary;

type Tab = 'password' | 'email';

export default function DarkWebGuardScreen() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('password');

  const [password, setPassword] = useState('');
  const [pwResult, setPwResult] = useState<number | null>(null);
  const [pwChecking, setPwChecking] = useState(false);

  const [email, setEmail] = useState('');
  const [hibpKey, setHibpKey] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [breaches, setBreaches] = useState<Breach[] | null>(null);
  const [emailChecking, setEmailChecking] = useState(false);

  useEffect(() => {
    SecureStore.getItemAsync('hibp_key').then(v => { if (v) setHibpKey(v); }).catch(() => {});
    getMyProfile().then(p => { if (p.email) setEmail(p.email); }).catch(() => {});
  }, []);

  const checkPassword = useCallback(async () => {
    if (!password) return;
    setPwChecking(true); setPwResult(null);
    try { setPwResult(await checkPasswordPwned(password)); }
    catch (e: any) { Alert.alert('Error', e?.message ?? 'Check failed'); }
    finally { setPwChecking(false); }
  }, [password]);

  const saveKey = async () => {
    const k = keyInput.trim();
    if (!k) return;
    await SecureStore.setItemAsync('hibp_key', k);
    setHibpKey(k); setKeyInput('');
    Alert.alert('Saved', 'HIBP key stored securely on this device.');
  };

  const checkEmail = useCallback(async () => {
    if (!email.includes('@')) { Alert.alert('Invalid', 'Enter a valid email'); return; }
    if (!hibpKey) { Alert.alert('Key required', 'Email breach lookup needs a HIBP API key.'); return; }
    setEmailChecking(true); setBreaches(null);
    try { setBreaches(await checkEmailBreaches(email.trim().toLowerCase(), hibpKey)); }
    catch (e: any) { Alert.alert('Scan failed', e?.message ?? 'Could not scan'); }
    finally { setEmailChecking(false); }
  }, [email, hibpKey]);

  return (
    <View style={s.container}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={Aurora.text} />
        </TouchableOpacity>
        <Text style={s.title}>Dark Web Guard</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={s.tabs}>
        <TouchableOpacity style={[s.tab, tab === 'password' && s.tabActive]} onPress={() => setTab('password')}>
          <Text style={[s.tabTxt, tab === 'password' && s.tabTxtActive]}>Password</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.tab, tab === 'email' && s.tabActive]} onPress={() => setTab('email')}>
          <Text style={[s.tabTxt, tab === 'email' && s.tabTxtActive]}>Email</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        {tab === 'password' ? (
          <>
            <View style={s.hero}>
              <Text style={s.heroIcon}>🔐</Text>
              <Text style={s.heroTitle}>Has your password leaked?</Text>
              <Text style={s.heroSub}>Checked against billions of breached passwords. Your password never leaves the device — only a short hash prefix is sent (k-anonymity).</Text>
            </View>

            <View style={s.card}>
              <Text style={s.label}>Password to check</Text>
              <TextInput
                style={s.input}
                value={password}
                onChangeText={(t) => { setPassword(t); setPwResult(null); }}
                placeholder="Enter a password"
                placeholderTextColor={Aurora.textFaint}
                secureTextEntry
                autoCapitalize="none"
              />
              <TouchableOpacity style={[s.btn, (!password || pwChecking) && s.btnDim]} onPress={checkPassword} disabled={!password || pwChecking}>
                {pwChecking ? <ActivityIndicator color="#04130D" /> : <Text style={s.btnTxt}>Check password</Text>}
              </TouchableOpacity>
            </View>

            {pwResult !== null && (
              <View style={[s.result, pwResult === 0 ? s.resultClean : s.resultBad]}>
                <Text style={s.resultIcon}>{pwResult === 0 ? '✅' : '⚠️'}</Text>
                <Text style={s.resultTitle}>{pwResult === 0 ? 'Not found in any breach' : `Seen ${fmt(pwResult)} times in breaches`}</Text>
                <Text style={s.resultSub}>
                  {pwResult === 0
                    ? 'This password hasn’t appeared in known breaches. Still, use a unique password per site.'
                    : 'This password is compromised — do not use it. Change it anywhere you’ve used it and enable 2FA.'}
                </Text>
              </View>
            )}
          </>
        ) : (
          <>
            <View style={s.hero}>
              <Text style={s.heroIcon}>🌑</Text>
              <Text style={s.heroTitle}>Email breach monitor</Text>
              <Text style={s.heroSub}>Checks whether your email appears in known data breaches via Have I Been Pwned.</Text>
            </View>

            {!hibpKey ? (
              <View style={s.card}>
                <Text style={s.label}>HIBP API key required</Text>
                <Text style={s.note}>Email lookup uses the paid HIBP API. Paste your key (haveibeenpwned.com/API/Key) — stored only on this device.</Text>
                <TextInput style={s.input} value={keyInput} onChangeText={setKeyInput} placeholder="HIBP API key" placeholderTextColor={Aurora.textFaint} autoCapitalize="none" secureTextEntry />
                <TouchableOpacity style={[s.btn, !keyInput.trim() && s.btnDim]} onPress={saveKey} disabled={!keyInput.trim()}>
                  <Text style={s.btnTxt}>Save key</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={s.card}>
                <Text style={s.label}>Email to scan</Text>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <TextInput style={[s.input, { flex: 1 }]} value={email} onChangeText={setEmail} placeholder="your@email.com" placeholderTextColor={Aurora.textFaint} keyboardType="email-address" autoCapitalize="none" />
                  <TouchableOpacity style={[s.btn, { paddingHorizontal: 18 }, emailChecking && s.btnDim]} onPress={checkEmail} disabled={emailChecking}>
                    {emailChecking ? <ActivityIndicator color="#04130D" size="small" /> : <Text style={s.btnTxt}>Scan</Text>}
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {breaches !== null && (
              <View style={[s.result, breaches.length === 0 ? s.resultClean : s.resultBad]}>
                <Text style={s.resultIcon}>{breaches.length === 0 ? '✅' : '⚠️'}</Text>
                <Text style={s.resultTitle}>{breaches.length === 0 ? 'No breaches found' : `${breaches.length} breach${breaches.length > 1 ? 'es' : ''} found`}</Text>
              </View>
            )}

            {breaches?.map(b => (
              <View key={b.name} style={s.breachCard}>
                <View style={[s.sevBar, { backgroundColor: sevColor(b.severity) }]} />
                <View style={{ flex: 1 }}>
                  <Text style={s.breachName}>{b.name}</Text>
                  <Text style={s.breachMeta}>{fmt(b.pwnCount)} accounts · {b.breachDate.slice(0, 4)}</Text>
                  <Text style={s.breachData} numberOfLines={2}>{b.dataClasses.join(', ')}</Text>
                </View>
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: Aurora.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 54, paddingHorizontal: 16, paddingBottom: 8 },
  backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  title: { color: Aurora.text, fontSize: 18, fontWeight: '800' },
  tabs: { flexDirection: 'row', marginHorizontal: 16, backgroundColor: Aurora.surface, borderRadius: 12, padding: 3, borderWidth: 1, borderColor: Aurora.border },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 10 },
  tabActive: { backgroundColor: Aurora.primary },
  tabTxt: { color: Aurora.textDim, fontSize: 14, fontWeight: '700' },
  tabTxtActive: { color: '#04130D' },
  hero: { alignItems: 'center', paddingVertical: 20 },
  heroIcon: { fontSize: 52, marginBottom: 10 },
  heroTitle: { fontSize: 20, fontWeight: '800', color: Aurora.text, marginBottom: 8, textAlign: 'center' },
  heroSub: { fontSize: 13, color: Aurora.textDim, textAlign: 'center', lineHeight: 19 },
  card: { backgroundColor: Aurora.card, borderRadius: 14, borderWidth: 1, borderColor: Aurora.border, padding: 16, marginBottom: 16 },
  label: { fontSize: 12, color: Aurora.textDim, marginBottom: 8 },
  note: { fontSize: 12, color: Aurora.textDim, marginBottom: 10, lineHeight: 18 },
  input: { backgroundColor: Aurora.surface, borderRadius: 10, borderWidth: 1, borderColor: Aurora.border, paddingHorizontal: 14, paddingVertical: 11, color: Aurora.text, fontSize: 14, marginBottom: 10 },
  btn: { backgroundColor: Aurora.primary, borderRadius: 10, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  btnDim: { opacity: 0.5 },
  btnTxt: { color: '#04130D', fontWeight: '800', fontSize: 14 },
  result: { borderRadius: 14, borderWidth: 1, padding: 20, alignItems: 'center', gap: 8, marginBottom: 16 },
  resultClean: { backgroundColor: 'rgba(16,185,129,0.1)', borderColor: 'rgba(16,185,129,0.4)' },
  resultBad: { backgroundColor: 'rgba(239,68,68,0.1)', borderColor: 'rgba(239,68,68,0.4)' },
  resultIcon: { fontSize: 40 },
  resultTitle: { fontSize: 17, fontWeight: '800', color: Aurora.text, textAlign: 'center' },
  resultSub: { fontSize: 13, color: Aurora.textDim, textAlign: 'center', lineHeight: 19 },
  breachCard: { flexDirection: 'row', backgroundColor: Aurora.card, borderRadius: 12, borderWidth: 1, borderColor: Aurora.border, padding: 12, marginBottom: 8, gap: 10, overflow: 'hidden' },
  sevBar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
  breachName: { fontSize: 15, fontWeight: '700', color: Aurora.text },
  breachMeta: { fontSize: 11, color: Aurora.textDim, marginTop: 2 },
  breachData: { fontSize: 12, color: Aurora.textDim, marginTop: 4 },
});
