// components/chat/ThreadDecor.tsx — the thread furniture around the bubbles:
// the Exit-Kit import seam, the day chip, the unread divider and the
// swipe-to-reply wrapper. Moved out of components/chat/MessageBubble.tsx.

import { useRef } from 'react';
import { Platform, Text, View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { IMPORT_SOURCE } from '../../constants/importSources';
import { useTheme } from '../../lib/theme';
import { useS } from './chatStyles';
import { dayLabel } from './chatFormat';

/**
 * The seam between imported history and messages actually sent in crazzychat.
 *
 * Imported rows carry negative ids, so the boundary is wherever the sign flips —
 * no extra bookkeeping, and it stays correct as native messages accumulate above
 * it.
 */
export function ImportedDivider({ origin, atStart }: { origin: string; atStart?: boolean }) {
  const S = useS();
  const src = IMPORT_SOURCE[origin];
  if (!src) return null;
  return (
    <View style={S.unreadDivRow}>
      <Text style={S.unreadDivTxt}>
        {atStart ? '' : '↑ '}
        <Ionicons name={src.icon} size={12} color={src.tint} />
        {` Imported from ${src.label}`}
      </Text>
    </View>
  );
}

export function DateChip({ iso }: { iso: string }) {
  const S = useS();
  return (
    <View style={S.dateChipRow}>
      <View style={S.dateChip}><Text style={S.dateChipTxt}>{dayLabel(iso)}</Text></View>
    </View>
  );
}

// WhatsApp-style "N unread messages" separator, shown above the first message
// the user hasn't read yet.
export function UnreadDivider({ count }: { count: number }) {
  const S = useS();
  return (
    <View style={S.unreadDivRow}>
      <Text style={S.unreadDivTxt}>{count} unread message{count === 1 ? '' : 's'}</Text>
    </View>
  );
}

// Swipe-right on a message to reply (WhatsApp/Signal gesture). Reveals a reply
// arrow; crossing the threshold fires onReply once and snaps back.
// The swipe is invisible to screen readers; the bubble offers Reply as an
// accessibility action instead (MessageBubble).
export function SwipeToReply({ onReply, children }: { onReply: () => void; children: React.ReactNode }) {
  const ref = useRef<Swipeable>(null);
  const { colors } = useTheme();
  return (
    <Swipeable
      ref={ref}
      friction={2}
      leftThreshold={44}
      overshootLeft={false}
      renderLeftActions={() => (
        <View style={{ justifyContent: 'center', paddingLeft: 18 }}>
          <Ionicons name="arrow-undo" size={22} color={colors.textDim} />
        </View>
      )}
      onSwipeableWillOpen={() => {
        if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        onReply();
        requestAnimationFrame(() => ref.current?.close());
      }}
    >
      {children}
    </Swipeable>
  );
}
