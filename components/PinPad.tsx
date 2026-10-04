/**
 * Shared MPIN pad: dot display + custom numeric keypad (no system keyboard,
 * so the PIN is never shown as digits). Controlled via value/onChange; fires
 * onComplete when `length` digits are entered.
 *
 * Variable-length PINs (the Device PIN is 4–8 digits): pass `onSubmit` and
 * `minLength`. The empty bottom-left key becomes a submit key, enabled from
 * `minLength` digits, and the dots show what has been typed rather than a fixed
 * count the user might think they must fill.
 */
import { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';

export function PinPad({
  value, onChange, length = 6, onComplete, error = false, onSubmit, minLength = length,
  submitLabel = 'Unlock',
}: {
  value: string;
  onChange: (v: string) => void;
  length?: number;
  onComplete?: (v: string) => void;
  error?: boolean;
  onSubmit?: (v: string) => void;
  minLength?: number;
  submitLabel?: string;
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

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', onSubmit ? 'ok' : '', '0', 'del'];
  const canSubmit = value.length >= minLength;
  const dotCount = onSubmit ? Math.max(minLength, value.length) : length;

  return (
    <View style={p.wrap}>
      <View
        style={p.dots}
        accessible
        accessibilityLabel={`${value.length} of ${onSubmit ? `${minLength} to ${length}` : length} digits entered`}
      >
        {Array.from({ length: dotCount }).map((_, i) => (
          <View key={i} style={[p.dot, i < value.length && p.dotFilled, error && p.dotErr]} />
        ))}
      </View>
      <View style={p.pad}>
        {keys.map((k, i) =>
          k === ''
            ? <View key={i} style={p.key} />
            : k === 'ok'
              ? (
                <TouchableOpacity
                  key={i}
                  style={[p.key, !canSubmit && p.keyOff]}
                  onPress={() => canSubmit && onSubmit?.(value)}
                  disabled={!canSubmit}
                  activeOpacity={0.6}
                  accessibilityRole="button"
                  accessibilityLabel={submitLabel}
                  accessibilityState={{ disabled: !canSubmit }}
                >
                  <Text style={p.keyTxt}>✓</Text>
                </TouchableOpacity>
              )
              : (
                <TouchableOpacity
                  key={i}
                  style={p.key}
                  onPress={() => press(k)}
                  activeOpacity={0.6}
                  accessibilityRole="button"
                  accessibilityLabel={k === 'del' ? 'Delete' : k}
                >
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
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, borderColor: c.textDim, backgroundColor: c.glassSoft },
  dotFilled: { backgroundColor: c.primary, borderColor: c.primary },
  dotErr: { borderColor: c.danger },
  pad: { flexDirection: 'row', flexWrap: 'wrap', width: 280, justifyContent: 'center' },
  // 2026-09-18: height stays PINNED, deliberately. The digits ARE text and do
  // scale, but one glyph cannot wrap: 26 at font scale 1.5 is a ~51 line box
  // inside 68, so nothing clips — there is no defect here to fix. Freeing it
  // would add ~7 per key, ~28 over the four rows, and both callers in
  // app/encrypted-notes.tsx (the screen gate and the locked-note modal) centre
  // this pad in a container that does NOT scroll, so that growth comes off the
  // bottom of the screen on a short device. Pinned is the safe reading here.
  // ponytail: if the pad ever needs to scale, the callers must scroll first.
  key: {
    // layout-exempt: a keypad key holds ONE digit at a fixed 26px, and the pad
    // must stay a grid — a key that grew with the font scale would break the
    // 3-across layout it depends on. 280 is the pad width, so 3 keys + margins
    // fit inside 320dp.
    width: 280 / 3 - 10, height: 68, margin: 5, borderRadius: 34,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.glassSoft, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke,
  },
  keyOff: { opacity: 0.35 },
  keyTxt: { color: c.text, fontSize: 26, fontWeight: '600' },
});

export default PinPad;
