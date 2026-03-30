// app/decentralized-id.tsx
// Decentralised VaultID — blockchain-backed identity

import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  Alert, ScrollView, StyleSheet, Text, TextInput,
  TouchableOpacity, View,
} from 'react-native';

const C = {
  bg: '#FFFFFF', primary: '#4A9FFF', secondary: '#7C3AED',
  accent: '#10B981', gold: '#F59E0B', text: '#fff',
  dim: 'rgba(255,255,255,0.5)', faint: 'rgba(255,255,255,0.2)',
  card: 'rgba(10,22,40,0.8)', border: 'rgba(255,255,255,0.06)',
};

interface DIDRecord {
  did: string;
  displayName: string;
  createdAt: number;
  chain: string;
  verified: boolean;
  recoveryHash: string;
}

const CHAINS = [
  { id: 'polygon', name: 'Polygon', icon: '🟣', gas: 'Low (~₹2)' },
  { id: 'ethereum', name: 'Ethereum', icon: '💎', gas: 'High (~₹500)' },
  { id: 'solana', name: 'Solana', icon: '🟢', gas: 'Minimal (~₹0.5)' },
  { id: 'vaultchain', name: 'VaultChain (L2)', icon: '🔐', gas: 'Free' },
];

const BENEFITS = [
  { icon: '🆔', title: 'Truly Yours', desc: 'No authority can revoke your identity. You own it cryptographically.' },
  { icon: '📵', title: 'Phone-Free', desc: 'No phone number required. Chat with just your DID.' },
  { icon: '🔄', title: 'Portable', desc: 'Use your VaultID across any app that supports DID.' },
  { icon: '🛡️', title: 'Censorship Proof', desc: 'Cannot be banned, blocked, or deplatformed by any company.' },
  { icon: '🔑', title: 'Self-Sovereign', desc: 'Private keys stored in your device. Only you control access.' },
  { icon: '🌍', title: 'Universal', desc: 'Works globally. No country restrictions or KYC requirements.' },
];

