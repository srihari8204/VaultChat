// app/finance/saved.tsx — Saved & History across ledgers, interest calcs & chitti.

import React, { useCallback, useMemo, useState } from 'react';
import { useFinanceTheme } from '../../components/finance/useFinanceTheme';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { TABULAR, FIN_SHADOW, type FinancePalette } from '../../constants/financeTheme';
import { FinHeader, Segment, Pill, EmptyState, LoadingState, ErrorState } from '../../components/finance/ui';
import { useLoadStatus } from '../../components/finance/useLoad';
import { useMe } from '../../components/finance/useMe';
import { formatINR, fmtDate, PERIOD_LABEL } from '../../utils/financeFormat';
import { listLedger } from '../../db/ledger';
import { listInterest, deleteInterest, type InterestRow } from '../../db/interestHistory';
import { listGroups } from '../../db/chitti';

type Kind = 'ledger' | 'interest' | 'chitti';
interface SavedItem {
  id: string; kind: Kind; title: string; sub: string; amount: number; at: number;
  onPress: () => void; onDelete?: () => void;
}

/** "2₹/₹100 · Monthly" — rows saved before the unit was stored show the bare rate. */
const rateText = (r: InterestRow) => r.rate_mode
  ? `${r.rate}${r.rate_mode === 'rupees' ? '₹/₹100' : '%'}${r.period ? ` · ${PERIOD_LABEL[r.period]}` : ''}`
  : `Rate ${r.rate}`;
type Tab = 'all' | Kind;

const getKindMeta = (FIN: FinancePalette): Record<Kind, { label: string; fg: string; bg: string }> => ({
  ledger:   { label: 'Ledger',   fg: FIN.good, bg: FIN.goodSoft },
  interest: { label: 'Interest', fg: FIN.warn, bg: FIN.warnSoft },
  chitti:   { label: 'Lucky Draw', fg: FIN.info, bg: FIN.infoSoft },
});

export default function Saved() {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const KIND_META = React.useMemo(() => getKindMeta(FIN), [FIN]);
  const router = useRouter();
  const me = useMe();
  const [tab, setTab] = useState<Tab>('all');
  const [items, setItems] = useState<SavedItem[]>([]);

  const { status, begin, done, fail } = useLoadStatus();
  // Interest calculations have no detail screen, so a tap shows the saved
  // figures with a Delete; Delete then asks once more before removing it.
  const reloadRef = React.useRef<() => void>(() => {});
  const deleteCalc = useCallback((r: InterestRow) => Alert.alert('Delete this calculation?',
    'It is removed from Saved & History. This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => {
        deleteInterest(r.id).then(() => reloadRef.current())
          .catch((e: any) => Alert.alert('Could not delete', e?.message ?? 'Try again.'));
      } },
    ]), []);
  const viewCalc = useCallback((r: InterestRow) => Alert.alert(
    `${r.type === 'simple' ? 'Simple' : 'Compound'} interest`,
    [`Principal ${formatINR(r.principal)}`, rateText(r), `${r.time_years} years`,
     `Interest ${formatINR(r.interest)}`, `Total ${formatINR(r.total_amount)}`, `Saved ${fmtDate(r.created_at)}`].join('\n'),
    [{ text: 'Close', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => deleteCalc(r) }],
  ), [deleteCalc]);

  const reload = useCallback(() => {
    if (!me) return;
    begin();
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
          sub: `${rateText(r)} · ${r.time_years} yr · ${fmtDate(r.created_at)}`,
          amount: r.total_amount, at: r.created_at,
          onPress: () => viewCalc(r), onDelete: () => deleteCalc(r),
        })),
        ...groups.map(g => ({
          id: g.id, kind: 'chitti' as Kind,
          title: g.name, sub: `${g.members} members · ${fmtDate(g.created_at)}`,
          amount: g.chit_value, at: g.created_at,
          onPress: () => router.push({ pathname: '/finance/chitti/[id]', params: { id: g.id } }),
        })),
      ].sort((a, b) => b.at - a.at);
      setItems(out);
      done();
    })().catch(fail);
  }, [me, router, begin, done, fail, viewCalc, deleteCalc]);
  reloadRef.current = reload;
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
        {status === 'loading' ? (
          <LoadingState label="Loading your history" />
        ) : status === 'error' ? (
          <ErrorState title="Could not load history" sub="Your saved items could not be read. Nothing has been lost." onRetry={reload} />
        ) : shown.length === 0 ? (
          <EmptyState icon="bookmark-outline" title="Nothing saved yet" sub="Ledgers, interest calculations and Lucky Draw groups you create show up here." />
        ) : shown.map(item => {
          const m = KIND_META[item.kind];
          return (
            <TouchableOpacity key={`${item.kind}-${item.id}`} style={s.card} activeOpacity={0.85} onPress={item.onPress}
              accessibilityRole="button"
              accessibilityLabel={`${m.label}: ${item.title}, ${formatINR(item.amount)}. ${item.sub}. ${item.kind === 'interest' ? 'Show details' : 'Open'}`}
              accessibilityActions={item.onDelete ? [{ name: 'delete', label: 'Delete' }] : undefined}
              onAccessibilityAction={item.onDelete ? (ev) => { if (ev.nativeEvent.actionName === 'delete') item.onDelete?.(); } : undefined}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.title} numberOfLines={1}>{item.title}</Text>
                <Text style={s.sub} numberOfLines={1}>{item.sub}</Text>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 5 }}>
                <Text style={s.amt}>{formatINR(item.amount)}</Text>
                <Pill label={m.label} fg={m.fg} bg={m.bg} />
              </View>
              <Ionicons name="chevron-forward" size={16} color={FIN.faint} style={{ marginLeft: 6 }} />
            </TouchableOpacity>
          );
        })}
        <View style={{ height: 30 }} />
      </ScrollView>
    </View>
  );
}

const makeStyles = (FIN: FinancePalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  filterWrap: { paddingHorizontal: 16, paddingTop: 12, alignSelf: 'center', width: '100%', maxWidth: FIN.contentMax },
  body: { padding: 16, paddingTop: 12, alignSelf: 'center', width: '100%', maxWidth: FIN.contentMax },
  card: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: FIN.card, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: FIN.glassEdge, ...FIN_SHADOW.rest },
  title: { color: FIN.text, fontSize: 15, fontWeight: '700' },
  sub: { color: FIN.sub, fontSize: 12.5, marginTop: 2 },
  amt: { color: FIN.text, fontSize: 14.5, fontWeight: '800', ...TABULAR },
});
