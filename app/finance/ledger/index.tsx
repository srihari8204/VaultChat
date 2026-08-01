// app/finance/ledger/index.tsx — Ledger Book list (All / Lent / Borrowed) with
// status filtering and a 30-second undo-delete snackbar.

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { FIN, STATUS_COLORS } from '../../../constants/financeTheme';
import { FinHeader, Segment, Pill, EmptyState } from '../../../components/finance/ui';
import { useMe } from '../../../components/finance/useMe';
import { formatINR, PERIOD_LABEL } from '../../../utils/financeFormat';
import { listLedger, deleteLedger, restoreLedger, type LedgerEntry } from '../../../db/ledger';

type Filter = 'all' | 'lend' | 'borrow';

export default function LedgerList() {
  const router = useRouter();
  const me = useMe();
  const [filter, setFilter] = useState<Filter>('all');
  const [rows, setRows] = useState<LedgerEntry[]>([]);
  const [pendingDelete, setPendingDelete] = useState<LedgerEntry | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const snack = useRef(new Animated.Value(0)).current;

  const reload = useCallback(() => {
    if (me) listLedger(me.id).then(setRows).catch(() => {});
  }, [me]);
  useFocusEffect(reload);

  const shown = useMemo(
    () => (filter === 'all' ? rows : rows.filter(r => r.direction === filter)),
    [rows, filter],
  );

  const askDelete = (e: LedgerEntry) => {
    // optimistic remove + start the 30s undo window
    setRows(prev => prev.filter(r => r.id !== e.id));
    setPendingDelete(e);
    Animated.timing(snack, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => finalizeDelete(e.id), 30000);
  };
  const finalizeDelete = (id: string) => {
    deleteLedger(id).catch(() => {});
    setPendingDelete(null);
    Animated.timing(snack, { toValue: 0, duration: 180, useNativeDriver: true }).start();
  };
  const undo = () => {
    if (!pendingDelete) return;
    if (timer.current) clearTimeout(timer.current);
    restoreLedger(pendingDelete).finally(reload);
    setPendingDelete(null);
    Animated.timing(snack, { toValue: 0, duration: 180, useNativeDriver: true }).start();
  };

  return (
    <View style={s.screen}>
      <FinHeader title="Ledger Book" right={
        <TouchableOpacity onPress={() => router.push('/finance/ledger/new')} hitSlop={8}>
          <Ionicons name="add-circle" size={26} color={FIN.brandDeep} />
        </TouchableOpacity>
      } />

      <View style={s.filterWrap}>
        <Segment<Filter>
          options={[{ k: 'all', label: 'All' }, { k: 'lend', label: 'Lent' }, { k: 'borrow', label: 'Borrowed' }]}
          value={filter} onChange={setFilter}
        />
      </View>

      <ScrollView contentContainerStyle={s.body} showsVerticalScrollIndicator={false}>
        {shown.length === 0 ? (
          <EmptyState icon="book-outline" title="No ledgers yet" sub="Add your first lend or borrow entry to start tracking." />
        ) : shown.map(e => {
          const sc = STATUS_COLORS[e.status];
          const lent = e.direction === 'lend';
          return (
            <TouchableOpacity key={e.id} style={s.card} activeOpacity={0.85}
              onPress={() => router.push({ pathname: '/finance/ledger/[id]', params: { id: e.id } })}
              onLongPress={() => askDelete(e)}
            >
              <View style={[s.avatar, { backgroundColor: lent ? FIN.goodSoft : FIN.badSoft }]}>
                <Ionicons name={lent ? 'arrow-up' : 'arrow-down'} size={16} color={lent ? FIN.good : FIN.bad} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.name} numberOfLines={1}>{e.name}</Text>
                <Text style={s.sub} numberOfLines={1}>
                  {e.rate}{e.rate_mode === 'rupees' ? '₹' : '%'} · {PERIOD_LABEL[e.period]}
                  {e.remaining < e.principal ? ` · ₹${e.remaining.toLocaleString('en-IN')} left` : ''}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 5 }}>
                <Text style={s.amt}>{formatINR(e.principal)}</Text>
                <Pill label={sc.label} fg={sc.fg} bg={sc.bg} />
              </View>
            </TouchableOpacity>
          );
        })}
        {shown.length > 0 && <Text style={s.hint}>Long-press a ledger to delete (30-second undo)</Text>}
        <View style={{ height: 90 }} />
      </ScrollView>

      <TouchableOpacity style={s.fab} activeOpacity={0.9} onPress={() => router.push('/finance/ledger/new')}>
        <Ionicons name="add" size={22} color="#fff" />
        <Text style={s.fabTxt}>Add New Ledger</Text>
      </TouchableOpacity>

      {pendingDelete && (
        <Animated.View style={[s.snack, { opacity: snack, transform: [{ translateY: snack.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) }] }]}>
          <Text style={s.snackTxt}>Ledger deleted</Text>
          <TouchableOpacity onPress={undo} hitSlop={8}><Text style={s.snackBtn}>UNDO</Text></TouchableOpacity>
        </Animated.View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  filterWrap: { paddingHorizontal: 16, paddingTop: 12 },
  body: { padding: 16, paddingTop: 12 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: FIN.card, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: FIN.border },
  avatar: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  name: { color: FIN.text, fontSize: 15, fontWeight: '700' },
  sub: { color: FIN.sub, fontSize: 12.5, marginTop: 2 },
  amt: { color: FIN.text, fontSize: 15, fontWeight: '800' },
  hint: { color: FIN.faint, fontSize: 11.5, textAlign: 'center', marginTop: 8 },

  fab: { position: 'absolute', left: 16, right: 16, bottom: 20, flexDirection: 'row', gap: 8, backgroundColor: FIN.brandDeep, borderRadius: 14, paddingVertical: 15, alignItems: 'center', justifyContent: 'center', shadowColor: FIN.brandDeep, shadowOpacity: 0.35, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 6 },
  fabTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },

  snack: { position: 'absolute', left: 16, right: 16, bottom: 84, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#171320', borderRadius: 12, paddingVertical: 13, paddingHorizontal: 16 },
  snackTxt: { color: '#fff', fontSize: 14, fontWeight: '600' },
  snackBtn: { color: FIN.brand, fontSize: 14, fontWeight: '800', letterSpacing: 0.5 },
});