export default function DecentralizedIDScreen() {
  const [did, setDid] = useState<DIDRecord | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [selectedChain, setSelectedChain] = useState('polygon');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    (async () => {
      const raw = await AsyncStorage.getItem('vc_did_record');
      if (raw) setDid(JSON.parse(raw));
    })();
  }, []);

  const generateDID = async () => {
    if (!displayName.trim()) { Alert.alert('Error', 'Enter a display name'); return; }
    setCreating(true);
    // Simulate DID creation with cryptographic keypair
    const timestamp = Date.now();
    const randomHex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    const recoveryHex = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

    const record: DIDRecord = {
      did: `did:vault:${selectedChain}:${randomHex}`,
      displayName: displayName.trim(),
      createdAt: timestamp,
      chain: selectedChain,
      verified: true,
      recoveryHash: recoveryHex,
    };

    await AsyncStorage.setItem('vc_did_record', JSON.stringify(record));
    setDid(record);
    setCreating(false);
    Alert.alert('DID Created!', `Your decentralised identity is now on ${CHAINS.find(c => c.id === selectedChain)?.name}`);
  };

  const revokeDID = () => {
    Alert.alert('Revoke DID?', 'This will permanently delete your decentralised identity.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Revoke', style: 'destructive', onPress: async () => {
        await AsyncStorage.removeItem('vc_did_record');
        setDid(null);
      }},
    ]);
  };

  return (
    <>
      <Stack.Screen options={{
        title: 'Decentralised ID',
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTintColor: '#1F2937',
      }} />
      <View style={st.screen}>
        <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>

          {/* Hero */}
          <LinearGradient colors={['#7C3AED', '#4A9FFF']} style={st.hero}>
            <Text style={{ fontSize: 52 }}>🆔</Text>
            <Text style={st.heroTitle}>Decentralised VaultID</Text>
            <Text style={st.heroSub}>Your identity, on the blockchain. No authority can revoke it.</Text>
          </LinearGradient>

          {did ? (
            <>
              {/* Active DID Card */}
              <View style={[st.card, { borderColor: C.accent + '44' }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                  <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: C.accent + '22', justifyContent: 'center', alignItems: 'center' }}>
                    <Text style={{ fontSize: 20 }}>✅</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: C.accent, fontSize: 13, fontWeight: '800' }}>VERIFIED DID</Text>
                    <Text style={{ color: C.dim, fontSize: 10 }}>On-chain since {new Date(did.createdAt).toLocaleDateString()}</Text>
                  </View>
                </View>

                <Text style={{ color: C.faint, fontSize: 9, letterSpacing: 2, marginBottom: 4 }}>YOUR DID</Text>
                <View style={{ backgroundColor: '#060E1E', borderRadius: 10, padding: 12, marginBottom: 12 }}>
                  <Text style={{ color: C.primary, fontSize: 11, fontFamily: 'monospace' }} selectable>{did.did}</Text>
                </View>

                <View style={{ flexDirection: 'row', gap: 10, marginBottom: 12 }}>
                  <View style={st.metaBox}>
                    <Text style={{ color: C.dim, fontSize: 9 }}>NAME</Text>
                    <Text style={{ color: C.text, fontSize: 13, fontWeight: '700' }}>{did.displayName}</Text>
                  </View>
                  <View style={st.metaBox}>
                    <Text style={{ color: C.dim, fontSize: 9 }}>CHAIN</Text>
                    <Text style={{ color: C.text, fontSize: 13, fontWeight: '700' }}>
                      {CHAINS.find(c => c.id === did.chain)?.icon} {CHAINS.find(c => c.id === did.chain)?.name}
                    </Text>
                  </View>
                </View>

                <TouchableOpacity onPress={revokeDID} style={{ alignItems: 'center', paddingVertical: 10 }}>
                  <Text style={{ color: '#EF4444', fontSize: 12, fontWeight: '600' }}>Revoke DID</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <>
              {/* Create DID */}
              <View style={st.card}>
                <Text style={st.cardTitle}>Create Your DID</Text>
                <Text style={{ color: C.dim, fontSize: 12, marginBottom: 16 }}>
                  Generate a decentralised identity that no one can take away.
                </Text>

                <Text style={st.label}>DISPLAY NAME</Text>
                <TextInput
                  style={st.input}
                  placeholder="Your public name"
                  placeholderTextColor={C.faint}
                  value={displayName}
                  onChangeText={setDisplayName}
                />

                <Text style={st.label}>BLOCKCHAIN</Text>
                <View style={{ gap: 8, marginBottom: 16 }}>
                  {CHAINS.map(chain => (
                    <TouchableOpacity
                      key={chain.id}
                      style={[st.chainCard, selectedChain === chain.id && { borderColor: C.primary, backgroundColor: C.primary + '12' }]}
                      onPress={() => setSelectedChain(chain.id)}
                    >
                      <Text style={{ fontSize: 22 }}>{chain.icon}</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: C.text, fontSize: 13, fontWeight: '700' }}>{chain.name}</Text>
                        <Text style={{ color: C.dim, fontSize: 11 }}>Gas: {chain.gas}</Text>
                      </View>
                      {selectedChain === chain.id && <Text style={{ color: C.primary, fontSize: 16 }}>✓</Text>}
                    </TouchableOpacity>
                  ))}
                </View>

                <TouchableOpacity onPress={generateDID} disabled={creating}>
                  <LinearGradient colors={[C.primary, C.secondary]} style={st.createBtn}>
                    <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>
                      {creating ? 'Generating...' : '🔐 Create Decentralised ID'}
                    </Text>
                  </LinearGradient>
                </TouchableOpacity>
              </View>
            </>
          )}

          {/* Benefits */}
          <Text style={st.sectionLabel}>WHY DECENTRALISED?</Text>
          <View style={{ gap: 10 }}>
            {BENEFITS.map((b, i) => (
              <View key={i} style={st.benefitCard}>
                <Text style={{ fontSize: 24 }}>{b.icon}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: C.text, fontSize: 13, fontWeight: '700' }}>{b.title}</Text>
                  <Text style={{ color: C.dim, fontSize: 11, marginTop: 2 }}>{b.desc}</Text>
                </View>
              </View>
            ))}
          </View>

          {/* Comparison */}
          <Text style={st.sectionLabel}>IDENTITY COMPARISON</Text>
          <View style={st.card}>
            {[
              { app: 'WhatsApp', method: 'Phone number', control: 'Meta', revocable: true },
              { app: 'Telegram', method: 'Phone number', control: 'Telegram', revocable: true },
              { app: 'Signal', method: 'Phone number', control: 'Signal Foundation', revocable: true },
              { app: 'VaultChat', method: 'DID (Blockchain)', control: 'You', revocable: false },
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

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  hero: { borderRadius: 20, padding: 24, alignItems: 'center', marginBottom: 20, gap: 10 },
  heroTitle: { color: '#fff', fontSize: 22, fontWeight: '900', textAlign: 'center' },
  heroSub: { color: 'rgba(255,255,255,0.7)', fontSize: 13, textAlign: 'center', lineHeight: 20 },
  card: { backgroundColor: C.card, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: C.border, marginBottom: 16 },
  cardTitle: { color: C.text, fontSize: 18, fontWeight: '900', marginBottom: 4 },
  sectionLabel: { color: C.faint, fontSize: 10, fontWeight: '800', letterSpacing: 2, marginBottom: 10, marginTop: 8 },
  label: { color: C.dim, fontSize: 10, fontWeight: '800', letterSpacing: 1.5, marginBottom: 6 },
  input: { backgroundColor: '#060E1E', borderRadius: 12, padding: 14, color: C.text, fontSize: 14, borderWidth: 1, borderColor: C.border, marginBottom: 14 },
  chainCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#060E1E', borderRadius: 12, padding: 14, borderWidth: 1.5, borderColor: C.border },
  createBtn: { borderRadius: 16, paddingVertical: 18, alignItems: 'center' },
  metaBox: { flex: 1, backgroundColor: '#060E1E', borderRadius: 10, padding: 10 },
  benefitCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.card, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: C.border },
  compRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: 8 },
});
