// app/finance/chitti/index.tsx — Lucky Draw group list with progress + status.

import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FIN } from '../../../constants/financeTheme';
import { FinHeader, Segment, ProgressRing, EmptyState, LoadingState, ErrorState } from '../../../components/finance/ui';
import { useLoadStatus } from '../../../components/finance/useLoad';
import { useMe } from '../../../components/finance/useMe';
import { inrShort } from '../../../utils/financeFormat';
import { listGroups, listCollections, type ChittiGroup } from '../../../db/chitti';

type Tab = 'active' | 'closed' | 'draft';

export default function ChittiList() {
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
    (async () => {
      const gs = await listGroups(me.id);
      setGroups(gs);
      const prog: Record<string, number> = {};
      for (const g of gs) {
        const cols = await listCollections(g.id);
        const paid = cols.filter(c => c.status === 'paid').length;
        const totalSlots = g.members * g.duration || 1;
        prog[g.id] = (paid / totalSlots) * 100;
      }
      setProgress(prog);
      done();
    })().catch(fail);
  }, [me, begin, done, fail]);
  useFocusEffect(reload);

  const shown = useMemo(() => groups.filter(g => g.status === tab), [groups, tab]);

  return (
    <View style={s.screen}>
      <FinHeader title="Lucky Draw" right={
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="New lucky draw group" onPress={() => router.push('/finance/chitti/new')} hitSlop={8}>
          <Ionicons name="add-circle" size={26} color={FIN.brandDeep} />
        </TouchableOpacity>
      } />
      <View style={s.filterWrap}>
        <Segment<Tab>
          options={[{ k: 'active', label: 'Active' }, { k: 'closed', label: 'Closed' }, { k: 'draft', label: 'Draft' }]}
          value={tab} onChange={setTab}
        />
      </View>
      <ScrollView contentContainerStyle={s.body} showsVerticalScrollIndicator={false}>
        {status === 'loading' ? (
          <LoadingState label="Loading Lucky Draw groups" />
        ) : status === 'error' ? (
          <ErrorState title="Could not load groups" sub="Your Lucky Draw groups could not be read. Nothing has been lost." onRetry={reload} />
        ) : shown.length === 0 ? (
          <EmptyState icon="people-outline" title={`No ${tab} groups`} sub="Create a Lucky Draw group to track members and collections." />
        ) : shown.map(g => (
          <TouchableOpacity key={g.id} style={s.card} activeOpacity={0.85}
            onPress={() => router.push({ pathname: '/finance/chitti/[id]', params: { id: g.id } })}>
            <ProgressRing pct={progress[g.id] ?? 0} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.name} numberOfLines={1}>{g.name}</Text>
              <Text style={s.sub} numberOfLines={1}>{g.members} members · {inrShort(g.installment)}/mo</Text>
              <Text style={s.chit}>Chit value {inrShort(g.chit_value)}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={FIN.faint} />
          </TouchableOpacity>
        ))}
        <View style={{ height: 90 }} />
      </ScrollView>
      <TouchableOpacity style={[s.fab, { bottom: insets.bottom + 20 }]} activeOpacity={0.9} onPress={() => router.push('/finance/chitti/new')}>
        <Ionicons name="add" size={22} color="#fff" />
        <Text style={s.fabTxt}>New Lucky Draw Group</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  filterWrap: { paddingHorizontal: 16, paddingTop: 12, alignSelf: 'center', width: '100%', maxWidth: FIN.contentMax },
  body: { padding: 16, paddingTop: 12, alignSelf: 'center', width: '100%', maxWidth: FIN.contentMax },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: FIN.card, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: FIN.glassEdge, shadowColor: '#101828', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 2 },
  name: { color: FIN.text, fontSize: 15.5, fontWeight: '700' },
  sub: { color: FIN.sub, fontSize: 12.5, marginTop: 2 },
  chit: { color: FIN.brandDeep, fontSize: 12, fontWeight: '700', marginTop: 3 },
  fab: { position: 'absolute', left: 16, right: 16, bottom: 20, flexDirection: 'row', gap: 8, backgroundColor: FIN.brandDeep, borderRadius: 14, paddingVertical: 15, alignItems: 'center', justifyContent: 'center', elevation: 6 },
  fabTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },
});
