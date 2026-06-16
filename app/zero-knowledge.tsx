// app/zero-knowledge.tsx
// Zero-Knowledge Architecture status and info screen

import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useRouter } from 'expo-router';
import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useMemo } from 'react';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';

const ZK_LAYERS = [
  {
    icon: '🔐', title: 'Client-Side Encryption',
    desc: 'All messages encrypted on-device before leaving. Server never sees plaintext.',
    status: 'active', phase: 'Live',
  },
  {
    icon: '🔑', title: 'Key Derivation (PBKDF2)',
    desc: 'Encryption keys derived from user identities using PBKDF2 with 100,000 iterations. Keys never sent to server.',
    status: 'active', phase: 'Live',
  },
  {
    icon: '🛡️', title: 'Zero-Knowledge PIN Verification',
    desc: 'PIN stored as SHA-256 hash. Server never sees actual PIN. Verification happens on-device.',
    status: 'active', phase: 'Live',
  },
  {
    icon: '👤', title: 'On-Device Biometrics',
    desc: 'Face and fingerprint data never leaves device. Processed entirely by OS secure enclave.',
    status: 'active', phase: 'Live',
  },
  {
    icon: '📱', title: 'Local AI Processing',
    desc: 'Smart replies, writing assistant, and summarization run 100% on-device. Zero server calls.',
    status: 'active', phase: 'Live',
  },
  {
    icon: '🔗', title: 'Zero-Knowledge Contact Matching',
    desc: 'Phone numbers hashed with SHA-256 before matching. Server only sees hashes, never real numbers.',
    status: 'active', phase: 'Live',
  },
  {
    icon: '🏗️', title: 'Server-Side Zero-Knowledge Proofs',
    desc: 'Cryptographic proofs that server processed requests correctly without seeing data. Uses zk-SNARKs.',
    status: 'planned', phase: 'Phase 7',
  },
  {
    icon: '⚡', title: 'Verifiable Computation',
    desc: 'Users can mathematically verify that the server followed protocol without accessing plaintext.',
    status: 'planned', phase: 'Phase 8',
  },
];

const COMPARISON = [
  { app: 'WhatsApp', zk: false, desc: 'Meta processes metadata on servers' },
  { app: 'Signal', zk: false, desc: 'Sealed sender hides metadata, but no ZK proofs' },
  { app: 'Telegram', zk: false, desc: 'Server-side encryption (not E2E by default)' },
  { app: 'ProtonMail', zk: true, desc: 'Zero-knowledge for email, not messaging' },
  { app: 'VaultChat', zk: true, desc: 'ZK on client today, server ZK in Phase 7-8' },
];

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function ZeroKnowledgeScreen() {
  const { colors } = useTheme();
  const st = useS();
  const router = useRouter();

  return (
    <>
      <Stack.Screen options={{
        title: 'Zero-Knowledge',
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTintColor: '#1F2937',
      }} />
      <View style={st.screen}>
        <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
          {/* Header */}
          <LinearGradient colors={['#1D4ED8', colors.purple]} style={st.heroBanner}>
            <Text style={{ fontSize: 48 }}>🔒</Text>
            <Text style={st.heroTitle}>Zero-Knowledge Architecture</Text>
            <Text style={st.heroSub}>The server mathematically cannot read your data — even if compelled by law.</Text>
          </LinearGradient>

          {/* What is ZK */}
          <View style={st.card}>
            <Text style={st.cardTitle}>What is Zero-Knowledge?</Text>
            <Text style={st.cardDesc}>
              Zero-Knowledge means VaultChat&apos;s servers process your data without ever being able to read it.
              Your messages, files, and identity stay encrypted with keys only YOU control.
              Even if our servers are seized, your data remains mathematically unreadable.
            </Text>
          </View>

          {/* ZK Layers */}
          <Text style={st.sectionLabel}>PROTECTION LAYERS</Text>
          {ZK_LAYERS.map((layer, i) => (
            <View key={i} style={st.layerCard}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                <Text style={{ fontSize: 24 }}>{layer.icon}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={st.layerTitle}>{layer.title}</Text>
                </View>
                <View style={[st.statusPill, layer.status === 'active' ? st.pillActive : st.pillPlanned]}>
                  <Text style={[st.pillTxt, layer.status === 'active' ? { color: colors.primary } : { color: '#F59E0B' }]}>{layer.phase}</Text>
                </View>
              </View>
              <Text style={st.layerDesc}>{layer.desc}</Text>
            </View>
          ))}

          {/* Comparison */}
          <Text style={st.sectionLabel}>INDUSTRY COMPARISON</Text>
          <View style={st.card}>
            {COMPARISON.map((c, i) => (
              <View key={i} style={[st.compRow, i < COMPARISON.length - 1 && { borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)' }]}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700' }}>{c.app}</Text>
                  <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11, marginTop: 2 }}>{c.desc}</Text>
                </View>
                <Text style={{ fontSize: 18 }}>{c.zk ? '✅' : '❌'}</Text>
              </View>
            ))}
          </View>

          <TouchableOpacity onPress={() => router.back()} style={st.backBtn}>
            <Text style={{ color: '#4A9FFF', fontWeight: '700', fontSize: 14 }}>← Back to Settings</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    </>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#FFFFFF' },
  heroBanner: { borderRadius: 20, padding: 24, alignItems: 'center', marginBottom: 20, gap: 10 },
  heroTitle: { color: c.text, fontSize: 22, fontWeight: '900', textAlign: 'center' },
  heroSub: { color: 'rgba(255,255,255,0.7)', fontSize: 13, textAlign: 'center', lineHeight: 20 },
  card: { backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 16, padding: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', marginBottom: 16 },
  cardTitle: { color: c.text, fontSize: 16, fontWeight: '800', marginBottom: 8 },
  cardDesc: { color: 'rgba(255,255,255,0.5)', fontSize: 13, lineHeight: 20 },
  sectionLabel: { color: 'rgba(255,255,255,0.3)', fontSize: 10, fontWeight: '800', letterSpacing: 2, marginBottom: 10, marginTop: 8 },
  layerCard: { backgroundColor: 'rgba(10,22,40,0.8)', borderRadius: 14, padding: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', marginBottom: 10 },
  layerTitle: { color: c.text, fontSize: 14, fontWeight: '700' },
  layerDesc: { color: 'rgba(255,255,255,0.45)', fontSize: 12, lineHeight: 18 },
  statusPill: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1 },
  pillActive: { backgroundColor: 'rgba(16,185,129,0.1)', borderColor: 'rgba(16,185,129,0.3)' },
  pillPlanned: { backgroundColor: 'rgba(245,158,11,0.1)', borderColor: 'rgba(245,158,11,0.3)' },
  pillTxt: { fontSize: 9, fontWeight: '800' },
  compRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 12 },
  backBtn: { alignItems: 'center', paddingVertical: 16, marginTop: 8 },
});
