// components/ReactionPicker.tsx
// Emoji reaction picker shown on long-press

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Pressable } from 'react-native';

const EMOJIS = ['â¤ï¸', 'ðŸ˜‚', 'ðŸ‘', 'ðŸ˜®', 'ðŸ˜¢', 'ðŸ”¥', 'ðŸ‘', 'ðŸ™'];

interface Props {
  visible: boolean;
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

export default function ReactionPicker({ visible, onSelect, onClose }: Props) {
  if (!visible) return null;
  return (
    <Pressable style={s.overlay} onPress={onClose}>
      <View style={s.bubble}>
        {EMOJIS.map(e => (
          <TouchableOpacity key={e} onPress={() => onSelect(e)} style={s.emojiBtn}>
            <Text style={s.emoji}>{e}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  overlay:  { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  bubble:   {
    position: 'absolute', bottom: 120, alignSelf: 'center',
    flexDirection: 'row', backgroundColor: '#1A1A32',
    borderRadius: 30, paddingHorizontal: 8, paddingVertical: 6,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4, shadowRadius: 8, elevation: 10,
    borderWidth: 1, borderColor: '#333',
  },
  emojiBtn: { padding: 6 },
  emoji:    { fontSize: 26 },
});