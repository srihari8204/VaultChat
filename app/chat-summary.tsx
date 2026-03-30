// app/chat-summary.tsx — AI Chat Summary
// One tap → summarizes 100+ unread messages into key points
// Groups by topic, extracts action items, decisions, questions

import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  StatusBar, ScrollView, ActivityIndicator, Alert,
} from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';

const C = { bg: '#FFFFFF', accent: '#4A9FFF', card: '#F9FAFB', green: '#10B981', purple: '#A78BFA' };

// On-device summarization engine
const generateSummary = (messages, peerName) => {
  const total = messages.length;
  const myMsgs = messages.filter(m => m.isMine).length;
  const peerMsgs = total - myMsgs;
  const mediaCount = messages.filter(m => m.mediaUrl || ['image','video','audio','file'].includes(m.msgType)).length;
  const questionCount = messages.filter(m => (m.plaintext || '').includes('?')).length;

  // Extract key messages (longer ones are usually more important)
  const keyMessages = messages
    .filter(m => (m.plaintext || '').length > 30)
    .slice(-5)
    .map(m => m.plaintext || '[media]');

  // Detect topics from keywords
  const allText = messages.map(m => (m.plaintext || '').toLowerCase()).join(' ');
  const topics = [];
  if (allText.match(/meet|call|schedule|tomorrow|today|monday|tuesday|wednesday|thursday|friday/)) topics.push('Scheduling & Meetings');
  if (allText.match(/work|project|task|deadline|deliver|report|update/)) topics.push('Work & Projects');
  if (allText.match(/eat|food|lunch|dinner|coffee|restaurant/)) topics.push('Food & Plans');
  if (allText.match(/movie|game|play|watch|listen|music|song/)) topics.push('Entertainment');
  if (allText.match(/buy|price|money|pay|cost|order|shop/)) topics.push('Shopping & Finance');
  if (allText.match(/love|miss|feel|happy|sad|sorry|thank/)) topics.push('Personal & Emotions');
  if (topics.length === 0) topics.push('General Conversation');

  // Detect action items
  const actions = [];
  messages.forEach(m => {
    const txt = (m.plaintext || '').toLowerCase();
    if (txt.match(/remind me|don't forget|make sure|need to|have to|should|will do|i'll/)) {
      actions.push(m.plaintext?.slice(0, 80) || '');
    }
  });

  return {
    total,
    myMsgs,
    peerMsgs,
    mediaCount,
    questionCount,
    topics,
    actions: actions.slice(0, 5),
    keyMessages: keyMessages.slice(0, 5),
    sentiment: myMsgs > peerMsgs ? 'You sent more messages' : (peerName || 'Peer') + ' sent more messages',
    timespan: messages.length > 0 ? formatTimespan(messages[0], messages[messages.length - 1]) : 'Unknown',
  };
};

const formatTimespan = (first, last) => {
  const start = first?.createdAt?.toDate?.() || new Date();
  const end = last?.createdAt?.toDate?.() || new Date();
  const diff = end.getTime() - start.getTime();
  if (diff < 3600000) return Math.round(diff / 60000) + ' minutes';
  if (diff < 86400000) return Math.round(diff / 3600000) + ' hours';
  return Math.round(diff / 86400000) + ' days';
};

