// app/finance/chitti/index.tsx — Lucky Draw group list with progress + status.

import React, { useCallback, useMemo, useState } from 'react';
import { useFinanceTheme } from '../../../components/finance/useFinanceTheme';
import { View, Text, FlatList, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FIN_SHADOW, type FinancePalette } from '../../../constants/financeTheme';
import { FinHeader, Segment, ProgressRing, EmptyState, LoadingState, ErrorState } from '../../../components/finance/ui';
import { useLoadStatus } from '../../../components/finance/useLoad';
import { useMe } from '../../../components/finance/useMe';
import { inrShort } from '../../../utils/financeFormat';
import { listGroups, paidCountsByGroup, type ChittiGroup } from '../../../db/chitti';

type Tab = 'active' | 'closed' | 'draft';

export default function ChittiList() {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  // s.fab lives in a module-scope StyleSheet, so a literal bottom there
  // would freeze at launch and never follow a rotation. Read the inset from the
  // hook and apply it at the element instead (2026-09-17).
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const me = useMe();
  const [tab, setTab] = useState<Tab>('active');
  const [groups, setGroups] = useState<ChittiGroup[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});

  const { status, begin, done, fail } = useLoadStatus();
  const reload = useCallback(() => {
    if (!me) return;
    begin();
    // This had no .catch at all: a failed read was an unhandled rejection and
    // the screen silently showed "No active groups".
    // listGroups also closes groups whose last auction has passed, so the
    // Active / Closed tabs are current. One grouped COUNT replaces a
    // per-group read of every collection row.
    (async () => {
      const [gs, paid] = await Promise.all([listGroups(me.id), paidCountsByGroup(me.id)]);
      setGroups(gs);
      const prog: Record<string, number> = {};
      for (const g of gs) prog[g.id] = ((paid[g.id] ?? 0) / (g.members * g.duration || 1)) * 100;
      setProgress(prog);
      done();
    })().catch(fail);
  }, [me, begin, done, fail]);
  useFocusEffect(reload);

  const shown = useMemo(() => groups.filter(g => g.status === tab), [groups, tab]);

  return (
    <View style={s.screen}>
      {/* One way to add a group: the button at the foot. The header used to
          carry a second one with a near-identical spoken name. */}
      <FinHeader title="Lucky Draw" />
      <View style={s.filterWrap}>
        <Segment<Tab>
          options={[{ k: 'active', label: 'Active' }, { k: 'closed', label: 'Closed' }, { k: 'draft', label: 'Draft' }]}
          value={tab} tabs onChange={setTab}
        />
      </View>
      <FlatList
        data={status === 'ready' ? shown : []}
        keyExtractor={(g) => g.id}
        contentContainerStyle={s.body}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={status === 'loading' ? (
          <LoadingState label="Loading Lucky Draw groups" />
        ) : status === 'error' ? (
          <ErrorState title="Could not load groups" sub="Your Lucky Draw groups could not be read. Nothing has been lost." onRetry={reload} />
        ) : (
          <EmptyState icon="people-outline" title={`No ${tab} groups`} sub="Create a Lucky Draw group to track members and collections." />
        )}
        renderItem={({ item: g }) => (
          <TouchableOpacity style={s.card} activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel={`${g.name}, ${g.members} members, ${inrShort(g.installment)} a month, ${Math.round(progress[g.id] ?? 0)}% collected. Open group`}
            onPress={() => router.push({ pathname: '/finance/chitti/[id]', params: { id: g.id } })}>
            <ProgressRing pct={progress[g.id] ?? 0} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.name} numberOfLines={1}>{g.name}</Text>
              <Text style={s.sub} numberOfLines={1}>{g.members} members · {inrShort(g.installment)}/mo</Text>
              <Text style={s.chit}>Chit value {inrShort(g.chit_value)}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={FIN.faint} />
          </TouchableOpacity>
        )}
        // Clears the button at the foot, which sits above the home indicator.
        ListFooterComponent={<View style={{ height: 90 + insets.bottom }} />}
      />
      <TouchableOpacity style={[s.fab, { bottom: insets.bottom + 20 }]} activeOpacity={0.9} onPress={() => router.push('/finance/chitti/new')}
        accessibilityRole="button" accessibilityLabel="New Lucky Draw group">
        <Ionicons name="add" size={22} color={FIN.onBrand} />
        <Text style={s.fabTxt}>New Lucky Draw Group</Text>
      </TouchableOpacity>
    </View>
  );
}

const makeStyles = (FIN: FinancePalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  filterWrap: { paddingHorizontal: 16, paddingTop: 12, alignSelf: 'center', width: '100%', maxWidth: FIN.contentMax },
  body: { padding: 16, paddingTop: 12, alignSelf: 'center', width: '100%', maxWidth: FIN.contentMax },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: FIN.card, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: FIN.glassEdge, ...FIN_SHADOW.rest },
  name: { color: FIN.text, fontSize: 15.5, fontWeight: '700' },
  sub: { color: FIN.sub, fontSize: 12.5, marginTop: 2 },
  chit: { color: FIN.brandDeep, fontSize: 12, fontWeight: '700', marginTop: 3 },
  fab: { position: 'absolute', left: 16, right: 16, bottom: 20, flexDirection: 'row', gap: 8, backgroundColor: FIN.brandDeep, borderRadius: 14, paddingVertical: 15, alignItems: 'center', justifyContent: 'center', elevation: 6 },
  fabTxt: { color: FIN.onBrand, fontSize: 15, fontWeight: '800' },
});
