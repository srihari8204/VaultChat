// app/decentralized-id.tsx
// Decentralised VaultID — a real self-custodied cryptographic identity.
//
// Backed by lib/decentralizedId: a W3C did:key from an on-device Ed25519
// keypair. The private key is held in the OS keystore (SecureStore) and never
// leaves the device; "verified" means we actually signed a fresh challenge and
// verified it against the public key. No blockchain, no gas, no fabrication.

import { BRAND_ACCENT } from '../constants/theme';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack } from 'expo-router';
import React, { useEffect, useState, useMemo } from 'react';
import {
  Alert, ScrollView, StyleSheet, Text, TextInput,
  TouchableOpacity, View,
} from 'react-native';
import { copyAndAutoClear } from '../lib/clipboardSafe';
import {
  createDid, getDidRecord, proveControl, revokeDid, type DidRecord,
} from '../lib/decentralizedId';
import type { Palette } from '../constants/theme';
import { useColors } from '../lib/theme';

const C = {
  // bg WAS '#FFFFFF' while every foreground here is white (text, dims, the
  // card fills) — the screen rendered white-on-white and was unusable on a
  // device. The rest of this palette is unmistakably a dark navy design
  // (white text, rgba(255,255,255,..) dims, near-black glass), so the
  // background is what was wrong, not the foregrounds.
  bg: '#0A1628', primary: '#4A9FFF', secondary: '#7C3AED',
  accent: BRAND_ACCENT, gold: '#F59E0B', text: '#fff',
  dim: 'rgba(255,255,255,0.5)', faint: 'rgba(255,255,255,0.2)',
  card: 'rgba(10,22,40,0.8)', border: 'rgba(255,255,255,0.06)',
};

const BENEFITS = [
  { icon: '🆔', title: 'Truly Yours', desc: 'The keypair is generated on your device. No server issued it, no authority can revoke it.' },
  { icon: '🔑', title: 'Self-Sovereign', desc: 'The private key is sealed in your device keystore. Only you can sign as this identity.' },
  { icon: '🔄', title: 'Portable & Open', desc: 'It is a standard W3C did:key — any app that supports DIDs can verify your signatures.' },
  { icon: '✍️', title: 'Provable', desc: 'You can sign messages to prove control, with no third party in the loop.' },
];

