// app/finance/ledger/index.tsx — Ledger Book list (All / Lent / Borrowed) with
// status filtering and a 30-second undo-delete snackbar.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFinanceTheme } from '../../../components/finance/useFinanceTheme';
import { View, Text, FlatList, StyleSheet, TouchableOpacity, Animated, Alert, AccessibilityInfo, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { financeStatusColors, TABULAR, FIN_SHADOW, type FinancePalette } from '../../../constants/financeTheme';
import { FinHeader, Segment, Pill, EmptyState, LoadingState, ErrorState } from '../../../components/finance/ui';
import { useLoadStatus } from '../../../components/finance/useLoad';
import { useMe } from '../../../components/finance/useMe';
import { formatINR, PERIOD_LABEL } from '../../../utils/financeFormat';
import { listLedger, deleteLedger, restoreLedger, type LedgerEntry } from '../../../db/ledger';

type Filter = 'all' | 'lend' | 'borrow';

export default function LedgerList() {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const STATUS_COLORS = React.useMemo(() => financeStatusColors(FIN), [FIN]);
  // s.fab/s.snack live in a module-scope StyleSheet, so a literal bottom there
  // would freeze at launch and never follow a rotation. Read the inset from the
  // hook and apply it at the element instead (2026-09-17).
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const me = useMe();
  const [filter, setFilter] = useState<Filter>('all');
  const [rows, setRows] = useState<LedgerEntry[]>([]);
  const [pendingDelete, setPendingDelete] = useState<LedgerEntry | null>(null);
  // The earlier delete a second long-press made final, so the snackbar says so.
  const [madeFinal, setMadeFinal] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const snack = useRef(new Animated.Value(0)).current;

  const pendingRef = useRef<LedgerEntry | null>(null);
  pendingRef.current = pendingDelete;

  const { status, begin, done, fail } = useLoadStatus();
  const reload = useCallback(() => {
    if (!me) return;
    begin();
    // The row whose delete is still in its undo window is not in the book as
    // far as the user knows: opening another ledger and coming back used to
    // show it again under a snackbar saying "Ledger deleted".
    listLedger(me.id)
      .then(r => { const p = pendingRef.current; setRows(p ? r.filter(x => x.id !== p.id) : r); done(); })
      .catch(fail);
  }, [me, begin, done, fail]);
  useFocusEffect(reload);

  const shown = useMemo(
    () => (filter === 'all' ? rows : rows.filter(r => r.direction === filter)),
    [rows, filter],
  );

  const askDelete = (e: LedgerEntry) => {
    // optimistic remove + start the 30s undo window
    setRows(prev => prev.filter(r => r.id !== e.id));
    // COMMIT THE PREVIOUS ONE FIRST (2026-09-17). This used to be a bare
    // clearTimeout, which cancelled the pending finalizeDelete WITHOUT running
    // it — so deleting two entries inside 30s removed both from the list but
    // only ever deleted the second. The first silently came back on the next
    // reload, after the user had been told it was gone. Only ONE delete can be
    // undoable at a time, so the earlier one is committed, not dropped.
    const prev = timer.current && pendingDelete ? pendingDelete : null;
    if (timer.current) { clearTimeout(timer.current); if (pendingDelete) finalizeDelete(pendingDelete.id); }
    setPendingDelete(e);
    setMadeFinal(prev ? prev.name : null);
    Animated.timing(snack, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    timer.current = setTimeout(() => finalizeDelete(e.id), 30000);
    // accessibilityLiveRegion on the snackbar is Android-only; iOS hears it here.
    if (Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibility(`${e.name} deleted. Undo is available for 30 seconds.${prev ? ` Deleting ${prev.name} can no longer be undone.` : ''}`);
    }
  };

  // FLUSH ON THE WAY OUT. The 30s timer dies with the screen, so leaving inside
  // the window abandoned a delete the snackbar had already reported as done —
  // the row reappeared on the next visit. A pending delete is a decision the
  // user already made; unmounting is not an undo.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    const p = pendingRef.current;
    // The screen is gone, so there is nowhere to show a failure; the row simply
    // reappears on the next visit, which is the truthful outcome.
    if (p) deleteLedger(p.id).catch(() => {});
  }, []);
  const finalizeDelete = (id: string) => {
    // A failed delete used to vanish silently while the snackbar said
    // "deleted"; the ledger came back on the next visit with no explanation.
    deleteLedger(id).catch((err: any) => {
      Alert.alert('Could not delete the ledger', `${err?.message ?? 'It is still in your ledger book.'}`);
      reload();
    });
    setPendingDelete(null);
    Animated.timing(snack, { toValue: 0, duration: 180, useNativeDriver: true }).start();
  };
  const undo = () => {
    if (!pendingDelete) return;
    if (timer.current) clearTimeout(timer.current);
    // Cleared first, so the reload below shows the restored row.
    pendingRef.current = null;
    restoreLedger(pendingDelete)
      .catch((err: any) => Alert.alert('Could not undo', err?.message ?? 'The ledger could not be restored.'))
      .finally(reload);
    setPendingDelete(null);
    Animated.timing(snack, { toValue: 0, duration: 180, useNativeDriver: true }).start();
  };

  return (
    <View style={s.screen}>
      <FinHeader title="Ledger Book" right={
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="New ledger" onPress={() => router.push('/finance/ledger/new')} hitSlop={8}>
          <Ionicons name="add-circle" size={26} color={FIN.brandDeep} />
        </TouchableOpacity>
      } />

      <View style={s.filterWrap}>
        <Segment<Filter>
          options={[{ k: 'all', label: 'All' }, { k: 'lend', label: 'Lent' }, { k: 'borrow', label: 'Borrowed' }]}
          value={filter} tabs onChange={setFilter}
        />
      </View>

      <FlatList
        data={status === 'ready' ? shown : []}
        keyExtractor={(e) => e.id}
        contentContainerStyle={s.body}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={status === 'loading' ? (
          <LoadingState label="Loading your ledger book" />
        ) : status === 'error' ? (
          <ErrorState title="Could not load ledgers" sub="Your ledger book could not be read. Nothing has been lost." onRetry={reload} />
        ) : (
          <EmptyState icon="book-outline" title="No ledgers yet" sub="Add your first lend or borrow entry to start tracking." />
        )}
        renderItem={({ item: e }) => {
          const sc = STATUS_COLORS[e.status];
          const lent = e.direction === 'lend';
          return (
            <TouchableOpacity style={s.card} activeOpacity={0.85}
              onPress={() => router.push({ pathname: '/finance/ledger/[id]', params: { id: e.id } })}
              onLongPress={() => askDelete(e)}
              accessibilityRole="button"
              accessibilityLabel={`${e.name}, ${lent ? 'lent' : 'borrowed'} ${formatINR(e.principal)}${e.remaining < e.principal ? `, ${formatINR(e.remaining)} left` : ''}, ${sc.label}. Open ledger`}
              // Long-press is the only delete gesture; screen-reader users get the same action here.
              accessibilityActions={[{ name: 'delete', label: 'Delete, with 30 seconds to undo' }]}
              onAccessibilityAction={(ev) => { if (ev.nativeEvent.actionName === 'delete') askDelete(e); }}
            >
              <View style={[s.avatar, { backgroundColor: lent ? FIN.goodSoft : FIN.badSoft }]}>
                <Ionicons name={lent ? 'arrow-up' : 'arrow-down'} size={16} color={lent ? FIN.good : FIN.bad} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.name} numberOfLines={1}>{e.name}</Text>
                {/* The outstanding balance is the LAST thing on this line, so a
                    single line ellipsised exactly the number a lender opens this
                    screen to read. Two lines: the rate/period can wrap, the money
                    cannot be hidden (2026-09-17). */}
                <Text style={s.sub} numberOfLines={2}>
                  {e.rate}{e.rate_mode === 'rupees' ? '₹' : '%'} · {PERIOD_LABEL[e.period]}
                  {e.remaining < e.principal ? ` · ₹${e.remaining.toLocaleString('en-IN')} left` : ''}
                </Text>
              </View>
              {/* This column had no flex, so at font scale 1.5 it took whatever
                  width the amount wanted and the name column - which DOES carry
                  minWidth: 0 - shrank to a lone "…". Let it shrink, and let the
                  amount scale down inside it instead of starving the name. */}
              <View style={{ alignItems: 'flex-end', gap: 5, flexShrink: 1, minWidth: 0 }}>
                <Text style={s.amt} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{formatINR(e.principal)}</Text>
                <Pill label={sc.label} fg={sc.fg} bg={sc.bg} />
              </View>
            </TouchableOpacity>
          );
        }}
        ListFooterComponent={<>
          {status === 'ready' && shown.length > 0 && <Text style={s.hint}>Long-press a ledger to delete (30-second undo)</Text>}
          <View style={{ height: 90 }} />
        </>}
      />

      <TouchableOpacity style={[s.fab, { bottom: insets.bottom + 20 }]} activeOpacity={0.9} onPress={() => router.push('/finance/ledger/new')}
        accessibilityRole="button" accessibilityLabel="Add new ledger">
        <Ionicons name="add" size={22} color={FIN.onBrand} />
        <Text style={s.fabTxt}>Add New Ledger</Text>
      </TouchableOpacity>

      {pendingDelete && (
        <Animated.View accessibilityLiveRegion="polite" style={[s.snack, { bottom: insets.bottom + 84, opacity: snack, transform: [{ translateY: snack.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) }] }]}>
          <Text style={s.snackTxt}>
            {pendingDelete.name} deleted{madeFinal ? `. Deleting ${madeFinal} is now final` : ''}
          </Text>
          <TouchableOpacity onPress={undo} style={s.snackAct} accessibilityRole="button" accessibilityLabel={`Undo deleting ${pendingDelete.name}`}><Text style={s.snackBtn}>UNDO</Text></TouchableOpacity>
        </Animated.View>
      )}
    </View>
  );
}

