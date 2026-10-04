// app/finance/search.tsx — universal finance search across ledgers & chitti.
// Matches on name, mobile/phone (ledgers and Lucky Draw members) and amount.

import React, { useCallback, useMemo, useState } from 'react';
import { useFinanceTheme } from '../../components/finance/useFinanceTheme';
import { View, Text, ScrollView, StyleSheet, TextInput, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { financeStatusColors, TABULAR, FIN_SHADOW, type FinancePalette } from '../../constants/financeTheme';
import { FinHeader, Pill, EmptyState, ErrorState, LoadingState } from '../../components/finance/ui';
import { useLoadStatus } from '../../components/finance/useLoad';
import { useMe } from '../../components/finance/useMe';
import { formatINR, inrShort, num } from '../../utils/financeFormat';
import { listLedger, type LedgerEntry } from '../../db/ledger';
import { listGroups, listAllMembers, type ChittiGroup, type ChittiMember } from '../../db/chitti';
import { amountMatches } from '../../utils/financeRules';

export default function FinanceSearch() {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const STATUS_COLORS = React.useMemo(() => financeStatusColors(FIN), [FIN]);
  const router = useRouter();
  const me = useMe();
  const [q, setQ] = useState('');
  const [ledgers, setLedgers] = useState<LedgerEntry[]>([]);
  const [groups, setGroups] = useState<ChittiGroup[]>([]);
  const [members, setMembers] = useState<ChittiMember[]>([]);

  // A failed read must not show "No matches": that claims the data is not
  // there. Nor may a read still in flight.
  const { status, begin, done, fail } = useLoadStatus();
  const reload = useCallback(() => {
    if (!me) return;
    begin();
    Promise.all([listLedger(me.id), listGroups(me.id), listAllMembers(me.id)])
      .then(([l, g, m]) => { setLedgers(l); setGroups(g); setMembers(m); done(); })
      .catch(fail);
  }, [me, begin, done, fail]);
  useFocusEffect(reload);

  const query = q.trim().toLowerCase();
  // The last surviving copy of the bare comma strip: it read '12,5' as 125 and
  // '0x10' as 16, so a search for one amount silently matched another. Nothing
  // is persisted from here, but the whole point of the shared parser is that
  // there is only one of it. ₹ and spaces still come off first — num() knows
  // about commas, not currency symbols (2026-09-17).
  const amount = num(q.replace(/[₹\s]/g, ''));
  const hasAmount = Number.isFinite(amount) && amount > 0;

  const matchedLedgers = useMemo(() => {
    if (!query) return [];
    return ledgers.filter(l =>
      l.name.toLowerCase().includes(query) ||
      (l.mobile ?? '').toLowerCase().includes(query) ||
      // Exact, or the rupee digits start with the query (utils/financeRules).
      // `principal >= amount` matched every bigger loan, so a 5-digit mobile
      // prefix listed nearly the whole book.
      (hasAmount && amountMatches(amount, l.principal)),
    ).slice(0, 40);
  }, [ledgers, query, amount, hasAmount]);

  // Members are matched by name or phone; a hit shows their group.
  const memberHits = useMemo(() => {
    if (!query) return new Map<string, ChittiMember>();
    const hits = new Map<string, ChittiMember>();
    for (const m of members) {
      if (!hits.has(m.group_id) && (m.name.toLowerCase().includes(query) || (m.phone ?? '').includes(query))) hits.set(m.group_id, m);
    }
    return hits;
  }, [members, query]);

  const matchedGroups = useMemo(() => {
    if (!query) return [];
    return groups.filter(g =>
      g.name.toLowerCase().includes(query) ||
      (g.foreman ?? '').toLowerCase().includes(query) ||
      memberHits.has(g.id) ||
      (hasAmount && (amountMatches(amount, g.chit_value) || amountMatches(amount, g.installment))),
    ).slice(0, 20);
  }, [groups, query, amount, hasAmount, memberHits]);

  const ready = status === 'ready';
  const empty = ready && query.length > 0 && matchedLedgers.length === 0 && matchedGroups.length === 0;

  return (
    <View style={s.screen}>
      <FinHeader title="Search" />
      <View style={s.searchCol}>
        <View style={s.searchWrap}>
          <Ionicons name="search" size={18} color={FIN.faint} />
          <TextInput
            style={s.input} value={q} onChangeText={setQ} autoFocus
            placeholder="Name, mobile or amount" placeholderTextColor={FIN.faint} returnKeyType="search"
            accessibilityLabel="Search ledgers and Lucky Draw groups"
          />
          {q.length > 0 && <TouchableOpacity accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setQ('')} hitSlop={8}><Ionicons name="close-circle" size={18} color={FIN.faint} /></TouchableOpacity>}
        </View>
      </View>

      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        {query.length === 0 && <EmptyState icon="search-outline" title="Search your finances" sub="Find ledgers and Lucky Draw groups by name, mobile number or amount." />}
        {status === 'loading' && query.length > 0 && <LoadingState label="Reading your finance data" />}
        {status === 'error' && (
          <ErrorState title="Could not read your finance data" sub="Search results may be missing. Nothing has been lost." onRetry={reload} />
        )}
        {empty && <EmptyState icon="sad-outline" title="No matches" sub={`Nothing found for “${q}”.`} />}

        {matchedLedgers.length > 0 && <Text style={s.section}>Ledgers · {matchedLedgers.length}</Text>}
        {matchedLedgers.map(e => {
          const sc = STATUS_COLORS[e.status];
          return (
            <TouchableOpacity key={e.id} style={s.card} activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={`${e.name}, ${e.direction === 'lend' ? 'lent' : 'borrowed'} ${formatINR(e.principal)}, ${sc.label}. Open ledger`}
              onPress={() => router.push({ pathname: '/finance/ledger/[id]', params: { id: e.id } })}>
              <View style={[s.dot, { backgroundColor: e.direction === 'lend' ? FIN.good : FIN.bad }]} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.title} numberOfLines={1}>{e.name}</Text>
                <Text style={s.sub} numberOfLines={1}>{e.direction === 'lend' ? 'Lent' : 'Borrowed'}{e.mobile ? ` · ${e.mobile}` : ''}</Text>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 5 }}>
                <Text style={s.amt}>{formatINR(e.principal)}</Text>
                <Pill label={sc.label} fg={sc.fg} bg={sc.bg} />
              </View>
            </TouchableOpacity>
          );
        })}

        {matchedGroups.length > 0 && <Text style={s.section}>Lucky Draw groups · {matchedGroups.length}</Text>}
        {matchedGroups.map(g => {
          const hit = memberHits.get(g.id);
          return (
            <TouchableOpacity key={g.id} style={s.card} activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={`Lucky Draw group ${g.name}${hit ? `, member ${hit.name}` : ''}, chit value ${inrShort(g.chit_value)}. Open group`}
              onPress={() => router.push({ pathname: '/finance/chitti/[id]', params: { id: g.id } })}>
              <View style={[s.dot, { backgroundColor: FIN.brand }]} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.title} numberOfLines={1}>{g.name}</Text>
                <Text style={s.sub} numberOfLines={1}>
                  {hit ? `Member ${hit.name}${hit.phone ? ` · ${hit.phone}` : ''}` : `${g.members} members · ${inrShort(g.installment)}/mo`}
                </Text>
              </View>
              <Text style={s.amt}>{inrShort(g.chit_value)}</Text>
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
  // Same capped column as the results below: the outer view takes the
  // contentMax column (gutters included), the bar sits inside its gutters.
  searchCol: { alignSelf: 'center', width: '100%', maxWidth: FIN.contentMax, paddingHorizontal: 16, marginTop: 10 },
  searchWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: FIN.card, borderRadius: 12, borderWidth: 1, borderColor: FIN.border, paddingHorizontal: 12 },
  input: { flex: 1, paddingVertical: 12, fontSize: 15, color: FIN.text },
  body: { padding: 16, paddingTop: 8, alignSelf: 'center', width: '100%', maxWidth: FIN.contentMax },
  section: { color: FIN.text, fontSize: 14, fontWeight: '800', marginTop: 12, marginBottom: 10 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: FIN.card, borderRadius: 12, padding: 13, marginBottom: 9, borderWidth: 1, borderColor: FIN.glassEdge, ...FIN_SHADOW.rest },
  dot: { width: 9, height: 9, borderRadius: 5 },
  title: { color: FIN.text, fontSize: 14.5, fontWeight: '700' },
  sub: { color: FIN.sub, fontSize: 12, marginTop: 2 },
  amt: { color: FIN.text, fontSize: 14, fontWeight: '800', ...TABULAR },
});
