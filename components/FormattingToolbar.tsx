// components/FormattingToolbar.tsx
// Message formatting toolbar — Bold, Italic, Strikethrough, Code, Monospace
// Wraps selected text or inserts markers at cursor position

import React, { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { Palette } from '../constants/theme';
import { useColors } from '../lib/theme';

interface Props {
  inputText: string;
  onChangeText: (text: string) => void;
  visible: boolean;
}

const FORMATS = [
  { label: 'B', symbol: '*', style: { fontWeight: '900' as const }, desc: 'Bold' },
  { label: 'I', symbol: '_', style: { fontStyle: 'italic' as const }, desc: 'Italic' },
  { label: 'S', symbol: '~', style: { textDecorationLine: 'line-through' as const }, desc: 'Strike' },
  { label: '<>', symbol: '`', style: { fontFamily: 'monospace' }, desc: 'Code' },
  { label: '```', symbol: '```', style: { fontFamily: 'monospace' }, desc: 'Block' },
];

export default function FormattingToolbar({ inputText, onChangeText, visible }: Props) {
  const c = useColors();
  const s = useMemo(() => makeS(c), [c]);
  if (!visible) return null;

  const applyFormat = (symbol: string) => {
    if (symbol === '```') {
      onChangeText(inputText + '\n```\n\n```');
    } else {
      // Wrap entire text or add markers
      const trimmed = inputText.trim();
      if (trimmed) {
        // Check if already wrapped
        if (trimmed.startsWith(symbol) && trimmed.endsWith(symbol)) {
          // Remove formatting
          onChangeText(trimmed.slice(symbol.length, -symbol.length));
        } else {
          onChangeText(`${symbol}${trimmed}${symbol}`);
        }
      } else {
        onChangeText(`${symbol}${symbol}`);
      }
    }
  };

  return (
    <View style={s.container}>
      {FORMATS.map((f, i) => (
        <TouchableOpacity
          key={i}
          style={s.btn}
          onPress={() => applyFormat(f.symbol)}
        >
          <Text style={[s.label, f.style]}>{f.label}</Text>
        </TouchableOpacity>
      ))}
      <View style={s.divider} />
      <TouchableOpacity style={s.btn} onPress={() => onChangeText(inputText + '• ')}>
        <Text style={s.label}>•</Text>
      </TouchableOpacity>
      <TouchableOpacity style={s.btn} onPress={() => onChangeText(inputText + '\n> ')}>
        <Text style={s.label}>❝</Text>
      </TouchableOpacity>
    </View>
  );
}

const makeS = (c: Palette) => StyleSheet.create({
  container: {
    flexDirection: 'row',
    backgroundColor: c.bg,
    borderTopWidth: 1,
    borderTopColor: c.border,
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 4,
    alignItems: 'center',
  },
  btn: {
    width: 38,
    height: 32,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.06)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  label: {
    color: c.text,
    fontSize: 14,
    fontWeight: '700',
  },
  divider: {
    width: 1,
    height: 20,
    backgroundColor: 'rgba(255,255,255,0.1)',
    marginHorizontal: 4,
  },
});
