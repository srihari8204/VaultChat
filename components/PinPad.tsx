/**
 * Shared MPIN pad: dot display + custom numeric keypad (no system keyboard,
 * so the PIN is never shown as digits). Controlled via value/onChange; fires
 * onComplete when `length` digits are entered.
 */
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Aurora } from '../constants/theme';

export function PinPad({
  value, onChange, length = 6, onComplete, error = false,
}: {
  value: string;
  onChange: (v: string) => void;
  length?: number;
  onComplete?: (v: string) => void;
  error?: boolean;
}) {
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

const p = StyleSheet.create({
  wrap: { alignItems: 'center', width: '100%' },
  dots: { flexDirection: 'row', gap: 16, marginBottom: 40 },
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, borderColor: Aurora.border, backgroundColor: 'transparent' },
  dotFilled: { backgroundColor: Aurora.primary, borderColor: Aurora.primary },
  dotErr: { borderColor: Aurora.danger },
  pad: { flexDirection: 'row', flexWrap: 'wrap', width: 280, justifyContent: 'center' },
  key: { width: 280 / 3, height: 72, alignItems: 'center', justifyContent: 'center' },
  keyTxt: { color: Aurora.text, fontSize: 28, fontWeight: '600' },
});

export default PinPad;