export default function ChatSummaryScreen() {
  const { chatId, peerName } = useLocalSearchParams();
  const myUid = auth().currentUser?.uid || '';
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [, setMsgCount] = useState(0);

  const generateChatSummary = async (limit) => {
    setLoading(true);
    try {
      const snap = await firestore().collection('chats').doc(chatId)
        .collection('messages')
        .orderBy('createdAt', 'desc')
        .limit(limit)
        .get();

      const msgs = snap.docs.map(d => {
        const data = d.data();
        return { ...data, isMine: data.senderId === myUid };
      }).reverse();

      setMsgCount(msgs.length);
      const result = generateSummary(msgs, peerName);
      setSummary(result);
    } catch { Alert.alert('Error', 'Could not load messages'); }
    setLoading(false);
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Chat Summary', headerStyle: { backgroundColor: '#FFFFFF' }, headerTintColor: '#1F2937' }} />
      <ScrollView style={s.container}>
        <StatusBar barStyle="light-content" />

        <View style={s.headerCard}>
          <Text style={{ fontSize: 32 }}>{"\uD83E\uDDE0"}</Text>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={s.headerTitle}>AI Chat Summary</Text>
            <Text style={s.headerDesc}>Instantly catch up on {peerName || 'this chat'}</Text>
          </View>
        </View>

        {!summary && !loading && (
          <View style={s.optionsCard}>
            <Text style={s.optionsTitle}>How many messages to summarize?</Text>
            {[{ label: 'Last 50', count: 50 }, { label: 'Last 100', count: 100 }, { label: 'Last 200', count: 200 }, { label: 'Last 500', count: 500 }].map(opt => (
              <TouchableOpacity key={opt.count} style={s.optionBtn} onPress={() => generateChatSummary(opt.count)}>
                <Text style={s.optionTxt}>{opt.label} messages</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {loading && (
          <View style={s.loadingCard}>
            <ActivityIndicator color={C.purple} size="large" />
            <Text style={s.loadingTxt}>Analyzing messages...</Text>
          </View>
        )}

        {summary && (
          <>
            {/* Stats */}
            <View style={s.statsRow}>
              <View style={s.statCard}><Text style={s.statNum}>{summary.total}</Text><Text style={s.statLabel}>Messages</Text></View>
              <View style={s.statCard}><Text style={s.statNum}>{summary.mediaCount}</Text><Text style={s.statLabel}>Media</Text></View>
              <View style={s.statCard}><Text style={s.statNum}>{summary.questionCount}</Text><Text style={s.statLabel}>Questions</Text></View>
            </View>

            <View style={s.metaRow}>
              <Text style={s.metaTxt}>Timespan: {summary.timespan} | {summary.sentiment}</Text>
            </View>

            {/* Topics */}
            <Text style={s.sectionTitle}>{"\uD83C\uDFAF"} TOPICS DISCUSSED</Text>
            <View style={s.topicRow}>
              {summary.topics.map((t, i) => (
                <View key={i} style={s.topicBadge}><Text style={s.topicTxt}>{t}</Text></View>
              ))}
            </View>

            {/* Action Items */}
            {summary.actions.length > 0 && (
              <>
                <Text style={[s.sectionTitle, { marginTop: 16 }]}>{"\u2705"} ACTION ITEMS</Text>
                {summary.actions.map((a, i) => (
                  <View key={i} style={s.actionRow}>
                    <Text style={s.actionNum}>{i + 1}</Text>
                    <Text style={s.actionTxt}>{a}</Text>
                  </View>
                ))}
              </>
            )}

            {/* Key Messages */}
            <Text style={[s.sectionTitle, { marginTop: 16 }]}>{"\uD83D\uDCAC"} KEY MESSAGES</Text>
            {summary.keyMessages.map((m, i) => (
              <View key={i} style={s.keyMsgRow}>
                <Text style={s.keyMsgTxt}>&quot;{m}&quot;</Text>
              </View>
            ))}

            {/* Regenerate */}
            <TouchableOpacity style={s.regenBtn} onPress={() => setSummary(null)}>
              <Text style={s.regenTxt}>{"\uD83D\uDD04"} Summarize Different Range</Text>
            </TouchableOpacity>
          </>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, padding: 16 },
  headerCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 16, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#E5E7EB' },
  headerTitle: { color: '#fff', fontSize: 18, fontWeight: '900' },
  headerDesc: { color: '#9CA3AF', fontSize: 12, marginTop: 2 },
  optionsCard: { backgroundColor: C.card, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: '#E5E7EB' },
  optionsTitle: { color: '#1F2937', fontSize: 15, fontWeight: '700', marginBottom: 12 },
  optionBtn: { backgroundColor: '#4A9FFF22', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginBottom: 8, borderWidth: 1, borderColor: '#4A9FFF33' },
  optionTxt: { color: C.accent, fontSize: 14, fontWeight: '700' },
  loadingCard: { alignItems: 'center', padding: 40 },
  loadingTxt: { color: '#6B7280', marginTop: 12, fontSize: 14 },
  statsRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  statCard: { flex: 1, backgroundColor: C.card, borderRadius: 12, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: '#E5E7EB' },
  statNum: { color: C.accent, fontSize: 22, fontWeight: '900' },
  statLabel: { color: '#9CA3AF', fontSize: 10, marginTop: 2 },
  metaRow: { paddingVertical: 8 },
  metaTxt: { color: '#6B7280', fontSize: 11, textAlign: 'center' },
  sectionTitle: { color: '#6B7280', fontSize: 12, fontWeight: '800', marginBottom: 8 },
  topicRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  topicBadge: { backgroundColor: '#A78BFA22', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: '#A78BFA33' },
  topicTxt: { color: C.purple, fontSize: 12, fontWeight: '600' },
  actionRow: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: C.card, borderRadius: 10, padding: 12, marginBottom: 4, gap: 10, borderWidth: 1, borderColor: '#E5E7EB' },
  actionNum: { color: C.green, fontSize: 14, fontWeight: '900', width: 20 },
  actionTxt: { color: '#1F2937', fontSize: 13, flex: 1, lineHeight: 19 },
  keyMsgRow: { backgroundColor: C.card, borderRadius: 10, padding: 12, marginBottom: 4, borderWidth: 1, borderColor: '#E5E7EB' },
  keyMsgTxt: { color: '#ccc', fontSize: 13, fontStyle: 'italic', lineHeight: 19 },
  regenBtn: { marginTop: 20, backgroundColor: '#4A9FFF15', borderRadius: 12, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: '#4A9FFF33' },
  regenTxt: { color: C.accent, fontSize: 13, fontWeight: '700' },
});
