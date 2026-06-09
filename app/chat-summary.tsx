// app/chat-summary.tsx — Chat Summary (real on-device, no Firebase).
//
// A heuristic/extractive summary computed locally from the real message
// history (GET /chats/:id/messages): message stats, keyword topics, extracted
// action items, and key (longer, recent) messages. No LLM, no cloud — runs
// entirely on-device.

import React, { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, StatusBar, ScrollView, ActivityIndicator, Alert,
} from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Aurora } from '../constants/theme';
import { getMessages, type Message } from '../lib/chatService';
import { getCurrentUserAsync } from './(constants)/authService';

interface SumMsg { isMine: boolean; text: string; type: Message['type']; createdAt: string }
interface Summary {
  total: number; myMsgs: number; peerMsgs: number; mediaCount: number; questionCount: number;
  topics: string[]; actions: string[]; keyMessages: string[]; sentiment: string; timespan: string;
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

function generateSummary(msgs: SumMsg[], peerName: string): Summary {
  const total = msgs.length;
  const myMsgs = msgs.filter(m => m.isMine).length;
  const mediaCount = msgs.filter(m => ['image', 'video', 'audio', 'file'].includes(m.type)).length;
  const questionCount = msgs.filter(m => m.text.includes('?')).length;

  const keyMessages = msgs.filter(m => m.text.length > 30).slice(-5).map(m => m.text);

  const allText = msgs.map(m => m.text.toLowerCase()).join(' ');
  const topics: string[] = [];
  if (/meet|call|schedule|tomorrow|today|monday|tuesday|wednesday|thursday|friday/.test(allText)) topics.push('Scheduling & Meetings');
  if (/work|project|task|deadline|deliver|report|update/.test(allText)) topics.push('Work & Projects');
  if (/eat|food|lunch|dinner|coffee|restaurant/.test(allText)) topics.push('Food & Plans');
  if (/movie|game|play|watch|listen|music|song/.test(allText)) topics.push('Entertainment');
  if (/buy|price|money|pay|cost|order|shop/.test(allText)) topics.push('Shopping & Finance');
  if (/love|miss|feel|happy|sad|sorry|thank/.test(allText)) topics.push('Personal & Emotions');
  if (topics.length === 0) topics.push('General Conversation');

  const actions: string[] = [];
  for (const m of msgs) {
    if (/remind me|don't forget|make sure|need to|have to|should|will do|i'll/i.test(m.text)) {
      actions.push(m.text.slice(0, 80));
    }
  }

  return {
    total, myMsgs, peerMsgs: total - myMsgs, mediaCount, questionCount,
    topics, actions: actions.slice(0, 5), keyMessages,
    sentiment: myMsgs > total - myMsgs ? 'You sent more messages' : `${peerName || 'Peer'} sent more`,
    timespan: total > 0 ? formatTimespan(msgs[0].createdAt, msgs[total - 1].createdAt) : 'Unknown',
  };
}

export default function ChatSummaryScreen() {
  const router = useRouter();
  const { chatId, peerName } = useLocalSearchParams<{ chatId: string; peerName: string }>();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);

  const run = useCallback(async (limit: number) => {
    if (!chatId) return;
    setLoading(true);
    try {
      const [me, page] = await Promise.all([getCurrentUserAsync(), getMessages(chatId, { limit })]);
      const myId = me?.id ?? '';
      // getMessages is newest-first; reverse to chronological, drop deleted.
      const msgs: SumMsg[] = page
        .filter(m => !m.deletedAt)
        .map(m => ({ isMine: m.senderId === myId, text: m.type === 'text' ? (m.content || '') : '', type: m.type, createdAt: m.createdAt }))
        .reverse();
      setSummary(generateSummary(msgs, (peerName as string) || ''));
    } catch { Alert.alert('Error', 'Could not load messages'); }
    finally { setLoading(false); }
  }, [chatId, peerName]);

