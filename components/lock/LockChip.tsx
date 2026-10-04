// components/lock/LockChip.tsx — the chip shared by both Location Lock faces
// (app/location-lock.tsx setup, components/lock/LockActiveFace.tsx).

import React from 'react';
import { StyleSheet, TouchableOpacity } from 'react-native';
import type { Palette } from '../../constants/theme';
import { AppText as Text } from '../ui';

/** Radius (a radio) / navigate-back (an action) chip. `busy` is for an action
 *  in flight: a chip that is PLANNING is not "selected", and announcing it so was wrong. */
export function Chip({ active: on, busy = false, disabled = false, radio = false, label, onPress, colors }: {
  active: boolean; busy?: boolean; disabled?: boolean; radio?: boolean; label: string; onPress: () => void; colors: Palette;
}) {
  const lit = on || busy;
  return (
    <TouchableOpacity onPress={onPress} disabled={disabled}
      accessibilityRole={radio ? 'radio' : 'button'}
      accessibilityState={radio ? { checked: on, disabled } : { busy, disabled }}
      style={[chipSt.chip, { borderColor: lit ? colors.primary : colors.border, backgroundColor: lit ? colors.primary + '1a' : 'transparent', opacity: disabled && !busy ? 0.5 : 1 }]}>
      <Text style={{ color: lit ? colors.primary : colors.text, fontWeight: lit ? '700' : '500', fontSize: 13.5 }}>{label}</Text>
    </TouchableOpacity>
  );
}

/** Also used directly by the setup face's saved-place chips. */
export const chipSt = StyleSheet.create({
  // minHeight: the 13.5sp label + 8pt padding was a ~36pt chip, under the 44dp tap floor.
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, minHeight: 44, justifyContent: 'center' },
});
