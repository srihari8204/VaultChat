// components/SmartReplyBar.tsx
// Shows 3 smart reply chips above the input bar

import React, { useEffect, useState, useMemo } from 'react';
import { Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { getSmartReplies } from '../services/aiService';
import type { Palette } from '../constants/theme';
import { useColors } from '../lib/theme';

interface Props {
  lastMessage: string;
  onSelect: (reply: string) => void;
  visible: boolean;
}

export default function SmartReplyBar({ lastMessage, onSelect, visible }: Props) {
  const c = useColors();
  const s = useMemo(() => makeS(c), [c]);
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

const makeS = (c: Palette) => StyleSheet.create({
  wrap: { backgroundColor: c.bg, borderTopWidth: 1, borderTopColor: c.glassStroke, maxHeight: 44 },
  row: { paddingHorizontal: 10, gap: 8, alignItems: 'center', paddingVertical: 6 },
  chip: { backgroundColor: c.bg, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 7, borderWidth: 1, borderColor: '#00E5FF33' },
  chipTxt: { color: '#00E5FF', fontSize: 13 },
});