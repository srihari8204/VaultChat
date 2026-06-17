// app/chat-summary.tsx — Chat Summary.
//
// Reads the real message history (GET /chats/:id/messages), computes real stats
// (counts, media, questions, timespan), and produces a genuine natural-language
// summary by sending the transcript to VaultChat's own on-prem LLM
// (/ai/assist → Ollama). The transcript leaves the device only to the VaultChat
// backend, and only when the user taps a range.

import React, { useState, useCallback , useMemo} from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, StatusBar, ScrollView, ActivityIndicator, Alert,
} from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { getMessages, type Message } from '../lib/chatService';
import { getCurrentUserAsync } from './(constants)/authService';
import { aiAssist } from '../lib/ai';

interface SumMsg { isMine: boolean; text: string; type: Message['type']; createdAt: string }
interface Summary {
  total: number; myMsgs: number; peerMsgs: number; mediaCount: number; questionCount: number;
  sentiment: string; timespan: string; aiSummary: string;
}

function formatTimespan(firstIso?: string, lastIso?: string): string {
  try {
    const start = new Date(firstIso || Date.now()).getTime();
    const end = new Date(lastIso || Date.now()).getTime();
    const diff = Math.abs(end - start);
    if (diff < 3600000) return `${Math.round(diff / 60000)} minutes`;
    if (diff < 86400000) return `${Math.round(diff / 3600000)} hours`;
    return `${Math.round(diff / 86400000)} days`;
  } catch { return 'Unknown'; }
}

