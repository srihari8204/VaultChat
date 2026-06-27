// components/WritingAssistant.tsx
// Rephrase, shorten, make formal/casual/emoji

import React from 'react';
import { Text, TouchableOpacity, StyleSheet, ScrollView, Pressable } from 'react-native';
import { rewriteMessage, WriteMode } from '../services/aiService';

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
  if (!visible || !text.trim()) return null;
  return (
    <Pressable style={s.overlay} onPress={onClose}>
      <Pressable style={s.sheet} onPress={() => {}}>
        <Text style={s.title}>✏️  Writing Assistant</Text>
        <Text style={s.original} numberOfLines={2}>{text}</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.row}>
          {MODES.map(m => {
            const rewritten = rewriteMessage(text, m.mode);
            return (
              <TouchableOpacity key={m.mode} style={s.modeCard} onPress={() => { onApply(rewritten); onClose(); }}>
                <Text style={s.modeIcon}>{m.icon}</Text>
                <Text style={s.modeLabel}>{m.label}</Text>
                <Text style={s.preview} numberOfLines={3}>{rewritten}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </Pressable>
    </Pressable>
  );
}

const s = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#00000088', justifyContent: 'flex-end' },
  sheet:   { backgroundColor: '#0E0E20', borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 18, paddingBottom: 36 },
  title:   { color: '#E0E0F0', fontSize: 16, fontWeight: 'bold', marginBottom: 8 },
  original:{ color: '#555', fontSize: 13, marginBottom: 14, fontStyle: 'italic' },
  row:     { gap: 10 },
  modeCard:{ backgroundColor: '#111127', borderRadius: 12, padding: 12, width: 150, borderWidth: 1, borderColor: '#222' },
  modeIcon:{ fontSize: 22, marginBottom: 4 },
  modeLabel:{ color: '#00E5FF', fontSize: 12, fontWeight: 'bold', marginBottom: 6 },
  preview: { color: '#A0A0C0', fontSize: 12, lineHeight: 17 },
});