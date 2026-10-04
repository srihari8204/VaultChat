// components/sos/SosHistory.tsx — the Emergency SOS screen's History section
// (split out of app/emergency-sos.tsx).

import React from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../../lib/theme';
import { type SOSHistoryItem } from '../../lib/chatService';
import { sosReachedOf } from '../../lib/sosReachCopy';
import { useSosStyles } from './sosStyles';

const formatTime = (ts: string | null | undefined) => {
  if (!ts) return 'Unknown';
  try {
    const d = new Date(ts);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return 'Unknown'; }
};

export default function SosHistory({ history, failed, loading, onRetry }: {
  history: SOSHistoryItem[]; failed: boolean; loading: boolean; onRetry: () => void;
}) {
  const { colors } = useTheme();
  const styles = useSosStyles();
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle} accessibilityRole="header">History</Text>
      {failed && (
        <View style={[styles.sectionHead, { marginTop: 8 }]}>
          <Text style={[styles.refreshWarn, { flex: 1, marginBottom: 0 }]} accessibilityLiveRegion="polite">
            Couldn&apos;t load your SOS history.
          </Text>
          {loading
            ? <ActivityIndicator size="small" color={colors.accent} accessibilityLabel="Loading SOS history" />
            : (
              <TouchableOpacity onPress={onRetry} accessibilityRole="button" accessibilityLabel="Retry loading SOS history" hitSlop={12}>
                <Text style={styles.editLink}>Retry</Text>
              </TouchableOpacity>
            )}
        </View>
      )}
      {failed && history.length === 0 ? null : history.length === 0 ? (
        <Text style={styles.noHistory}>No SOS activations yet</Text>
      ) : (
        history.map(item => {
          const kind = item.type === 'test' ? 'Test SOS' : 'Emergency SOS';
          const when = formatTime(item.createdAt);
          const reached = sosReachedOf(item);
          const reach = reached == null ? `${item.contactsNotified} alerted`
            : `reached ${Math.min(reached, item.contactsNotified)} of ${item.contactsNotified}`;
          return (
            // One element per activation, not three fragments.
            <View key={item.id} style={styles.historyRow} accessible accessibilityLabel={`${kind}, ${when}, ${reach}`}>
              <View style={[styles.historyDot, { backgroundColor: item.type === 'test' ? colors.primary : colors.danger }]} />
              <View style={styles.historyInfo}>
                <Text style={styles.historyType}>{kind}</Text>
                <Text style={styles.historyTime}>{when}</Text>
              </View>
              <Text style={styles.historyContacts}>{reach}</Text>
            </View>
          );
        })
      )}
    </View>
  );
}
