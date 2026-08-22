// app/finance/saved.tsx — Saved & History across ledgers, interest calcs & chitti.

import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { FIN } from '../../constants/financeTheme';
import { FinHeader, Segment, Pill, EmptyState } from '../../components/finance/ui';
import { useMe } from '../../components/finance/useMe';
import { formatINR, fmtDate } from '../../utils/financeFormat';
import { listLedger } from '../../db/ledger';
import { listInterest } from '../../db/interestHistory';
import { listGroups } from '../../db/chitti';

type Kind = 'ledger' | 'interest' | 'chitti';
interface SavedItem { id: string; kind: Kind; title: string; sub: string; amount: number; at: number; onPress?: () => void; }
type Tab = 'all' | Kind;

const KIND_META: Record<Kind, { label: string; fg: string; bg: string }> = {
  ledger:   { label: 'Ledger',   fg: FIN.good, bg: FIN.goodSoft },
  interest: { label: 'Interest', fg: FIN.warn, bg: FIN.warnSoft },
  chitti:   { label: 'Lucky Draw', fg: FIN.info, bg: FIN.infoSoft },
};

export default function Saved() {
  const router = useRouter();
  const me = useMe();
  const [tab, setTab] = useState<Tab>('all');
  const [items, setItems] = useState<SavedItem[]>([]);

  const reload = useCallback(() => {
    if (!me) return;
    (async () => {
      const [ledgers, interest, groups] = await Promise.all([
        listLedger(me.id), listInterest(me.id), listGroups(me.id),
      ]);
      const out: SavedItem[] = [
        ...ledgers.map(l => ({
          id: l.id, kind: 'ledger' as Kind,
          title: l.name, sub: `${l.direction === 'lend' ? 'Lent' : 'Borrowed'} · ${fmtDate(l.created_at)}`,
          amount: l.principal, at: l.created_at,
          onPress: () => router.push({ pathname: '/finance/ledger/[id]', params: { id: l.id } }),
        })),
        ...interest.map(r => ({
          id: r.id, kind: 'interest' as Kind,
          title: `${r.type === 'simple' ? 'Simple' : 'Compound'} interest`,
          sub: `${r.rate} · ${r.time_years} yr · ${fmtDate(r.created_at)}`,
          amount: r.total_amount, at: r.created_at,
        })),
        ...groups.map(g => ({
          id: g.id, kind: 'chitti' as Kind,
          title: g.name, sub: `${g.members} members · ${fmtDate(g.created_at)}`,
          amount: g.chit_value, at: g.created_at,
          onPress: () => router.push({ pathname: '/finance/chitti/[id]', params: { id: g.id } }),
        })),
      ].sort((a, b) => b.at - a.at);
      setItems(out);
    })();
  }, [me, router]);
  useFocusEffect(reload);

  const shown = useMemo(() => (tab === 'all' ? items : items.filter(i => i.kind === tab)), [items, tab]);

  return (
    <View style={s.screen}>
      <FinHeader title="Saved & History" />
      <View style={s.filterWrap}>
        <Segment<Tab>
          options={[{ k: 'all', label: 'All' }, { k: 'ledger', label: 'Ledger' }, { k: 'interest', label: 'Interest' }, { k: 'chitti', label: 'Lucky Draw' }]}
          value={tab} onChange={setTab} small
        />
      </View>
      <ScrollView contentContainerStyle={s.body} showsVerticalScrollIndicator={false}>
        {shown.length === 0 ? (
          <EmptyState icon="bookmark-outline" title="Nothing saved yet" sub="Ledgers, interest calculations and Lucky Draw groups you create show up here." />
        ) : shown.map(item => {
          const m = KIND_META[item.kind];
          return (
            <TouchableOpacity key={`${item.kind}-${item.id}`} style={s.card} activeOpacity={item.onPress ? 0.85 : 1} onPress={item.onPress}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.title} numberOfLines={1}>{item.title}</Text>
                <Text style={s.sub} numberOfLines={1}>{item.sub}</Text>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 5 }}>
                <Text style={s.amt}>{formatINR(item.amount)}</Text>
                <Pill label={m.label} fg={m.fg} bg={m.bg} />
              </View>
              {item.onPress && <Ionicons name="chevron-forward" size={16} color={FIN.faint} style={{ marginLeft: 6 }} />}
            </TouchableOpacity>
          );
        })}
        <View style={{ height: 30 }} />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  filterWrap: { paddingHorizontal: 16, paddingTop: 12 },
  body: { padding: 16, paddingTop: 12 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: FIN.card, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: FIN.border },
  title: { color: FIN.text, fontSize: 15, fontWeight: '700' },
  sub: { color: FIN.sub, fontSize: 12.5, marginTop: 2 },
  amt: { color: FIN.text, fontSize: 14.5, fontWeight: '800' },
});
