// @ts-nocheck
// app/tone-detector.tsx — AI Message Tone Analyzer
// Analyzes emotional tone of messages before sending
// Detects: Friendly, Professional, Aggressive, Sarcastic, Sad, Neutral
// Helps users communicate better

import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, TextInput,
  StatusBar, ScrollView, Animated,
} from 'react-native';
import { Stack } from 'expo-router';

const C = { bg: '#020B18', accent: '#4A9FFF', green: '#10B981', card: '#0A1628', purple: '#A78BFA' };

const TONES = {
  friendly: { label: 'Friendly', emoji: '\uD83D\uDE0A', color: '#10B981', desc: 'Warm, approachable, positive' },
  professional: { label: 'Professional', emoji: '\uD83D\uDC54', color: '#4A9FFF', desc: 'Formal, clear, business-like' },
  aggressive: { label: 'Aggressive', emoji: '\uD83D\uDE20', color: '#FF3C6E', desc: 'Harsh, confrontational, angry' },
  sarcastic: { label: 'Sarcastic', emoji: '\uD83D\uDE0F', color: '#F59E0B', desc: 'Ironic, mocking, passive-aggressive' },
  sad: { label: 'Sad', emoji: '\uD83D\uDE22', color: '#8B8BCC', desc: 'Melancholy, disappointed, hurt' },
  neutral: { label: 'Neutral', emoji: '\uD83D\uDE10', color: '#888', desc: 'Factual, objective, no emotion' },
  excited: { label: 'Excited', emoji: '\uD83E\uDD29', color: '#A78BFA', desc: 'Enthusiastic, energetic, thrilled' },
  anxious: { label: 'Anxious', emoji: '\uD83D\uDE1F', color: '#F59E0B', desc: 'Worried, nervous, uncertain' },
};

