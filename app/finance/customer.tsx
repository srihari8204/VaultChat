// app/finance/customer.tsx — per-person profile aggregating all their ledgers.
// Opened with ?name=... (optionally &mobile=...). Customers aren't a table;
// they're derived from ledger entries: by mobile number where both sides have
// one, else by name (utils/financeRules sameCustomer).

import React, { useCallback, useMemo, useState } from 'react';
import { useFinanceTheme } from '../../components/finance/useFinanceTheme';
import { HERO_INK } from '../../components/finance/heroInk';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { financeStatusColors, TABULAR, FIN_SHADOW, type FinancePalette } from '../../constants/financeTheme';
import { FinHeader, HeroCard, StatTile, TileGrid, Pill, EmptyState, LoadingState, ErrorState } from '../../components/finance/ui';
import { useLoadStatus } from '../../components/finance/useLoad';
import { useMe } from '../../components/finance/useMe';
import { sumRupees } from '../../utils/money';
import { formatINR, fmtDate, inrShort, PERIOD_LABEL } from '../../utils/financeFormat';
import { listLedger, type LedgerEntry } from '../../db/ledger';
import { sameCustomer } from '../../utils/financeRules';
import { initialOf } from '../../lib/format';

export default function CustomerProfile() {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const STATUS_COLORS = React.useMemo(() => financeStatusColors(FIN), [FIN]);
  const { name, mobile: mobileParam } = useLocalSearchParams<{ name: string; mobile?: string }>();
  const router = useRouter();
  const me = useMe();
  const [rows, setRows] = useState<LedgerEntry[]>([]);

  const { status, begin, done, fail } = useLoadStatus();
  const reload = useCallback(() => {
    if (!me || !name) return;
    begin();
    listLedger(me.id)
      .then(all => { setRows(all.filter(l => sameCustomer(l, String(name), mobileParam))); done(); })
      .catch(fail);
  }, [me, name, mobileParam, begin, done, fail]);
  useFocusEffect(reload);

  // Paise-exact, same rule as the dashboard and reports — a customer's total
  // that disagrees with the dashboard by a paise is the kind of thing an
  // organizer notices and cannot explain.
  // Both directions of what is still open: what they owe you on loans you
  // made, and what you owe them on loans you took. A completed ledger owes
  // nothing whatever its stored remaining says.
  const totals = useMemo(() => {
    const open = (dir: 'lend' | 'borrow') => rows.filter(l => l.direction === dir && l.status !== 'completed').map(l => l.remaining);
    return {
      lent: sumRupees(rows.filter(l => l.direction === 'lend').map(l => l.principal)),
      borrowed: sumRupees(rows.filter(l => l.direction !== 'lend').map(l => l.principal)),
      owedToYou: sumRupees(open('lend')),
      youOwe: sumRupees(open('borrow')),
    };
  }, [rows]);

  const mobile = mobileParam || (rows.find(r => r.mobile)?.mobile ?? null);
  // Matched by mobile, rows can carry other spellings of the name ("Ramesh K");
  // the header says so instead of showing only the one it was opened with.
  const aliases = useMemo(() => {
    const seen = new Set([String(name ?? '').trim().toLowerCase()]);
    const out: string[] = [];
    for (const r of rows) {
      const k = r.name.trim().toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push(r.name.trim()); }
    }
    return out;
  }, [rows, name]);
  // The net, said as words: "-₹12k" read as a minus sign is easy to miss.
  const net = sumRupees([totals.owedToYou, -totals.youOwe]);
  const netLabel = net > 0 ? 'NET · THEY OWE YOU' : net < 0 ? 'NET · YOU OWE THEM' : 'NET · SETTLED UP';
  const ready = status === 'ready';

  // Without a name there is nothing to look up: reload never starts, and the
  // spinner would turn forever.
  if (!String(name ?? '').trim()) {
    return (
      <View style={s.screen}>
        <FinHeader title="Customer" />
        <View style={s.body}>
          <EmptyState icon="person-outline" title="Customer not found" sub="Open a customer from one of their ledgers." />
        </View>
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <FinHeader title="Customer" />
      <ScrollView contentContainerStyle={s.body} showsVerticalScrollIndicator={false}>
        <View style={s.head}>
          <View style={s.avatar}><Text style={s.avatarTxt}>{initialOf(String(name ?? ''))}</Text></View>
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={s.name} accessibilityRole="header">{name}</Text>
            {mobile ? <Text style={s.mobile}>{mobile}</Text> : null}
            {aliases.length > 0 && (
              <Text style={s.mobile} numberOfLines={2}>Also recorded as {aliases.join(', ')}</Text>
            )}
          </View>
        </View>

        {/* Totals only once the ledgers are read: ₹0 during loading or after a
            failed read would be a figure, not a placeholder. */}
        {ready && (<>
        <HeroCard>
          <Text style={s.heroLabel}>{netLabel} · OPEN BALANCES</Text>
          <Text style={s.heroVal}>{inrShort(Math.abs(net))}</Text>
          <View style={s.heroFoot}>
            <Text style={s.heroFootTxt}>Owed to you {inrShort(totals.owedToYou)}</Text>
            <Text style={s.heroFootTxt}>You owe {inrShort(totals.youOwe)}</Text>
          </View>
        </HeroCard>

        <View style={s.tileRow}>
          <TileGrid>
          <StatTile value={String(rows.length)} label="Ledgers" tone="brand" />
          <StatTile value={inrShort(totals.lent)} label="Total lent" tone="good" />
          <StatTile value={inrShort(totals.borrowed)} label="Total borrowed" tone="bad" />
          <StatTile value={String(rows.filter(r => r.status === 'completed').length)} label="Settled" tone="good" />
          </TileGrid>
        </View>
        </>)}

        <Text style={s.section}>Ledgers</Text>
        {status === 'loading' && <LoadingState label="Loading ledgers" />}
        {status === 'error' && (
          <ErrorState title="Could not load ledgers" sub="This customer's totals could not be read. Nothing has been lost." onRetry={reload} />
        )}
        {status === 'ready' && rows.length === 0 && (
          <EmptyState icon="person-outline" title="No ledgers" sub="This customer has no ledger entries." />
        )}
        {rows.map(e => {
          const sc = STATUS_COLORS[e.status];
          const lent = e.direction === 'lend';
          return (
            <TouchableOpacity key={e.id} style={s.card} activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={`${lent ? 'Lent' : 'Borrowed'} ${formatINR(e.principal)}, ${formatINR(e.remaining)} remaining, ${sc.label}. Open ledger`}
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
  // Hero ink: the FIN_HERO gradient is dark in both schemes (components/finance/heroInk).
  heroLabel: { color: HERO_INK.label, fontSize: 10.5, fontWeight: '700', letterSpacing: 0.8 },
  heroVal: { color: HERO_INK.strong, fontSize: 28, fontWeight: '800', marginTop: 6, ...TABULAR },
  heroFoot: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: HERO_INK.rule },
  heroFootTxt: { color: HERO_INK.soft, fontSize: 12, fontWeight: '600' },
  tileRow: { marginTop: 12 },
  section: { color: FIN.text, fontSize: 16, fontWeight: '800', marginTop: 20, marginBottom: 12 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: FIN.card, borderRadius: 12, padding: 13, marginBottom: 9, borderWidth: 1, borderColor: FIN.glassEdge, ...FIN_SHADOW.rest },
  dot: { width: 9, height: 9, borderRadius: 5 },
  cardTitle: { color: FIN.text, fontSize: 14.5, fontWeight: '700' },
  cardSub: { color: FIN.sub, fontSize: 12, marginTop: 2 },
});
