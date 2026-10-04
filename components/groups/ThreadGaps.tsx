// components/groups/ThreadGaps.tsx — what a shared notes/tasks list could not
// read, said under the list (lib/groups/opThread.ts).
//
// Without it, an op this phone cannot decrypt, or one older than the pages
// read, simply is not there, and a missing note looks like a deleted one.

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../lib/theme';
import { AppText as Text } from '../ui/Text';

export function ThreadGaps({ unreadable, complete, what }: {
  unreadable: number;
  complete: boolean;
  /** 'notes' or 'tasks', as the sentence reads. */
  what: string;
}) {
  const { colors } = useTheme();
  if (unreadable === 0 && complete) return null;
  const parts: string[] = [];
  if (unreadable > 0) {
    parts.push(`${unreadable} message${unreadable === 1 ? '' : 's'} in this group could not be decrypted on this phone.`);
  }
  if (!complete) parts.push('Only the most recent part of the group’s history was read.');
  return (
    <View style={[st.box, { borderColor: colors.glassStroke }]} accessibilityRole="text">
      <Ionicons name="information-circle-outline" size={15} color={colors.textDim} />
      <Text style={{ color: colors.textDim, fontSize: 11.5, lineHeight: 16, flex: 1 }}>
        {parts.join(' ')} Some {what} may be missing.
      </Text>
    </View>
  );
}

const st = StyleSheet.create({
  box: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginTop: 16, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
});
