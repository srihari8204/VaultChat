// components/shopbook/returns.tsx — Shop Book: the owner's returns list and decline modal.
// Moved out of components/shopbook/orders.tsx unchanged (round 7 split).
// Palette and styles come from ./theme.

import { useState } from 'react';
import { KeyboardSafe } from '../ui';
import { View, Text, TextInput, TouchableOpacity, ScrollView, FlatList, Alert, RefreshControl, Modal } from 'react-native';
import { formatMoney } from '../../utils/shopbook';
import * as SB from '../../services/shopBookService';
import { ErrorState } from '../finance/ui';
import { C, s } from './theme';
import { SubHeader, Empty } from './shared';
import { useShopLoad } from './useShopLoad';
import { userErrorText } from '../../lib/userErrorText';

// Returns (P1-B). The owner decides; approval issues a credit note and puts
// sellable goods back. Refusing requires saying why.
export function ReturnsScreen({ currency, onBack }: { currency?: string; onBack: () => void }) {
  const [rows, setRows] = useState<SB.ShopReturn[]>([]);
  const [busy, setBusy] = useState(false);
  const [refuse, setRefuse] = useState<SB.ShopReturn | null>(null);
  const [note, setNote] = useState('');

  const { loading, err, load } = useShopLoad(SB.shopReturns, setRows);

  const money = (n: number) => formatMoney(n, currency);

  const approve = (rt: SB.ShopReturn) => {
    Alert.alert('Approve this return?',
      `${money(rt.refundTotal)} will be credited to ${rt.customerName || 'the customer'}, and a credit note issued against the original invoice.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Approve · goods resellable',
          onPress: () => void decide(rt, true, true),
        },
        {
          text: 'Approve · goods damaged',
          onPress: () => void decide(rt, true, false),
        },
      ]);
  };

  const decide = async (rt: SB.ShopReturn, ok: boolean, restock = true, why = '') => {
    setBusy(true);
    try {
      await SB.decideReturn(rt.id, ok, { restock, note: why, settlement: 'credit' });
      setRefuse(null); setNote(''); load();
    } catch (e) { Alert.alert('Could not record', userErrorText(e, 'Try again')); }
    finally { setBusy(false); }
  };

  // Left a plain function rather than useCallback: it closes over `approve`,
  // which is rebuilt on every render anyway, so memoising here would only risk
  // handing a row a stale one.
  const renderReturn = ({ item: rt }: { item: SB.ShopReturn }) => (
          <View style={s.card}>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>{rt.customerName || 'Customer'} · {money(rt.refundTotal)}</Text>
              <Text style={s.cardSub}>📝 {rt.reason}</Text>
              {!!rt.decisionNote && <Text style={s.cardSub}>↳ {rt.decisionNote}</Text>}
              <Text style={[s.cardSub, {
                color: rt.status === 'completed' ? C.green : rt.status === 'rejected' ? C.danger : C.sub,
              }]}>
                {rt.status === 'requested' ? 'Awaiting your decision' : rt.status}
              </Text>
              {rt.status === 'requested' && (
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                  <TouchableOpacity style={[s.primaryBtn, { flex: 1, marginTop: 0 }]}
                    accessibilityRole="button" accessibilityLabel={`Approve the return from ${rt.customerName || 'the customer'}`}
                    accessibilityState={{ disabled: busy }}
                    disabled={busy} onPress={() => approve(rt)}>
                    <Text style={s.primaryBtnText}>Approve</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[s.dangerBtn, { flex: 1, marginTop: 0 }]}
                    accessibilityRole="button" accessibilityLabel={`Decline the return from ${rt.customerName || 'the customer'}`}
                    accessibilityState={{ disabled: busy }}
                    disabled={busy} onPress={() => { setRefuse(rt); setNote(''); }}>
                    <Text style={s.dangerBtnText}>Decline</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </View>
  );

  return (
    <>
      <SubHeader title="Returns" onBack={onBack} />
      <Modal visible={!!refuse} transparent animationType="fade" onRequestClose={() => setRefuse(null)}>
        {/* KeyboardSafe + scroller (2026-09-18): see the suggest-alternative
            modal in ./orderDetail — a <Modal> never gets the activity's adjustResize. */}
        <KeyboardSafe keyboardOnly style={s.modalWrap}>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={s.modalScroll} keyboardShouldPersistTaps="handled">
          <View style={s.modalCard}>
            <Text style={s.modalTitle} accessibilityRole="header">Why are you declining?</Text>
            <Text style={s.hint}>The customer sees this. A refusal with no reason is the most complained-about outcome of any returns process.</Text>
            <TextInput style={s.input} placeholder="e.g. Item shows use beyond inspection"
              accessibilityLabel="Reason for declining"
              placeholderTextColor={C.sub} value={note} onChangeText={setNote} autoFocus multiline />
            {/* Disabled, not a silent no-op, until there is a reason to send. */}
            <TouchableOpacity style={[s.dangerBtn, (busy || !note.trim()) && { opacity: 0.5 }]}
              disabled={busy || !note.trim()}
              accessibilityRole="button" accessibilityState={{ disabled: busy || !note.trim(), busy }}
              onPress={() => { if (note.trim() && refuse) void decide(refuse, false, true, note.trim()); }}>
              <Text style={s.dangerBtnText}>Decline return</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.outlineBtn} onPress={() => setRefuse(null)} accessibilityRole="button">
              <Text style={s.outlineBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
          </ScrollView>
        </KeyboardSafe>
      </Modal>

      <FlatList
        data={rows}
        keyExtractor={(rt) => rt.id}
        renderItem={renderReturn}
        ListHeaderComponent={
          loading ? null
            : err ? <ErrorState title="Couldn’t load returns" sub={err} onRetry={load} />
            : rows.length === 0 ? <Empty icon="arrow-undo-outline" text="No returns." /> : null
        }
        contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}
      />
    </>
  );
}
