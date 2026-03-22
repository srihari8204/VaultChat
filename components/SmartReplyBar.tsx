// components/SmartReplyBar.tsx
// Shows 3 smart reply chips above the input bar

import React, { useEffect, useState } from 'react';
import { Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { getSmartReplies } from '../services/aiService';

interface Props {
  lastMessage: string;
  onSelect: (reply: string) => void;
  visible: boolean;
}

export default function SmartReplyBar({ lastMessage, onSelect, visible }: Props) {
  const [replies, setReplies] = useState<string[]>([]);

  useEffect(() => {
    if (!visible || !lastMessage) { setReplies([]); return; }
    getSmartReplies(lastMessage).then(setReplies);
  }, [lastMessage, visible]);

  if (!visible || replies.length === 0) return null;

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.wrap} contentContainerStyle={s.row}>
      {replies.map((r, i) => (
        <TouchableOpacity key={i} style={s.chip} onPress={() => onSelect(r)}>
          <Text style={s.chipTxt}>{r}</Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  wrap: { backgroundColor: '#0C0C1A', borderTopWidth: 1, borderTopColor: '#111', maxHeight: 44 },
  row:  { paddingHorizontal: 10, gap: 8, alignItems: 'center', paddingVertical: 6 },
  chip: { backgroundColor: '#111127', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 7, borderWidth: 1, borderColor: '#00E5FF33' },
  chipTxt: { color: '#00E5FF', fontSize: 13 },
});