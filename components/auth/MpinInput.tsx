// components/auth/MpinInput.tsx — N-cell numeric MPIN entry (default 6).
// One hidden TextInput backs N visual cells: paste-aware, auto-advancing, masked.
//
// onDark preserves the auth night styling in dark mode. Both callers follow
// the shared light palette when the selected appearance is light.

import { useMemo, useRef } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, Animated } from 'react-native';
import { AUTH_FIELDS, type FieldColors } from '../../constants/authTheme';
import { useTheme } from '../../lib/theme';

export const MPIN_LENGTH = 6;

export function MpinInput({
  value, onChange, onComplete, length = MPIN_LENGTH, secure = true, autoFocus = false, shakeAnim, onDark = false,
  label = 'MPIN',
}: {
  value: string;
  onChange: (v: string) => void;
  onComplete?: (v: string) => void;
  length?: number;
  secure?: boolean;
  autoFocus?: boolean;
  shakeAnim?: Animated.Value;
  onDark?: boolean;
  /** What a screen reader calls this field, e.g. "MPIN" or "Verification code". */
  label?: string;
}) {
  const { colors, scheme } = useTheme();
  const c = onDark && scheme === 'dark' ? AUTH_FIELDS : colors;
  const s = useMemo(() => makeStyles(c), [c]);
  const inputRef = useRef<TextInput>(null);

  const handle = (t: string) => {
    const digits = t.replace(/\D/g, '').slice(0, length);
    onChange(digits);
    if (digits.length === length) onComplete?.(digits);
  };

  // BLUR THEN FOCUS, not focus() on its own.
  //
  // focus() on an ALREADY-FOCUSED input is a no-op — it never calls
  // showSoftInput again. So when the keyboard fails to appear on mount (see the
  // note on `hidden` below, and MIUI does exactly this), tapping the cells could
  // never recover it: the input was already focused, so the one escape hatch on
  // this screen did nothing however many times it was pressed. Verified on the
  // Redmi Note 8 Pro, where dumpsys showed the input served but
  // mShowRequested=false, permanently.
  //
  // Dropping focus first makes the re-focus a real request. requestAnimationFrame
  // rather than a bare call because the blur must reach the native view before
  // the focus does, or Android coalesces the pair back into a no-op.
  const reveal = () => {
    const i = inputRef.current;
    if (!i) return;
    i.blur();
    requestAnimationFrame(() => i.focus());
  };

  return (
    // One accessible control for the whole field: the cells only draw, so a
    // screen reader hears "MPIN, 2 of 6 digits entered" and a double tap opens
    // the keyboard (reveal), instead of six unlabelled boxes.
    <Pressable
      onPress={reveal}
      style={s.inputWrap}
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${value.length} of ${length} digits entered`}
      accessibilityHint="Opens the number keyboard"
    >
      <Animated.View style={[s.row, shakeAnim ? { transform: [{ translateX: shakeAnim }] } : null]}>
        {Array.from({ length }).map((_, i) => {
          const filled = i < value.length;
          const active = i === value.length;
          return (
            <View key={i} style={[s.cell, filled && s.cellFilled, active && s.cellActive]}
              accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
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
          accessibilityLabel={label}
        />
      </Animated.View>
    </Pressable>
  );
}

const makeStyles = (c: FieldColors) => StyleSheet.create({
  inputWrap: { width: '100%', maxWidth: 326, alignSelf: 'center' },
  row: { width: '100%', flexDirection: 'row', gap: 10, justifyContent: 'center' },
  cell: {
    flex: 1, minWidth: 0, maxWidth: 46, minHeight: 56, borderRadius: 12, borderWidth: 1.5, borderColor: c.glassStroke,
    backgroundColor: c.glassSoft, alignItems: 'center', justifyContent: 'center',
  },
  cellFilled: { borderColor: c.primary },
  cellActive: { borderColor: c.primary, backgroundColor: c.surfaceSolid },
  cellTxt: { color: c.text, fontSize: 26, fontWeight: '800' },
  // NOT opacity 0. Android refuses showSoftInput() for a view it considers
  // invisible, and MIUI enforces that strictly: with opacity 0 the input focused
  // (dumpsys showed it as mServedView) but the keyboard was never requested —
  // mShowRequested=false — so the six cells sat there with no way to type into
  // them. That blocks signup, unlock and MPIN recovery, not just one screen.
  //
  // 0.01 is invisible to the eye and visible to the IME. The input is still 1x1
  // and behind the cells, and caretHidden keeps it from showing a cursor, so
  // nothing about the appearance changes. Do not "tidy" this back to 0.
  hidden: { position: 'absolute', width: 1, height: 1, opacity: 0.01 },
});
