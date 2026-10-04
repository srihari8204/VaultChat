// components/finance/chitti/DuesTab.tsx — one month's dues per member; a tap
// moves a member along Pending → Paid → Overdue.

import React, { useRef, useState } from 'react';
import { View, Text, TouchableOpacity, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFinanceTheme } from '../useFinanceTheme';
import { markCollection, type ChittiGroup, type ChittiMember, type ChittiCollection } from '../../../db/chitti';
import { makeChittiStyles, getCollectionMeta, collectionStatus, CYCLE, ROW_PAGE } from './chittiStyles';
import { Btn } from '../ui';
import { MonthChips } from './MonthChips';
import { userErrorText } from '../../../lib/userErrorText';

export function DuesTab({ group, members, collections, month, onMonth, onChanged }: {
  group: ChittiGroup; members: ChittiMember[]; collections: ChittiCollection[];
  month: number; onMonth: (m: number) => void;
  /** Re-reads the group; resolves once the new dues are on screen. */
  onChanged: () => Promise<void>;
}) {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeChittiStyles(FIN), [FIN]);
  const COL_META = React.useMemo(() => getCollectionMeta(FIN), [FIN]);
  // One dues tap at a time: each tap reads the status the LAST write left,
  // so a double tap used to skip a state (Pending → Overdue) silently. The
  // latch is held until the re-read has landed: released earlier, a quick
  // second tap read the old status and wrote the same value again.
  const cycling = useRef(false);
  const [limit, setLimit] = useState(ROW_PAGE);

  const cycleStatus = async (m: ChittiMember) => {
    if (cycling.current) return;
    cycling.current = true;
    const cur = collectionStatus(collections, m.id, month);
    const next = CYCLE[(CYCLE.indexOf(cur) + 1) % CYCLE.length];
    try {
      await markCollection(group.id, m.id, month, group.installment, next);
      await onChanged();
    } catch (e) {
      Alert.alert('Could not update the due', userErrorText(e, 'Nothing was changed. Try again.'));
    } finally { cycling.current = false; }
  };

  return (
    <>
      <MonthChips count={group.duration} value={month} onChange={onMonth} />
      {members.length === 0 ? <Text style={s.empty}>Add members first to record collections.</Text> : members.slice(0, limit).map(m => {
        const st = collectionStatus(collections, m.id, month);
        const meta = COL_META[st];
        const nextLabel = COL_META[CYCLE[(CYCLE.indexOf(st) + 1) % CYCLE.length]].label;
        return (
          <TouchableOpacity key={m.id} style={s.memRow} activeOpacity={0.85} onPress={() => cycleStatus(m)}
            accessibilityRole="button"
            accessibilityLabel={`${m.name}, month ${month}: ${meta.label}`}
            accessibilityHint={`Marks it ${nextLabel}`}>
            <View style={s.memNum}><Text style={s.memNumTxt}>{m.number}</Text></View>
            <Text style={[s.memName, { flex: 1 }]} numberOfLines={1}>{m.name}</Text>
            <View style={[s.colPill, { backgroundColor: meta.bg }]}>
              <Ionicons name={meta.icon} size={13} color={meta.fg} />
              <Text style={[s.colTxt, { color: meta.fg }]}>{meta.label}</Text>
            </View>
          </TouchableOpacity>
        );
      })}
      {members.length > limit && (
        <Btn label={`Show ${Math.min(ROW_PAGE, members.length - limit)} more members`} kind="ghost"
          onPress={() => setLimit(n => n + ROW_PAGE)} style={{ marginTop: 8 }} />
      )}
      {members.length > 0 && <Text style={s.hint}>Tap a row to cycle Pending → Paid → Overdue</Text>}
    </>
  );
}

export default DuesTab;
