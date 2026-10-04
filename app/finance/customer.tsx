// app/finance/customer.tsx — per-person profile aggregating all their ledgers.
// Opened with ?name=... (optionally &mobile=...). Customers aren't a table;
// they're derived by grouping ledger entries by name.

import React, { useCallback, useMemo, useState } from 'react';
import { useFinanceTheme } from '../../components/finance/useFinanceTheme';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { financeStatusColors, TABULAR, type FinancePalette } from '../../constants/financeTheme';
import { FinHeader, HeroCard, StatTile, TileGrid, Pill, EmptyState, LoadingState, ErrorState } from '../../components/finance/ui';
import { useLoadStatus } from '../../components/finance/useLoad';
import { useMe } from '../../components/finance/useMe';
import { sumRupees } from '../../utils/money';
import { formatINR, fmtDate, inrShort, PERIOD_LABEL } from '../../utils/financeFormat';
import { listLedger, type LedgerEntry } from '../../db/ledger';
import { initialOf } from '../../lib/format';

export default function CustomerProfile() {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const STATUS_COLORS = React.useMemo(() => financeStatusColors(FIN), [FIN]);
  const { name } = useLocalSearchParams<{ name: string }>();
  const router = useRouter();
  const me = useMe();
  const [rows, setRows] = useState<LedgerEntry[]>([]);

  const { status, begin, done, fail } = useLoadStatus();
  const reload = useCallback(() => {
    if (!me || !name) return;
    begin();
    listLedger(me.id)
      .then(all => { setRows(all.filter(l => l.name.trim().toLowerCase() === String(name).trim().toLowerCase())); done(); })
      .catch(fail);
  }, [me, name, begin, done, fail]);
  useFocusEffect(reload);

  // Paise-exact, same rule as the dashboard and reports — a customer's total
  // that disagrees with the dashboard by a paise is the kind of thing an
  // organizer notices and cannot explain.
  const totals = useMemo(() => ({
    lent: sumRupees(rows.filter(l => l.direction === 'lend').map(l => l.principal)),
    borrowed: sumRupees(rows.filter(l => l.direction !== 'lend').map(l => l.principal)),
    remaining: sumRupees(rows.filter(l => l.direction === 'lend').map(l => l.remaining)),
  }), [rows]);

  const mobile = rows.find(r => r.mobile)?.mobile ?? null;

  return (
    <View style={s.screen}>
      <FinHeader title="Customer" />
      <ScrollView contentContainerStyle={s.body} showsVerticalScrollIndicator={false}>
        <View style={s.head}>
          <View style={s.avatar}><Text style={s.avatarTxt}>{initialOf(String(name ?? ''))}</Text></View>
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={s.name}>{name}</Text>
            {mobile ? <Text style={s.mobile}>{mobile}</Text> : null}
          </View>
        </View>

        <HeroCard>
          <Text style={s.heroLabel}>NET POSITION</Text>
          <Text style={s.heroVal}>{inrShort(sumRupees([totals.lent, -totals.borrowed]))}</Text>
          <View style={s.heroFoot}>
            <Text style={s.heroFootTxt}>Lent {inrShort(totals.lent)}</Text>
            <Text style={s.heroFootTxt}>Borrowed {inrShort(totals.borrowed)}</Text>
          </View>
        </HeroCard>

        <View style={s.tileRow}>
          <TileGrid>
          <StatTile value={String(rows.length)} label="Ledgers" tone="brand" />
          <StatTile value={inrShort(totals.remaining)} label="Outstanding" tone="warn" />
          <StatTile value={String(rows.filter(r => r.status === 'completed').length)} label="Settled" tone="good" />
          </TileGrid>
        </View>

        <Text style={s.section}>Ledgers</Text>
        {status === 'loading' && <LoadingState label="Loading ledgers" />}
        {status === 'error' && (
          <ErrorState title="Could not load ledgers" sub="The totals above may be incomplete. Nothing has been lost." onRetry={reload} />
        )}
        {status === 'ready' && rows.length === 0 && (
          <EmptyState icon="person-outline" title="No ledgers" sub="This customer has no ledger entries." />
        )}
        {rows.map(e => {
          const sc = STATUS_COLORS[e.status];
          const lent = e.direction === 'lend';
          return (
            <TouchableOpacity key={e.id} style={s.card} activeOpacity={0.85}
              onPress={() => router.push({ pathname: '/finance/ledger/[id]', params: { id: e.id } })}>
              <View style={[s.dot, { backgroundColor: lent ? FIN.good : FIN.bad }]} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.cardTitle}>{lent ? 'Lent' : 'Borrowed'} · {formatINR(e.principal)}</Text>
                <Text style={s.cardSub}>{e.rate}{e.rate_mode === 'rupees' ? '₹' : '%'} · {PERIOD_LABEL[e.period]} · {fmtDate(e.created_at)}</Text>
              </View>
              <Pill label={sc.label} fg={sc.fg} bg={sc.bg} />
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
  body: { padding: 16, alignSelf: 'center', width: '100%', maxWidth: FIN.contentMax },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 },
  avatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: FIN.brandSoft, alignItems: 'center', justifyContent: 'center' },
  avatarTxt: { color: FIN.brandDeep, fontSize: 22, fontWeight: '800' },
  name: { color: FIN.text, fontSize: 20, fontWeight: '800' },
  mobile: { color: FIN.sub, fontSize: 13, marginTop: 2 },
  heroLabel: { color: 'rgba(255,255,255,0.85)', fontSize: 10.5, fontWeight: '700', letterSpacing: 0.8 },
  heroVal: { color: '#fff', fontSize: 28, fontWeight: '800', marginTop: 6, ...TABULAR },
  heroFoot: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.2)' },
  heroFootTxt: { color: 'rgba(255,255,255,0.9)', fontSize: 12, fontWeight: '600' },
  tileRow: { marginTop: 12 },
  section: { color: FIN.text, fontSize: 16, fontWeight: '800', marginTop: 20, marginBottom: 12 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: FIN.card, borderRadius: 12, padding: 13, marginBottom: 9, borderWidth: 1, borderColor: FIN.glassEdge, shadowColor: '#101828', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 2 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  cardTitle: { color: FIN.text, fontSize: 14.5, fontWeight: '700' },
  cardSub: { color: FIN.sub, fontSize: 12, marginTop: 2 },
});
