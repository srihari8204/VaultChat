// components/finance/chitti/HistoryTab.tsx — the group's append-only record of
// every change (finance_timeline).

import React from 'react';
import { View, Text } from 'react-native';
import { useFinanceTheme } from '../useFinanceTheme';
import { Btn } from '../ui';
import { fmtDateTime } from '../../../utils/financeFormat';
import type { TimelineRow } from '../../../db/financeTimeline';
import { makeChittiStyles } from './chittiStyles';

export function HistoryTab({ timeline, failed, onRetry }: { timeline: TimelineRow[]; failed: boolean; onRetry: () => void }) {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeChittiStyles(FIN), [FIN]);
  if (failed) {
    return (
      <View style={{ paddingVertical: 16, gap: 8 }}>
        <Text style={s.empty} accessibilityRole="alert">Could not load the history. Nothing has been lost.</Text>
        <Btn label="Try again" kind="ghost" icon="refresh" onPress={onRetry} />
      </View>
    );
  }
  if (timeline.length === 0) {
    return <Text style={s.empty}>No activity yet. Adding members and marking dues will show up here.</Text>;
  }
  return (
    <>
      {timeline.map(t => (
        <View key={t.id} style={s.histRow}>
          <View style={s.histDot} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.histTxt}>{t.detail}</Text>
            <Text style={s.histAt}>{fmtDateTime(t.at)}</Text>
          </View>
        </View>
      ))}
    </>
  );
}

export default HistoryTab;
