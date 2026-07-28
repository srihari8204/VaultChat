// components/auth/MpinInput.tsx — N-cell numeric MPIN entry (default 6).
// One hidden TextInput backs N visual cells: paste-aware, auto-advancing, masked.

import { useMemo, useRef } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, Animated } from 'react-native';
import { type Palette } from '../../constants/theme';
import { useTheme } from '../../lib/theme';

export const MPIN_LENGTH = 6;

export function MpinInput({
  value, onChange, onComplete, length = MPIN_LENGTH, secure = true, autoFocus = false, shakeAnim,
}: {
  value: string;
  onChange: (v: string) => void;
  onComplete?: (v: string) => void;
  length?: number;
  secure?: boolean;
  autoFocus?: boolean;
  shakeAnim?: Animated.Value;
}) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const inputRef = useRef<TextInput>(null);

  const handle = (t: string) => {
    const digits = t.replace(/\D/g, '').slice(0, length);
    onChange(digits);
    if (digits.length === length) onComplete?.(digits);
  };

  return (
    <Pressable onPress={() => inputRef.current?.focus()}>
      <Animated.View style={[s.row, shakeAnim ? { transform: [{ translateX: shakeAnim }] } : null]}>
        {Array.from({ length }).map((_, i) => {
          const filled = i < value.length;
          const active = i === value.length;
          return (
            <View key={i} style={[s.cell, filled && s.cellFilled, active && s.cellActive]}>
              <Text style={s.cellTxt}>{filled ? (secure ? '•' : value[i]) : ''}</Text>
            </View>
          );
        })}
        <TextInput
          ref={inputRef}
          style={s.hidden}
          value={value}
          onChangeText={handle}
          keyboardType="number-pad"
          maxLength={length}
          autoFocus={autoFocus}
          caretHidden
          textContentType="oneTimeCode"
        />
      </Animated.View>
    </Pressable>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  row: { flexDirection: 'row', gap: 10, justifyContent: 'center' },
  cell: {
    width: 46, height: 56, borderRadius: 12, borderWidth: 1.5, borderColor: c.border,
    backgroundColor: c.card, alignItems: 'center', justifyContent: 'center',
  },
  cellFilled: { borderColor: c.primary },
  cellActive: { borderColor: c.primary, backgroundColor: c.surfaceSolid },
  cellTxt: { color: c.text, fontSize: 26, fontWeight: '800' },
  hidden: { position: 'absolute', width: 1, height: 1, opacity: 0 },
});