export default function DecentralizedIDScreen() {
  const c = useColors();
  const st = useMemo(() => makeStyles(c), [c]);
  const [did, setDid] = useState<DidRecord | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [creating, setCreating] = useState(false);
  const [verified, setVerified] = useState(false);

  useEffect(() => {
    (async () => {
      const rec = await getDidRecord();
      setDid(rec);
      if (rec) setVerified(await proveControl());
    })();
  }, []);

  const generateDID = async () => {
    if (!displayName.trim()) { Alert.alert('Error', 'Enter a display name'); return; }
    setCreating(true);
    try {
      const rec = await createDid(displayName);
      setDid(rec);
      setVerified(await proveControl());
      Alert.alert('Identity created', 'Your Ed25519 keypair was generated on-device. The private key is sealed in your keystore.');
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Could not create identity');
    } finally {
      setCreating(false);
    }
  };

  const copyDid = async () => {
    if (!did) return;
    await copyAndAutoClear(did.did);
    Alert.alert('Copied', 'Your DID was copied (clipboard auto-clears).');
  };

  const revokeDID = () => {
    Alert.alert('Delete this identity?', 'The private key will be erased from this device. This cannot be undone — anyone you shared the DID with can no longer verify you.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        await revokeDid();
        setDid(null);
        setVerified(false);
      }},
    ]);
  };

  return (
    <>
      <Stack.Screen options={{
        headerShown: true, /* the root Stack sets headerShown:false app-wide, so the options below were inert and this screen had no back control at all */ 
        title: 'Decentralised ID',
        headerStyle: { backgroundColor: c.glassSoft },
        headerTintColor: '#1F2937',
      }} />
      <View style={st.screen}>
        <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>

          {/* Hero */}
          <LinearGradient colors={['#7C3AED', '#4A9FFF']} style={st.hero}>
            <Text style={{ fontSize: 52 }}>🆔</Text>
            <Text style={st.heroTitle}>Decentralised VaultID</Text>
            <Text style={st.heroSub}>Your identity is an Ed25519 keypair only you hold — generated on your device, controlled by no one else.</Text>
          </LinearGradient>

          {did ? (
            <View style={[st.card, { borderColor: (verified ? C.accent : C.gold) + '44' }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: (verified ? C.accent : C.gold) + '22', justifyContent: 'center', alignItems: 'center' }}>
                  <Text style={{ fontSize: 20 }}>{verified ? '✅' : '⚠️'}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: verified ? C.accent : C.gold, fontSize: 13, fontWeight: '800' }}>
                    {verified ? 'KEY CONTROL VERIFIED' : 'KEY NOT VERIFIED'}
                  </Text>
                  <Text style={{ color: C.dim, fontSize: 10 }}>Created {new Date(did.createdAt).toLocaleDateString()}</Text>
                </View>
              </View>

              <Text style={{ color: C.faint, fontSize: 9, letterSpacing: 2, marginBottom: 4 }}>YOUR DID</Text>
              <TouchableOpacity onPress={copyDid} style={{ backgroundColor: c.surfaceSolid, borderRadius: 10, padding: 12, marginBottom: 12 }}>
                <Text style={{ color: C.primary, fontSize: 11, fontFamily: 'monospace' }} selectable>{did.did}</Text>
                <Text style={{ color: C.faint, fontSize: 9, marginTop: 4 }}>Tap to copy</Text>
              </TouchableOpacity>

              <View style={{ flexDirection: 'row', gap: 10, marginBottom: 12 }}>
                <View style={st.metaBox}>
                  <Text style={{ color: C.dim, fontSize: 9 }}>NAME</Text>
                  <Text numberOfLines={1} style={{ color: C.text, fontSize: 13, fontWeight: '700' }}>{did.displayName}</Text>
                </View>
                <View style={st.metaBox}>
                  <Text style={{ color: C.dim, fontSize: 9 }}>KEY FINGERPRINT</Text>
                  <Text style={{ color: C.text, fontSize: 12, fontWeight: '700', fontFamily: 'monospace' }}>{did.fingerprint}</Text>
                </View>
              </View>

              <View style={st.metaBox}>
                <Text style={{ color: C.dim, fontSize: 9 }}>ALGORITHM</Text>
                <Text style={{ color: C.text, fontSize: 13, fontWeight: '700' }}>Ed25519 · did:key · private key in device keystore</Text>
              </View>

              <TouchableOpacity onPress={revokeDID} style={{ alignItems: 'center', paddingVertical: 10, marginTop: 8 }}>
                <Text style={{ color: '#EF4444', fontSize: 12, fontWeight: '600' }}>Delete identity</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={st.card}>
              <Text style={st.cardTitle}>Create Your DID</Text>
              <Text style={{ color: C.dim, fontSize: 12, marginBottom: 16 }}>
                Generate an Ed25519 keypair on this device. The private key is sealed in your keystore; the public did:key is yours to share.
              </Text>

              <Text style={st.label}>DISPLAY NAME</Text>
              <TextInput
                style={st.input}
                placeholder="Your public name"
                placeholderTextColor={C.faint}
                value={displayName}
                onChangeText={setDisplayName}
                autoCapitalize="words"
              />

              <View style={[st.metaBox, { marginBottom: 16 }]}>
                <Text style={{ color: C.dim, fontSize: 9 }}>KEY TYPE</Text>
                <Text style={{ color: C.text, fontSize: 13, fontWeight: '700' }}>Ed25519 (W3C did:key)</Text>
                <Text style={{ color: C.dim, fontSize: 11, marginTop: 2 }}>Generated locally · no server · no blockchain</Text>
              </View>

              <TouchableOpacity onPress={generateDID} disabled={creating}>
                <LinearGradient colors={[C.primary, C.secondary]} style={st.createBtn}>
                  <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>
                    {creating ? 'Generating…' : '🔐 Create Decentralised ID'}
                  </Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          )}

          {/* Benefits */}
          <Text style={st.sectionLabel}>WHY DECENTRALISED?</Text>
          <View style={{ gap: 10 }}>
            {BENEFITS.map((b, i) => (
              <View key={i} style={st.benefitCard}>
                <Text style={{ fontSize: 24 }}>{b.icon}</Text>
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={{ color: C.text, fontSize: 13, fontWeight: '700' }}>{b.title}</Text>
                  <Text style={{ color: C.dim, fontSize: 11, marginTop: 2 }}>{b.desc}</Text>
                </View>
              </View>
            ))}
          </View>

          {/* Comparison */}
          <Text style={st.sectionLabel}>IDENTITY COMPARISON</Text>
          <View style={st.card}>
            {[
              { app: 'WhatsApp', method: 'Phone number', revocable: true },
              { app: 'Telegram', method: 'Phone number', revocable: true },
              { app: 'Signal', method: 'Phone number', revocable: true },
              { app: 'crazzychat', method: 'Self-custodied Ed25519 keypair', revocable: false },
            ].map((r, i) => (
              <View key={i} style={[st.compRow, i < 3 && { borderBottomWidth: 1, borderBottomColor: C.border }]}>
                <Text style={{ color: C.text, fontSize: 13, fontWeight: '600', width: 80 }}>{r.app}</Text>
                <Text style={{ color: C.dim, fontSize: 11, flex: 1 }}>{r.method}</Text>
                <Text style={{ color: r.revocable ? '#EF4444' : C.accent, fontSize: 11, fontWeight: '700' }}>
                  {r.revocable ? '❌ Revocable' : '✅ Sovereign'}
                </Text>
              </View>
            ))}
          </View>

        </ScrollView>
      </View>
    </>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  hero: { borderRadius: 20, padding: 24, alignItems: 'center', marginBottom: 20, gap: 10 },
  heroTitle: { color: '#fff', fontSize: 22, fontWeight: '900', textAlign: 'center' },
  heroSub: { color: 'rgba(255,255,255,0.7)', fontSize: 13, textAlign: 'center', lineHeight: 20 },
  card: { backgroundColor: C.card, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: C.border, marginBottom: 16 },
  cardTitle: { color: C.text, fontSize: 18, fontWeight: '900', marginBottom: 4 },
  sectionLabel: { color: C.faint, fontSize: 10, fontWeight: '800', letterSpacing: 2, marginBottom: 10, marginTop: 8 },
  label: { color: C.dim, fontSize: 10, fontWeight: '800', letterSpacing: 1.5, marginBottom: 6 },
  input: { backgroundColor: c.bg, borderRadius: 12, padding: 14, color: C.text, fontSize: 14, borderWidth: 1, borderColor: C.border, marginBottom: 14 },
  createBtn: { borderRadius: 16, paddingVertical: 18, alignItems: 'center' },
  metaBox: { flex: 1, backgroundColor: c.bg, borderRadius: 10, padding: 10 },
  benefitCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.card, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: C.border },
  compRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: 8 },
});