  return (
    <View style={s.root}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="light-content" />
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={Aurora.text} />
        </TouchableOpacity>
        <Text style={s.title}>Chat Summary</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView style={s.container} contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={s.headerCard}>
          <Text style={{ fontSize: 30 }}>🧠</Text>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={s.headerTitle}>On-device Summary</Text>
            <Text style={s.headerDesc}>Catch up on {(peerName as string) || 'this chat'} — computed locally.</Text>
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
            <ActivityIndicator color={Aurora.purple} size="large" />
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

            <Text style={s.sectionTitle}>🎯 TOPICS DISCUSSED</Text>
            <View style={s.topicRow}>
              {summary.topics.map((t, i) => <View key={i} style={s.topicBadge}><Text style={s.topicTxt}>{t}</Text></View>)}
            </View>

            {summary.actions.length > 0 && (
              <>
                <Text style={[s.sectionTitle, { marginTop: 16 }]}>✅ ACTION ITEMS</Text>
                {summary.actions.map((a, i) => (
                  <View key={i} style={s.actionRow}>
                    <Text style={s.actionNum}>{i + 1}</Text>
                    <Text style={s.actionTxt}>{a}</Text>
                  </View>
                ))}
              </>
            )}

            {summary.keyMessages.length > 0 && (
              <>
                <Text style={[s.sectionTitle, { marginTop: 16 }]}>💬 KEY MESSAGES</Text>
                {summary.keyMessages.map((m, i) => (
                  <View key={i} style={s.keyMsgRow}><Text style={s.keyMsgTxt}>&quot;{m}&quot;</Text></View>
                ))}
              </>
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

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Aurora.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 54, paddingHorizontal: 16, paddingBottom: 8 },
  backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  title: { color: Aurora.text, fontSize: 18, fontWeight: '800' },
  container: { flex: 1, padding: 16 },
  headerCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: Aurora.card, borderRadius: 16, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: Aurora.border },
  headerTitle: { color: Aurora.text, fontSize: 18, fontWeight: '900' },
  headerDesc: { color: Aurora.textDim, fontSize: 12, marginTop: 2 },
  optionsCard: { backgroundColor: Aurora.card, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: Aurora.border },
  optionsTitle: { color: Aurora.text, fontSize: 15, fontWeight: '700', marginBottom: 12 },
  optionBtn: { backgroundColor: 'rgba(6,182,212,0.13)', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginBottom: 8, borderWidth: 1, borderColor: 'rgba(6,182,212,0.3)' },
  optionTxt: { color: Aurora.accent, fontSize: 14, fontWeight: '700' },
  loadingCard: { alignItems: 'center', padding: 40 },
  loadingTxt: { color: Aurora.textDim, marginTop: 12, fontSize: 14 },
  statsRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  statCard: { flex: 1, backgroundColor: Aurora.card, borderRadius: 12, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: Aurora.border },
  statNum: { color: Aurora.accent, fontSize: 22, fontWeight: '900' },
  statLabel: { color: Aurora.textDim, fontSize: 10, marginTop: 2 },
  metaTxt: { color: Aurora.textDim, fontSize: 11, textAlign: 'center', paddingVertical: 8 },
  sectionTitle: { color: Aurora.textDim, fontSize: 12, fontWeight: '800', marginBottom: 8 },
  topicRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  topicBadge: { backgroundColor: 'rgba(139,92,246,0.15)', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: 'rgba(139,92,246,0.3)' },
  topicTxt: { color: Aurora.purple, fontSize: 12, fontWeight: '600' },
  actionRow: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: Aurora.card, borderRadius: 10, padding: 12, marginBottom: 4, gap: 10, borderWidth: 1, borderColor: Aurora.border },
  actionNum: { color: Aurora.primary, fontSize: 14, fontWeight: '900', width: 20 },
  actionTxt: { color: Aurora.text, fontSize: 13, flex: 1, lineHeight: 19 },
  keyMsgRow: { backgroundColor: Aurora.card, borderRadius: 10, padding: 12, marginBottom: 4, borderWidth: 1, borderColor: Aurora.border },
  keyMsgTxt: { color: Aurora.textDim, fontSize: 13, fontStyle: 'italic', lineHeight: 19 },
  regenBtn: { marginTop: 20, backgroundColor: 'rgba(6,182,212,0.1)', borderRadius: 12, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(6,182,212,0.3)' },
  regenTxt: { color: Aurora.accent, fontSize: 13, fontWeight: '700' },
});