const makeStyles = (FIN: FinancePalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  filterWrap: { paddingHorizontal: 16, paddingTop: 12, alignSelf: 'center', width: '100%', maxWidth: FIN.contentMax },
  body: { padding: 16, paddingTop: 12, alignSelf: 'center', width: '100%', maxWidth: FIN.contentMax },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: FIN.card, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: FIN.glassEdge, ...FIN_SHADOW.rest },
  avatar: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  name: { color: FIN.text, fontSize: 15, fontWeight: '700' },
  sub: { color: FIN.sub, fontSize: 12.5, marginTop: 2 },
  amt: { color: FIN.text, fontSize: 15, fontWeight: '800', ...TABULAR },
  hint: { color: FIN.faint, fontSize: 11.5, textAlign: 'center', marginTop: 8 },

  fab: { position: 'absolute', left: 16, right: 16, bottom: 20, flexDirection: 'row', gap: 8, backgroundColor: FIN.brandDeep, borderRadius: 14, paddingVertical: 15, alignItems: 'center', justifyContent: 'center', shadowColor: FIN.brandDeep, shadowOpacity: 0.35, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 6 },
  fabTxt: { color: FIN.onBrand, fontSize: 15, fontWeight: '800' },

  snack: { position: 'absolute', left: 16, right: 16, bottom: 84, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, backgroundColor: FIN.text, borderRadius: 12, paddingVertical: 4, paddingLeft: 16, paddingRight: 4 },
  snackTxt: { flex: 1, color: FIN.cardSolid, fontSize: 14, fontWeight: '600', paddingVertical: 9 },
  // A 44dp target of its own, like the other finance controls.
  snackAct: { minWidth: 44, minHeight: 44, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  snackBtn: { color: FIN.cardSolid, fontSize: 14, fontWeight: '800', letterSpacing: 0.5 },
});
