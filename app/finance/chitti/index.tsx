// app/finance/chitti/index.tsx — Lucky Draw group list with progress + status.

import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { FIN } from '../../../constants/financeTheme';
import { FinHeader, Segment, ProgressRing, EmptyState } from '../../../components/finance/ui';
import { useMe } from '../../../components/finance/useMe';
import { inrShort } from '../../../utils/financeFormat';
import { listGroups, listCollections, type ChittiGroup } from '../../../db/chitti';

type Tab = 'active' | 'closed' | 'draft';

export default function ChittiList() {
  const router = useRouter();
  const me = useMe();
  const [tab, setTab] = useState<Tab>('active');
  const [groups, setGroups] = useState<ChittiGroup[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});

  const reload = useCallback(() => {
    if (!me) return;
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
    })();
  }, [me]);
  useFocusEffect(reload);

  const shown = useMemo(() => groups.filter(g => g.status === tab), [groups, tab]);

  return (
    <View style={s.screen}>
      <FinHeader title="Lucky Draw" right={
        <TouchableOpacity onPress={() => router.push('/finance/chitti/new')} hitSlop={8}>
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
        {shown.length === 0 ? (
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
      <TouchableOpacity style={s.fab} activeOpacity={0.9} onPress={() => router.push('/finance/chitti/new')}>
        <Ionicons name="add" size={22} color="#fff" />
        <Text style={s.fabTxt}>New Lucky Draw Group</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  filterWrap: { paddingHorizontal: 16, paddingTop: 12 },
  body: { padding: 16, paddingTop: 12 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: FIN.card, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: FIN.border },
  name: { color: FIN.text, fontSize: 15.5, fontWeight: '700' },
  sub: { color: FIN.sub, fontSize: 12.5, marginTop: 2 },
  chit: { color: FIN.brandDeep, fontSize: 12, fontWeight: '700', marginTop: 3 },
  fab: { position: 'absolute', left: 16, right: 16, bottom: 20, flexDirection: 'row', gap: 8, backgroundColor: FIN.brandDeep, borderRadius: 14, paddingVertical: 15, alignItems: 'center', justifyContent: 'center', elevation: 6 },
  fabTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },
});
