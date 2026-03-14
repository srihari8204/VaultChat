// components/PollMessage.tsx
// Render a poll inside a message bubble + handle voting

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import firestore from '@react-native-firebase/firestore';
import auth from '@react-native-firebase/auth';

interface PollOption {
  text: string;
  votes: string[];   // UIDs who voted
}

interface PollData {
  question: string;
  options: PollOption[];
  multiSelect: boolean;
  closed: boolean;
}

interface Props {
  messageId: string;
  chatId: string;
  poll: PollData;
}

export default function PollMessage({ messageId, chatId, poll }: Props) {
  const myUid  = auth().currentUser?.uid ?? '';
  const total  = poll.options.reduce((s, o) => s + o.votes.length, 0);

  const vote = async (idx: number) => {
    if (poll.closed) return;
    const options = poll.options.map((o, i) => {
      let votes = [...o.votes];
      if (i === idx) {
        // Toggle my vote on this option
        if (votes.includes(myUid)) votes = votes.filter(u => u !== myUid);
        else votes.push(myUid);
      } else if (!poll.multiSelect) {
        // Single-select: remove my vote from other options
        votes = votes.filter(u => u !== myUid);
      }
      return { ...o, votes };
    });
    await firestore().collection('chats').doc(chatId)
      .collection('messages').doc(messageId)
      .update({ 'poll.options': options });
  };

  return (
    <View style={s.wrap}>
      <Text style={s.question}>{poll.question}</Text>
      {poll.options.map((opt, i) => {
        const voted  = opt.votes.includes(myUid);
        const pct    = total > 0 ? Math.round((opt.votes.length / total) * 100) : 0;
        return (
          <TouchableOpacity key={i} style={[s.option, voted && s.optionVoted]} onPress={() => vote(i)} disabled={poll.closed}>
            <View style={[s.bar, { width: `${pct}%` as any }]} />
            <View style={s.optRow}>
              <Text style={[s.optTxt, voted && { color: '#00E5FF' }]}>{opt.text}</Text>
              <Text style={s.pctTxt}>{pct}%</Text>
            </View>
          </TouchableOpacity>
        );
      })}
      <Text style={s.totalTxt}>{total} vote{total !== 1 ? 's' : ''}{poll.multiSelect ? ' Â· Multiple choice' : ''}{poll.closed ? ' Â· Closed' : ''}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  wrap:        { minWidth: 200, maxWidth: 260 },
  question:    { color: '#E0E0F0', fontSize: 14, fontWeight: '700', marginBottom: 10 },
  option:      { borderWidth: 1, borderColor: '#333', borderRadius: 8, marginBottom: 6, overflow: 'hidden', position: 'relative' },
  optionVoted: { borderColor: '#00E5FF' },
  bar:         { position: 'absolute', top: 0, left: 0, bottom: 0, backgroundColor: '#00E5FF18' },
  optRow:      { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 10, paddingVertical: 9 },
  optTxt:      { color: '#C0C0E0', fontSize: 13, flex: 1 },
  pctTxt:      { color: '#555', fontSize: 12 },
  totalTxt:    { color: '#555', fontSize: 11, marginTop: 4 },
});