// Simple keyword-based tone analysis
const analyzeTone = (text) => {
  const lower = text.toLowerCase();
  const scores = {};

  // Friendly indicators
  scores.friendly = 0;
  if (lower.match(/\b(thanks|thank you|appreciate|love|great|awesome|wonderful|amazing|happy|glad|please|kind)\b/g)) scores.friendly += 3;
  if (lower.match(/[!]{1}$/)) scores.friendly += 1;
  if (lower.match(/\b(hey|hi|hello)\b/)) scores.friendly += 1;

  // Professional
  scores.professional = 0;
  if (lower.match(/\b(regarding|please|kindly|attached|meeting|schedule|deadline|confirm|update|report|discuss)\b/g)) scores.professional += 3;
  if (!lower.match(/[!]{2,}/)) scores.professional += 1;

  // Aggressive
  scores.aggressive = 0;
  if (lower.match(/\b(hate|stupid|idiot|shut up|worst|terrible|angry|furious|never|always wrong)\b/g)) scores.aggressive += 4;
  if (lower.match(/[!]{2,}/)) scores.aggressive += 2;
  if (lower === lower.toUpperCase() && text.length > 5) scores.aggressive += 3;

  // Sarcastic
  scores.sarcastic = 0;
  if (lower.match(/\b(sure|right|obviously|totally|yeah right|whatever|great job|brilliant)\b/g)) scores.sarcastic += 2;
  if (lower.match(/\.\.\./)) scores.sarcastic += 1;

  // Sad
  scores.sad = 0;
  if (lower.match(/\b(sad|sorry|miss|alone|hurt|cry|depressed|disappointed|lost|wish|regret)\b/g)) scores.sad += 3;

  // Excited
  scores.excited = 0;
  if (lower.match(/\b(omg|wow|amazing|incredible|yes|can't wait|so excited|awesome|finally)\b/g)) scores.excited += 3;
  if (lower.match(/[!]{2,}/)) scores.excited += 2;

  // Anxious
  scores.anxious = 0;
  if (lower.match(/\b(worried|nervous|scared|afraid|what if|hope|maybe|uncertain|not sure|anxious)\b/g)) scores.anxious += 3;
  if (lower.match(/\?{2,}/)) scores.anxious += 1;

  // Neutral — default if nothing strong
  scores.neutral = 1;

  // Find top tone
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const top = sorted[0];
  const total = Object.values(scores).reduce((a, b) => a + b, 0) || 1;

  return {
    primary: top[0],
    confidence: Math.min(Math.round((top[1] / total) * 100), 95),
    all: sorted.filter(([_, v]) => v > 0).slice(0, 3).map(([k, v]) => ({
      tone: k,
      score: Math.round((v / total) * 100),
    })),
  };
};

// Suggestions based on tone
const getSuggestion = (tone) => {
  const suggestions = {
    aggressive: 'This message might come across as harsh. Consider softening your language or adding context.',
    sarcastic: 'This might be read as sarcastic. If you mean it positively, consider being more direct.',
    sad: 'This message has a somber tone. If you are going through something, consider reaching out to someone you trust.',
    anxious: 'Your message sounds worried. Take a breath — if this is important, a call might be better than text.',
    friendly: 'Great tone! This message is warm and positive.',
    professional: 'Clean and professional. Good for work conversations.',
    excited: 'Your enthusiasm shines through! Great energy.',
    neutral: 'Straightforward and clear. No strong emotional signals.',
  };
  return suggestions[tone] || '';
};

export default function ToneDetectorScreen() {
  const [input, setInput] = useState('');
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);

  const analyze = () => {
    if (!input.trim()) return;
    const analysis = analyzeTone(input);
    setResult({ text: input, ...analysis });
    setHistory(prev => [{ text: input, ...analysis, id: Date.now() }, ...prev].slice(0, 20));
  };

  const tone = result ? TONES[result.primary] : null;

  return (
    <>
      <Stack.Screen options={{ title: 'Tone Detector', headerStyle: { backgroundColor: '#0C0C1A' }, headerTintColor: '#fff' }} />
      <ScrollView style={s.container}>
        <StatusBar barStyle="light-content" />

        <View style={s.infoCard}>
          <Text style={{ fontSize: 28 }}>{"\uD83E\uDDE0"}</Text>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={s.infoTitle}>AI Tone Analyzer</Text>
            <Text style={s.infoDesc}>Check how your message might be perceived before sending. Helps avoid misunderstandings.</Text>
          </View>
        </View>

        <View style={s.inputBox}>
          <TextInput style={s.input} value={input} onChangeText={setInput}
            placeholder="Type a message to analyze..." placeholderTextColor="#555"
            multiline maxLength={500} />
          <TouchableOpacity style={[s.analyzeBtn, !input.trim() && { opacity: 0.4 }]} onPress={analyze} disabled={!input.trim()}>
            <Text style={s.analyzeTxt}>{"\uD83D\uDD0D  Analyze Tone"}</Text>
          </TouchableOpacity>
        </View>

        {result && tone && (
          <View style={[s.resultCard, { borderColor: tone.color + '44' }]}>
            <View style={s.resultHeader}>
              <Text style={{ fontSize: 40 }}>{tone.emoji}</Text>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={[s.resultTone, { color: tone.color }]}>{tone.label}</Text>
                <Text style={s.resultConfidence}>{result.confidence}% confidence</Text>
              </View>
            </View>

            {/* Breakdown */}
            <View style={s.breakdown}>
              {result.all.map((t, i) => {
                const td = TONES[t.tone];
                return (
                  <View key={i} style={s.breakdownRow}>
                    <Text style={{ fontSize: 16 }}>{td?.emoji || '?'}</Text>
                    <Text style={[s.breakdownLabel, { color: td?.color || '#888' }]}>{td?.label || t.tone}</Text>
                    <View style={s.breakdownBarBg}>
                      <View style={[s.breakdownBarFill, { width: t.score + '%', backgroundColor: td?.color || '#888' }]} />
                    </View>
                    <Text style={s.breakdownPct}>{t.score}%</Text>
                  </View>
                );
              })}
            </View>

            {/* Suggestion */}
            <View style={s.suggestion}>
              <Text style={s.suggestionTitle}>{"\uD83D\uDCA1"} Suggestion</Text>
              <Text style={s.suggestionText}>{getSuggestion(result.primary)}</Text>
            </View>

            {/* Original text */}
            <View style={s.originalBox}>
              <Text style={s.originalLabel}>Analyzed message:</Text>
              <Text style={s.originalText}>"{result.text}"</Text>
            </View>
          </View>
        )}

        {history.length > 1 && (
          <>
            <Text style={[s.sectionTitle, { marginTop: 20 }]}>RECENT ANALYSES</Text>
            {history.slice(1).map(h => {
              const ht = TONES[h.primary];
              return (
                <View key={h.id} style={s.historyRow}>
                  <Text style={{ fontSize: 16 }}>{ht?.emoji}</Text>
                  <Text style={[s.historyTone, { color: ht?.color }]}>{ht?.label}</Text>
                  <Text style={s.historyText} numberOfLines={1}>{h.text}</Text>
                  <Text style={s.historyPct}>{h.confidence}%</Text>
                </View>
              );
            })}
          </>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, padding: 16 },
  infoCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 14, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#111' },
  infoTitle: { color: '#fff', fontSize: 16, fontWeight: '800' },
  infoDesc: { color: '#666', fontSize: 12, marginTop: 2, lineHeight: 18 },
  inputBox: { backgroundColor: C.card, borderRadius: 14, padding: 4, borderWidth: 1, borderColor: '#111', marginBottom: 16 },
  input: { color: '#fff', fontSize: 15, minHeight: 80, padding: 12, textAlignVertical: 'top' },
  analyzeBtn: { backgroundColor: C.purple, borderRadius: 10, paddingVertical: 12, alignItems: 'center', margin: 8 },
  analyzeTxt: { color: '#fff', fontSize: 14, fontWeight: '800' },
  resultCard: { backgroundColor: C.card, borderRadius: 16, padding: 16, borderWidth: 1 },
  resultHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  resultTone: { fontSize: 22, fontWeight: '900' },
  resultConfidence: { color: '#888', fontSize: 12, marginTop: 2 },
  breakdown: { marginBottom: 16 },
  breakdownRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 8 },
  breakdownLabel: { fontSize: 12, fontWeight: '700', width: 80 },
  breakdownBarBg: { flex: 1, height: 6, backgroundColor: '#111', borderRadius: 3, overflow: 'hidden' },
  breakdownBarFill: { height: '100%', borderRadius: 3 },
  breakdownPct: { color: '#666', fontSize: 11, width: 30, textAlign: 'right' },
  suggestion: { backgroundColor: '#111', borderRadius: 10, padding: 12, marginBottom: 12 },
  suggestionTitle: { color: '#F59E0B', fontSize: 12, fontWeight: '800', marginBottom: 4 },
  suggestionText: { color: '#ccc', fontSize: 12, lineHeight: 18 },
  originalBox: { backgroundColor: '#111', borderRadius: 10, padding: 12 },
  originalLabel: { color: '#555', fontSize: 10, marginBottom: 4 },
  originalText: { color: '#888', fontSize: 12, fontStyle: 'italic' },
  sectionTitle: { color: '#555', fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 8 },
  historyRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 10, padding: 10, marginBottom: 4, gap: 8, borderWidth: 1, borderColor: '#111' },
  historyTone: { fontSize: 11, fontWeight: '700', width: 70 },
  historyText: { flex: 1, color: '#666', fontSize: 11 },
  historyPct: { color: '#555', fontSize: 10 },
});
