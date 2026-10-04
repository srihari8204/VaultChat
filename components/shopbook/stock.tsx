// components/shopbook/stock.tsx — Shop Book: the owner's stock position and
// stock adjustments with a reason. Moved out of components/shopbook/products.tsx
// on 2026-10-04 (round 5) to keep that file a reviewable size; no behaviour
// changed in the move.

import { useRef, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, Alert, ActivityIndicator, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { formatMoney, isNum, num } from '../../utils/shopbook';
import * as SB from '../../services/shopBookService';
import { LoadingState, ErrorState } from '../finance/ui';
import { C, s } from './theme';
import { loadErrText, SubHeader, Chip, StatCard, Field, Empty } from './shared';
import { useShopLoad } from './useShopLoad';
import { userErrorText } from '../../lib/userErrorText';

// Stock (P0-B). Deliberately one screen: the position, and the one action that
// changes it. Every change needs a reason, because the movement ledger is only
// worth keeping if it answers "where did 8 kg go?".
export function StockScreen({ currency, onBack }: { currency?: string; onBack: () => void }) {
  const [rows, setRows] = useState<SB.StockRow[]>([]);
  const [lowCount, setLowCount] = useState(0);
  const [sel, setSel] = useState<SB.StockRow | null>(null);
  const [kind, setKind] = useState<SB.StockMoveKind>('purchase');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<SB.StockMovement[]>([]);
  // "No movements yet" is a claim about the ledger; a failed read is not it.
  const [historyErr, setHistoryErr] = useState('');

  const { loading, err, load } = useShopLoad(SB.stockList, (r) => { setRows(r.stock); setLowCount(r.lowCount); });

  // The item whose history is wanted NOW. Opening A then B quickly could let
  // A's slower answer land under B's heading; a reply for any other item is
  // dropped.
  const historyFor = useRef<string | null>(null);
  const loadHistory = async (productId: string) => {
    historyFor.current = productId;
    setHistoryErr('');
    try {
      const list = await SB.stockMovements(productId);
      if (historyFor.current === productId) setHistory(list);
    } catch (e) { if (historyFor.current === productId) setHistoryErr(loadErrText(e)); }
  };
  const openItem = async (row: SB.StockRow) => {
    setSel(row); setQty(''); setReason(''); setKind('purchase'); setHistory([]);
    await loadHistory(row.productId);
  };

  const submit = async () => {
    if (!sel) return;
    // Three different problems, three different messages (2026-09-17). This
    // screen had NO isNum gate at all: num() coerced "12,5" to 0 and the single
    // `q === 0` branch then told the owner to "Enter a quantity" about a box
    // with digits already in it, so retyping the same thing got the same
    // refusal forever. Negatives stay legal — this is the one screen that means
    // them, and a correction of -3 is the whole point of the Correction kind.
    if (!qty.trim()) { Alert.alert('Enter a quantity'); return; }
    if (!isNum(qty)) {
      Alert.alert('Check the quantity',
        `"${qty.trim()}" is not a plain number. Use digits only — 1200 or 1,200 both work, and -3 is a valid correction.`);
      return;
    }
    const q = num(qty);
    if (q === 0) { Alert.alert('Enter a quantity', 'A movement of 0 would not change the stock.'); return; }
    if (!reason.trim()) { Alert.alert('Reason required', 'Stock never changes silently.'); return; }
    setBusy(true);
    try {
      await SB.adjustStock(sel.productId, kind, q, reason.trim());
      setSel(null); load();
    } catch (e) { Alert.alert('Could not record', userErrorText(e, 'Try again')); }
    finally { setBusy(false); }
  };

  const KINDS: { k: SB.StockMoveKind; label: string }[] = [
    { k: 'purchase', label: 'Stock in' },
    { k: 'opening', label: 'Opening' },
    { k: 'damage', label: 'Damaged' },
    { k: 'return', label: 'Returned' },
    { k: 'adjustment', label: 'Correction' },
  ];

  const renderMovement = ({ item: m }: { item: SB.StockMovement }) => {
    const d = m.onHandDelta || m.reservedDelta;
    return (
              <View style={s.card}>
                <View style={{ flex: 1 }}>
                  <Text style={s.cardTitle}>{m.kind.replace(/_/g, ' ')}</Text>
                  <Text style={s.cardSub}>
                    {[m.reason, m.actor].filter(Boolean).join(' · ')}
                  </Text>
                </View>
                <Text style={[s.price, { color: d < 0 ? C.danger : C.green }]}>
                  {d > 0 ? '+' : ''}{d}{m.reservedDelta && !m.onHandDelta ? ' held' : ''}
                </Text>
              </View>
    );
  };

  const renderStockRow = ({ item: row }: { item: SB.StockRow }) => (
          <TouchableOpacity style={s.card} onPress={() => openItem(row)} accessibilityRole="button"
            accessibilityLabel={`${row.name}, ${row.available} available${row.reserved > 0 ? `, ${row.reserved} reserved` : ''}${row.low ? ', low stock' : ''}`}>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>{row.name}{row.unit ? ` · ${row.unit}` : ''}</Text>
              <Text style={s.cardSub}>
                {row.available} available{row.reserved > 0 ? ` · ${row.reserved} reserved` : ''}
                {row.costPrice > 0 ? ` · cost ${formatMoney(row.costPrice, currency)}` : ''}
              </Text>
            </View>
            {row.low && <Text style={[s.price, { color: C.danger }]}>LOW</Text>}
            <Ionicons name="chevron-forward" size={18} color={C.sub} />
          </TouchableOpacity>
  );

  if (sel) {
    return (
      <>
        <SubHeader title={sel.name} onBack={() => { historyFor.current = null; setSel(null); }} />
        <FlatList
          // Movements are append-only, so the history is the scroller and the
          // position + record form ride above it. An element, not a component
          // function, or the quantity box remounts as it is typed into.
          data={history}
          keyExtractor={(m) => String(m.id)}
          renderItem={renderMovement}
          contentContainerStyle={s.body}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={(
          <>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <StatCard label="On hand" value={String(sel.onHand)} tone="navy" />
            <StatCard label="Reserved" value={String(sel.reserved)} tone="amber" />
            <StatCard label="Available" value={String(sel.available)} tone={sel.low ? 'danger' : 'green'} />
          </View>
          <View style={s.panel}>
            <Text style={s.panelTitle}>Record a movement</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
              {KINDS.map((k) => (
                <Chip key={k.k} label={k.label} icon="cube-outline"
                  active={kind === k.k} onPress={() => setKind(k.k)} />
              ))}
            </View>
            <Field label={`Quantity (${sel.unit || 'units'})`} value={qty} onChange={setQty}
              placeholder={kind === 'adjustment' ? '-2 or 5' : '10'} keyboardType="numeric" />
            <Field label="Reason" value={reason} onChange={setReason}
              placeholder={kind === 'damage' ? 'Dropped a crate' : 'Supplier delivery'} />
            <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={submit}
              accessibilityRole="button" accessibilityLabel="Record the movement" accessibilityState={{ disabled: busy, busy }}>
              {busy ? <ActivityIndicator color={C.onFill} /> : <Text style={s.primaryBtnText}>Record</Text>}
            </TouchableOpacity>
          </View>
          <Text style={s.sectionLabel}>History</Text>
          {!!historyErr && <ErrorState title="Couldn’t load the history" sub={historyErr} onRetry={() => loadHistory(sel.productId)} />}
          {!historyErr && history.length === 0 && <Empty icon="time-outline" text="No movements yet." />}
          </>
          )}
        />
      </>
    );
  }

  return (
    <>
      <SubHeader title="Stock" onBack={onBack} />
      <FlatList
        data={rows}
        keyExtractor={(row) => row.productId}
        renderItem={renderStockRow}
        ListHeaderComponent={(
          <>
            {lowCount > 0 && (
              <Text style={[s.hint, { color: C.danger }]}>
                ⚠️ {lowCount} product(s) at or below their reorder level.
              </Text>
            )}
            {loading && <LoadingState />}
            {!!err && !loading && <ErrorState title="Couldn’t load stock" sub={err} onRetry={load} />}
            {!loading && !err && rows.length === 0 && (
              <Empty icon="cube-outline" text="No counted products. Turn on “Count stock” on a product to start." />
            )}
          </>
        )}
        contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}
      />
    </>
  );
}