function computeStats(msgs: SumMsg[], peerName: string): Omit<Summary, 'aiSummary'> {
  const total = msgs.length;
  const myMsgs = msgs.filter(m => m.isMine).length;
  const mediaCount = msgs.filter(m => ['image', 'video', 'audio', 'file'].includes(m.type)).length;
  const questionCount = msgs.filter(m => m.text.includes('?')).length;
  return {
    total, myMsgs, peerMsgs: total - myMsgs, mediaCount, questionCount,
    sentiment: myMsgs > total - myMsgs ? 'You sent more messages' : `${peerName || 'Peer'} sent more`,
    timespan: total > 0 ? formatTimespan(msgs[0].createdAt, msgs[total - 1].createdAt) : 'Unknown',
  };
}

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function ChatSummaryScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const { chatId, peerName } = useLocalSearchParams<{ chatId: string; peerName: string }>();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);
  const [aiError, setAiError] = useState(false);

  const run = useCallback(async (limit: number) => {
    if (!chatId) return;
    setLoading(true);
    setAiError(false);
    try {
      const [me, page] = await Promise.all([getCurrentUserAsync(), getMessages(chatId, { limit })]);
      const myId = me?.id ?? '';
      // getMessages is newest-first; reverse to chronological, drop deleted.
      const msgs: SumMsg[] = page
        .filter(m => !m.deletedAt)
        .map(m => ({ isMine: m.senderId === myId, text: m.type === 'text' ? (m.content || '') : '', type: m.type, createdAt: m.createdAt }))
        .reverse();
      const stats = computeStats(msgs, (peerName as string) || '');

      // Real LLM summary over the transcript (text messages only).
      const transcript = msgs
        .filter(m => m.text)
        .map(m => `${m.isMine ? 'Me' : ((peerName as string) || 'Them')}: ${m.text}`)
        .join('\n')
        .slice(0, 4000);
      let aiSummary = '';
      if (transcript.trim()) {
        try { aiSummary = await aiAssist('summarize', transcript); }
        catch { setAiError(true); }
      }
      setSummary({ ...stats, aiSummary });
    } catch { Alert.alert('Error', 'Could not load messages'); }
    finally { setLoading(false); }
  }, [chatId, peerName]);

  return (
    <View style={s.root}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="light-content" />
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.title}>Chat Summary</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView style={s.container} contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={s.headerCard}>
          <Text style={{ fontSize: 30 }}>🧠</Text>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={s.headerTitle}>AI Summary</Text>
            <Text style={s.headerDesc}>Catch up on {(peerName as string) || 'this chat'} — summarized by VaultChat's on-prem model.</Text>
          </View>
        </View>

        {!summary && !loading && (
          <View style={s.optionsCard}>
            <Text style={s.optionsTitle}>How many messages to summarize?</Text>
            {[50, 100, 200, 500].map(c => (
              <TouchableOpacity key={c} style={s.optionBtn} onPress={() => run(c)}>
                <Text style={s.optionTxt}>Last {c} messages</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {loading && (
          <View style={s.loadingCard}>
            <ActivityIndicator color={colors.purple} size="large" />
            <Text style={s.loadingTxt}>Analyzing messages…</Text>
          </View>
        )}

        {summary && (
          <>
            <View style={s.statsRow}>
              <View style={s.statCard}><Text style={s.statNum}>{summary.total}</Text><Text style={s.statLabel}>Messages</Text></View>
              <View style={s.statCard}><Text style={s.statNum}>{summary.mediaCount}</Text><Text style={s.statLabel}>Media</Text></View>
              <View style={s.statCard}><Text style={s.statNum}>{summary.questionCount}</Text><Text style={s.statLabel}>Questions</Text></View>
            </View>
            <Text style={s.metaTxt}>Timespan: {summary.timespan} · {summary.sentiment}</Text>

            <Text style={s.sectionTitle}>🧠 SUMMARY</Text>
            {summary.aiSummary ? (
              <View style={s.keyMsgRow}>
                <Text style={s.summaryTxt}>{summary.aiSummary}</Text>
              </View>
            ) : (
              <View style={s.keyMsgRow}>
                <Text style={s.keyMsgTxt}>
                  {aiError
                    ? 'The AI summary service is offline right now — the stats above are still accurate. Try again later.'
                    : 'No text messages in this range to summarize.'}
                </Text>
              </View>
            )}

            <TouchableOpacity style={s.regenBtn} onPress={() => setSummary(null)}>
              <Text style={s.regenTxt}>🔄  Summarize a different range</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 54, paddingHorizontal: 16, paddingBottom: 8 },
  backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  title: { color: c.text, fontSize: 18, fontWeight: '800' },
  container: { flex: 1, padding: 16 },
  headerCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.card, borderRadius: 16, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: c.border },
  headerTitle: { color: c.text, fontSize: 18, fontWeight: '900' },
  headerDesc: { color: c.textDim, fontSize: 12, marginTop: 2 },
  optionsCard: { backgroundColor: c.card, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: c.border },
  optionsTitle: { color: c.text, fontSize: 15, fontWeight: '700', marginBottom: 12 },
  optionBtn: { backgroundColor: 'rgba(6,182,212,0.13)', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginBottom: 8, borderWidth: 1, borderColor: 'rgba(6,182,212,0.3)' },
  optionTxt: { color: c.accent, fontSize: 14, fontWeight: '700' },
  loadingCard: { alignItems: 'center', padding: 40 },
  loadingTxt: { color: c.textDim, marginTop: 12, fontSize: 14 },
  statsRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  statCard: { flex: 1, backgroundColor: c.card, borderRadius: 12, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: c.border },
  statNum: { color: c.accent, fontSize: 22, fontWeight: '900' },
  statLabel: { color: c.textDim, fontSize: 10, marginTop: 2 },
  metaTxt: { color: c.textDim, fontSize: 11, textAlign: 'center', paddingVertical: 8 },
  sectionTitle: { color: c.textDim, fontSize: 12, fontWeight: '800', marginBottom: 8 },
  topicRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  topicBadge: { backgroundColor: 'rgba(139,92,246,0.15)', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: 'rgba(139,92,246,0.3)' },
  topicTxt: { color: c.purple, fontSize: 12, fontWeight: '600' },
  actionRow: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: c.card, borderRadius: 10, padding: 12, marginBottom: 4, gap: 10, borderWidth: 1, borderColor: c.border },
  actionNum: { color: c.primary, fontSize: 14, fontWeight: '900', width: 20 },
  actionTxt: { color: c.text, fontSize: 13, flex: 1, lineHeight: 19 },
  keyMsgRow: { backgroundColor: c.card, borderRadius: 10, padding: 12, marginBottom: 4, borderWidth: 1, borderColor: c.border },
  keyMsgTxt: { color: c.textDim, fontSize: 13, fontStyle: 'italic', lineHeight: 19 },
  summaryTxt: { color: c.text, fontSize: 14, lineHeight: 21 },
  regenBtn: { marginTop: 20, backgroundColor: 'rgba(6,182,212,0.1)', borderRadius: 12, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(6,182,212,0.3)' },
  regenTxt: { color: c.accent, fontSize: 13, fontWeight: '700' },
});
