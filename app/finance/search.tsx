// app/finance/search.tsx — universal finance search across ledgers & chitti.
// Matches on name, mobile/phone and amount.

import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TextInput, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { FIN, STATUS_COLORS } from '../../constants/financeTheme';
import { FinHeader, Pill, EmptyState } from '../../components/finance/ui';
import { useMe } from '../../components/finance/useMe';
import { formatINR, inrShort } from '../../utils/financeFormat';
import { listLedger, type LedgerEntry } from '../../db/ledger';
import { listGroups, type ChittiGroup } from '../../db/chitti';

export default function FinanceSearch() {
  const router = useRouter();
  const me = useMe();
  const [q, setQ] = useState('');
  const [ledgers, setLedgers] = useState<LedgerEntry[]>([]);
  const [groups, setGroups] = useState<ChittiGroup[]>([]);

  const reload = useCallback(() => {
    if (!me) return;
    listLedger(me.id).then(setLedgers).catch(() => {});
    listGroups(me.id).then(setGroups).catch(() => {});
  }, [me]);
  useFocusEffect(reload);

  const query = q.trim().toLowerCase();
  const amount = Number(q.replace(/[₹,\s]/g, ''));
  const hasAmount = Number.isFinite(amount) && amount > 0;

  const matchedLedgers = useMemo(() => {
    if (!query) return [];
    return ledgers.filter(l =>
      l.name.toLowerCase().includes(query) ||
      (l.mobile ?? '').toLowerCase().includes(query) ||
      (hasAmount && (Math.abs(l.principal - amount) < 1 || l.principal >= amount)),
    ).slice(0, 40);
  }, [ledgers, query, amount, hasAmount]);

  const matchedGroups = useMemo(() => {
    if (!query) return [];
    return groups.filter(g =>
      g.name.toLowerCase().includes(query) ||
      (g.foreman ?? '').toLowerCase().includes(query) ||
      (hasAmount && g.chit_value >= amount),
    ).slice(0, 20);
  }, [groups, query, amount, hasAmount]);

  const empty = query.length > 0 && matchedLedgers.length === 0 && matchedGroups.length === 0;

  return (
    <View style={s.screen}>
      <FinHeader title="Search" />
      <View style={s.searchWrap}>
        <Ionicons name="search" size={18} color={FIN.faint} />
        <TextInput
          style={s.input} value={q} onChangeText={setQ} autoFocus
          placeholder="Name, mobile or amount" placeholderTextColor={FIN.faint} returnKeyType="search"
        />
        {q.length > 0 && <TouchableOpacity onPress={() => setQ('')} hitSlop={8}><Ionicons name="close-circle" size={18} color={FIN.faint} /></TouchableOpacity>}
      </View>

      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        {query.length === 0 && <EmptyState icon="search-outline" title="Search your finances" sub="Find ledgers and chitti groups by name, mobile number or amount." />}
        {empty && <EmptyState icon="sad-outline" title="No matches" sub={`Nothing found for “${q}”.`} />}

        {matchedLedgers.length > 0 && <Text style={s.section}>Ledgers · {matchedLedgers.length}</Text>}
        {matchedLedgers.map(e => {
          const sc = STATUS_COLORS[e.status];
          return (
            <TouchableOpacity key={e.id} style={s.card} activeOpacity={0.85}
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

        {matchedGroups.length > 0 && <Text style={s.section}>Chitti groups · {matchedGroups.length}</Text>}
        {matchedGroups.map(g => (
          <TouchableOpacity key={g.id} style={s.card} activeOpacity={0.85}
            onPress={() => router.push({ pathname: '/finance/chitti/[id]', params: { id: g.id } })}>
            <View style={[s.dot, { backgroundColor: FIN.brand }]} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.title} numberOfLines={1}>{g.name}</Text>
              <Text style={s.sub} numberOfLines={1}>{g.members} members · {inrShort(g.installment)}/mo</Text>
            </View>
            <Text style={s.amt}>{inrShort(g.chit_value)}</Text>
          </TouchableOpacity>
        ))}
        <View style={{ height: 30 }} />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  searchWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: FIN.card, marginHorizontal: 16, marginTop: 10, borderRadius: 12, borderWidth: 1, borderColor: FIN.border, paddingHorizontal: 12 },
  input: { flex: 1, paddingVertical: 12, fontSize: 15, color: FIN.text },
  body: { padding: 16, paddingTop: 8 },
  section: { color: FIN.text, fontSize: 14, fontWeight: '800', marginTop: 12, marginBottom: 10 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: FIN.card, borderRadius: 12, padding: 13, marginBottom: 9, borderWidth: 1, borderColor: FIN.border },
  dot: { width: 9, height: 9, borderRadius: 5 },
  title: { color: FIN.text, fontSize: 14.5, fontWeight: '700' },
  sub: { color: FIN.sub, fontSize: 12, marginTop: 2 },
  amt: { color: FIN.text, fontSize: 14, fontWeight: '800' },
});
