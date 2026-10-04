// components/spaces/LoadError.tsx — the "could not load" card every space
// screen shows INSTEAD of its empty state when a fetch fails.
//
// A failed load used to fall through to the empty-state copy ("Nobody is
// waiting", "No runs yet"), which on an operations screen is a false all-clear.
// One component so the wording and the retry affordance are the same on every
// screen.

import { View, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppText as Text } from '../ui/Text';
import type { SpacePalette } from '../../lib/spaces/theme';

export default function LoadError({ colors, title = 'Could not load', message, onRetry }: {
  colors: SpacePalette;
  title?: string;
  message?: string | null;
  onRetry: () => void;
}) {
  return (
    <View
      style={[s.card, { backgroundColor: colors.glassSoft, borderColor: colors.danger }]}
      accessibilityRole="alert"
    >
      <View style={s.row}>
        <Ionicons name="cloud-offline-outline" size={18} color={colors.danger} />
        <Text style={[s.title, { color: colors.text }]}>{title}</Text>
      </View>
      <Text style={{ color: colors.textDim, fontSize: 13 }}>
        {message || 'Check your connection and try again.'}
      </Text>
      <TouchableOpacity
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel="Try again"
        style={[s.btn, { borderColor: colors.primary }]}
      >
        <Ionicons name="refresh" size={16} color={colors.primary} />
        <Text style={{ color: colors.primary, fontWeight: '600' }}>Try again</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  card: { borderRadius: 14, borderWidth: 1, padding: 14, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 15, fontWeight: '700' },
  btn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
    borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, minHeight: 44,
  },
});
