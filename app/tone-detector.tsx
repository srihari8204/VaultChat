// app/tone-detector.tsx — Message Tone Analyzer.
//
// Sends the draft to VaultChat's own on-prem LLM (/ai/assist task 'tone') and
// shows its read on how the message is likely to come across. The earlier
// version scored tone with keyword regex and fabricated confidence percentages;
// that's gone — this reflects a real model's judgement, or says so plainly when
// the AI service is offline.

import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, TextInput,
  StatusBar, ScrollView, ActivityIndicator,
} from 'react-native';
import { Stack } from 'expo-router';
import { aiAssist } from '../lib/ai';

const C = { bg: '#FFFFFF', accent: '#4A9FFF', green: '#10B981', card: '#F9FAFB', purple: '#A78BFA', border: '#E5E7EB' };

interface Analysis { id: number; text: string; analysis: string }

export default function ToneDetectorScreen() {
  const [input, setInput] = useState('');
  const [result, setResult] = useState<Analysis | null>(null);
  const [history, setHistory] = useState<Analysis[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const analyze = async () => {
    const text = input.trim();
    if (!text || analyzing) return;
    setAnalyzing(true);
    setError(null);
    try {
      const analysis = await aiAssist('tone', text);
      const entry: Analysis = { id: Date.now(), text, analysis };
      setResult(entry);
      setHistory(prev => [entry, ...prev].slice(0, 20));
    } catch (e: any) {
      const offline = e?.status === 503 || /unavailable/i.test(e?.message || '');
      setError(offline ? 'The tone analyzer is offline right now. Please try again later.' : (e?.message ?? 'Could not analyze.'));
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Tone Detector', headerStyle: { backgroundColor: '#FFFFFF' }, headerTintColor: '#1F2937' }} />
      <ScrollView style={s.container}>
        <StatusBar barStyle="light-content" />

        <View style={s.infoCard}>
          <Text style={{ fontSize: 28 }}>🧠</Text>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={s.infoTitle}>Tone Analyzer</Text>
            <Text style={s.infoDesc}>Check how your message might be perceived before sending. Analyzed by VaultChat’s on-prem model.</Text>
          </View>
        </View>

        <View style={s.inputBox}>
          <TextInput style={s.input} value={input} onChangeText={setInput}
            placeholder="Type a message to analyze..." placeholderTextColor="#6B7280"
            multiline maxLength={500} />
          <TouchableOpacity style={[s.analyzeBtn, (!input.trim() || analyzing) && { opacity: 0.4 }]} onPress={analyze} disabled={!input.trim() || analyzing}>
            {analyzing
              ? <ActivityIndicator color="#fff" />
              : <Text style={s.analyzeTxt}>🔍  Analyze Tone</Text>}
          </TouchableOpacity>
        </View>

        {error && (
          <View style={[s.resultCard, { borderColor: '#FF3C6E44' }]}>
            <Text style={{ color: '#FF3C6E', fontSize: 13, lineHeight: 19 }}>{error}</Text>
          </View>
        )}

        {result && !error && (
          <View style={[s.resultCard, { borderColor: C.purple + '44' }]}>
            <View style={s.resultHeader}>
              <Text style={{ fontSize: 32 }}>🎭</Text>
              <Text style={s.resultTone}>Tone analysis</Text>
            </View>
            <Text style={s.analysisText}>{result.analysis}</Text>
            <View style={s.originalBox}>
              <Text style={s.originalLabel}>Analyzed message:</Text>
              <Text style={s.originalText}>&quot;{result.text}&quot;</Text>
            </View>
          </View>
        )}

        {history.length > 1 && (
          <>
            <Text style={[s.sectionTitle, { marginTop: 20 }]}>RECENT ANALYSES</Text>
            {history.slice(1).map(h => (
              <View key={h.id} style={s.historyRow}>
                <Text style={s.historyText} numberOfLines={1}>{h.text}</Text>
                <Text style={s.historyAnalysis} numberOfLines={2}>{h.analysis}</Text>
              </View>
            ))}
          </>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, padding: 16 },
  infoCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 14, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: C.border },
  infoTitle: { color: '#1F2937', fontSize: 16, fontWeight: '800' },
  infoDesc: { color: '#6B7280', fontSize: 12, marginTop: 2, lineHeight: 18 },
  inputBox: { backgroundColor: C.card, borderRadius: 14, padding: 4, borderWidth: 1, borderColor: C.border, marginBottom: 16 },
  input: { color: '#1F2937', fontSize: 15, minHeight: 80, padding: 12, textAlignVertical: 'top' },
  analyzeBtn: { backgroundColor: C.purple, borderRadius: 10, paddingVertical: 12, alignItems: 'center', margin: 8 },
  analyzeTxt: { color: '#fff', fontSize: 14, fontWeight: '800' },
  resultCard: { backgroundColor: C.card, borderRadius: 16, padding: 16, borderWidth: 1, marginBottom: 16 },
  resultHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 10 },
  resultTone: { fontSize: 18, fontWeight: '900', color: '#1F2937' },
  analysisText: { color: '#1F2937', fontSize: 15, lineHeight: 22, marginBottom: 14 },
  originalBox: { backgroundColor: '#EEF1F4', borderRadius: 10, padding: 12 },
  originalLabel: { color: '#6B7280', fontSize: 10, marginBottom: 4 },
  originalText: { color: '#6B7280', fontSize: 12, fontStyle: 'italic' },
  sectionTitle: { color: '#6B7280', fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 8 },
  historyRow: { backgroundColor: C.card, borderRadius: 10, padding: 12, marginBottom: 6, borderWidth: 1, borderColor: C.border },
  historyText: { color: '#1F2937', fontSize: 13, fontWeight: '600' },
  historyAnalysis: { color: '#6B7280', fontSize: 12, marginTop: 4, lineHeight: 17 },
});
