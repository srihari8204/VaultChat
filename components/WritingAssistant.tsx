// components/WritingAssistant.tsx
// Rephrase, shorten, make formal/casual/emoji

import React, { useMemo } from 'react';
import { Text, TouchableOpacity, StyleSheet, ScrollView, Pressable, View } from 'react-native';
import { rewriteMessage, WriteMode } from '../services/aiService';
import type { Palette } from '../constants/theme';
import { useColors } from '../lib/theme';

const MODES: { label: string; mode: WriteMode; icon: string }[] = [
  { label: 'Formal',  mode: 'formal',  icon: '👔' },
  { label: 'Casual',  mode: 'casual',  icon: '😊' },
  { label: 'Shorter', mode: 'shorter', icon: '✂️' },
  { label: 'Longer',  mode: 'longer',  icon: '📝' },
  { label: 'Emojis',  mode: 'emoji',   icon: '🎉' },
];

interface Props {
  text: string;
  visible: boolean;
  onClose: () => void;
  onApply: (newText: string) => void;
}

export default function WritingAssistant({ text, visible, onClose, onApply }: Props) {
  const c = useColors();
  const s = useMemo(() => makeS(c), [c]);
  if (!visible || !text.trim()) return null;
  return (
    // The backdrop is a SIBLING under the sheet, not a wrapper around it: a
    // wrapping Pressable is one accessible element on iOS, which hid every mode
    // card from VoiceOver. Taps on the sheet never reach the backdrop.
    <View style={s.overlay} accessibilityViewIsModal>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose}
        accessibilityRole="button" accessibilityLabel="Close writing assistant" />
      <View style={s.sheet}>
        <Text style={s.title} accessibilityRole="header">✏️  Writing Assistant</Text>
        <Text style={s.original} numberOfLines={2}>{text}</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.row}>
          {MODES.map(m => {
            const rewritten = rewriteMessage(text, m.mode);
            return (
              <TouchableOpacity key={m.mode} style={s.modeCard} onPress={() => { onApply(rewritten); onClose(); }}
                accessibilityRole="button" accessibilityLabel={`${m.label}: ${rewritten}`} accessibilityHint="Replaces your message with this version">
                <Text style={s.modeIcon}>{m.icon}</Text>
                <Text style={s.modeLabel}>{m.label}</Text>
                <Text style={s.preview} numberOfLines={3}>{rewritten}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>
    </View>
  );
}

const makeS = (c: Palette) => StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: c.scrim, justifyContent: 'flex-end' },
  sheet: { backgroundColor: c.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 18, paddingBottom: 36 },
  title: { color: c.text, fontSize: 16, fontWeight: 'bold', marginBottom: 8 },
  original: { color: c.textDim, fontSize: 13, marginBottom: 14, fontStyle: 'italic' },
  row: { gap: 10 },
  modeCard: { backgroundColor: c.bg, borderRadius: 12, padding: 12, width: 150, borderWidth: 1, borderColor: c.glassStroke },
  modeIcon: { fontSize: 22, marginBottom: 4 },
  modeLabel: { color: c.accentOn, fontSize: 12, fontWeight: 'bold', marginBottom: 6 },
  preview: { color: c.textDim, fontSize: 12, lineHeight: 17 },
});