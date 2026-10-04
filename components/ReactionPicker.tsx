// components/ReactionPicker.tsx
// Emoji reaction picker shown on long-press

import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Pressable } from 'react-native';
import type { Palette } from '../constants/theme';
import { useColors } from '../lib/theme';

const EMOJIS = ['❤️', '😂', '👍', '😮', '😢', '🔥', '👏', '🙏'];

interface Props {
  visible: boolean;
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

export default function ReactionPicker({ visible, onSelect, onClose }: Props) {
  const c = useColors();
  const s = useMemo(() => makeS(c), [c]);
  if (!visible) return null;
  return (
    // The dismiss target is a sibling behind the emoji row, not its parent:
    // an accessible parent folds the row into one VoiceOver element.
    <View style={s.overlay}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close reactions" />
      <View style={s.bubble}>
        {EMOJIS.map(e => (
          <TouchableOpacity key={e} onPress={() => onSelect(e)} style={s.emojiBtn} accessibilityRole="button" accessibilityLabel={`React ${e}`}>
            <Text style={s.emoji}>{e}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const makeS = (c: Palette) => StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  bubble:   {
    position: 'absolute', bottom: 120, alignSelf: 'center',
    flexDirection: 'row', backgroundColor: c.bg,
    borderRadius: 30, paddingHorizontal: 8, paddingVertical: 6,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4, shadowRadius: 8, elevation: 10,
    borderWidth: 1, borderColor: c.glassStroke,
  },
  emojiBtn: { padding: 6 },
  emoji: { fontSize: 26 },
});