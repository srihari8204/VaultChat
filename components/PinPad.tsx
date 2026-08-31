/**
 * Shared MPIN pad: dot display + custom numeric keypad (no system keyboard,
 * so the PIN is never shown as digits). Controlled via value/onChange; fires
 * onComplete when `length` digits are entered.
 */
import { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';

export function PinPad({
  value, onChange, length = 6, onComplete, error = false,
}: {
  value: string;
  onChange: (v: string) => void;
  length?: number;
  onComplete?: (v: string) => void;
  error?: boolean;
}) {
  // Was pinned to the DARK palette (`Aurora`), so on the light theme every key
  // was white text on a near-white background — the pad rendered, and the
  // digits were invisible. Device-reported on the Redmi. Read the live theme
  // instead, like the rest of the app.
  const { colors } = useTheme();
  const p = useMemo(() => makeStyles(colors), [colors]);
  const press = (d: string) => {
    if (d === 'del') { onChange(value.slice(0, -1)); return; }
    if (value.length >= length) return;
    const next = value + d;
    onChange(next);
    if (next.length === length) onComplete?.(next);
  };

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];

  return (
    <View style={p.wrap}>
      <View style={p.dots}>
        {Array.from({ length }).map((_, i) => (
          <View key={i} style={[p.dot, i < value.length && p.dotFilled, error && p.dotErr]} />
        ))}
      </View>
      <View style={p.pad}>
        {keys.map((k, i) =>
          k === ''
            ? <View key={i} style={p.key} />
            : (
              <TouchableOpacity key={i} style={p.key} onPress={() => press(k)} activeOpacity={0.6}>
                <Text style={p.keyTxt}>{k === 'del' ? '⌫' : k}</Text>
              </TouchableOpacity>
            )
        )}
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  wrap: { alignItems: 'center', width: '100%' },
  dots: { flexDirection: 'row', gap: 16, marginBottom: 40 },
  // A hairline border is invisible on light backgrounds, so empty dots get a
  // faint fill too — the user must be able to count how many digits landed.
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, borderColor: c.textDim, backgroundColor: c.surface },
  dotFilled: { backgroundColor: c.primary, borderColor: c.primary },
  dotErr: { borderColor: c.danger },
  pad: { flexDirection: 'row', flexWrap: 'wrap', width: 280, justifyContent: 'center' },
  key: {
    width: 280 / 3 - 10, height: 68, margin: 5, borderRadius: 34,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
  },
  keyTxt: { color: c.text, fontSize: 26, fontWeight: '600' },
});

export default PinPad;
