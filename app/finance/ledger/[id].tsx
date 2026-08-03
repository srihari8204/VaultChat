// app/finance/ledger/[id].tsx — Ledger detail: computed totals, actions, timeline.

import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { FIN, STATUS_COLORS } from '../../../constants/financeTheme';
import { FinHeader, Card, HeroCard, RowLine, Pill } from '../../../components/finance/ui';
import { formatINR, fmtDate, fmtDateTime, PERIOD_LABEL } from '../../../utils/financeFormat';
import { getLedger, deleteLedger, type LedgerEntry } from '../../../db/ledger';
import { listTimeline, type TimelineRow } from '../../../db/financeTimeline';
import { simpleInterest, compoundInterest, round2 } from '../../../utils/interest';
import { periodRateToAnnualPct } from '../../../utils/finance';
import { sharePdf, pdfDocument, kvTable } from '../../../utils/financeIO';

function computeInterest(e: LedgerEntry) {
  const annual = periodRateToAnnualPct(e.rate, e.rate_mode, e.period);
  const years = e.end_date ? Math.max(0, (e.end_date - e.start_date) / 31536000000) : 1;
  const res = e.interest_type === 'simple'
    ? simpleInterest(e.principal, annual, years)
    : compoundInterest(e.principal, annual, years, 1);
  return { interest: round2(res.interest), total: round2(res.total), years, annual };
}

export default function LedgerDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [e, setE] = useState<LedgerEntry | null>(null);
  const [tl, setTl] = useState<TimelineRow[]>([]);

  const reload = useCallback(() => {
    if (!id) return;
    getLedger(id).then(setE).catch(() => {});
    listTimeline('ledger', id).then(setTl).catch(() => {});
  }, [id]);
  useFocusEffect(reload);

  if (!e) return <View style={s.screen}><FinHeader title="Ledger" /></View>;

  const c = computeInterest(e);
  const sc = STATUS_COLORS[e.status];
  const lent = e.direction === 'lend';

  const onShare = async () => {
    const html = pdfDocument(`${lent ? 'Lent to' : 'Borrowed from'} ${e.name}`, kvTable([
      { k: 'Direction', v: lent ? 'Lent' : 'Borrowed' },
      { k: 'Mobile', v: e.mobile ?? '—' },
      { k: 'Principal', v: formatINR(e.principal) },
      { k: 'Interest type', v: e.interest_type === 'simple' ? 'Simple' : 'Compound' },
      { k: 'Rate', v: `${e.rate}${e.rate_mode === 'rupees' ? '₹ per ₹100' : '%'} ${PERIOD_LABEL[e.period]}` },
      { k: 'Interest', v: formatINR(c.interest) },
      { k: 'Total amount', v: formatINR(c.total), tot: true },
      { k: 'Remaining', v: formatINR(e.remaining) },
      { k: 'Start date', v: fmtDate(e.start_date) },
      { k: 'End date', v: e.end_date ? fmtDate(e.end_date) : '—' },
    ]));
    try { await sharePdf(html, `ledger-${e.name}`); } catch (err: any) { Alert.alert('Share failed', err?.message ?? 'Try again'); }
  };

  const onDelete = () => Alert.alert('Delete ledger?', `Delete ${e.name}? This cannot be undone here.`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => deleteLedger(e.id).then(() => router.back()) },
  ]);

  return (
    <View style={s.screen}>
      <FinHeader title="Ledger Details" right={
        <>
          <TouchableOpacity onPress={() => router.push({ pathname: '/finance/ledger/edit', params: { id: e.id } })} hitSlop={8}><Ionicons name="create-outline" size={22} color={FIN.text} /></TouchableOpacity>
          <TouchableOpacity onPress={onShare} hitSlop={8}><Ionicons name="share-outline" size={22} color={FIN.text} /></TouchableOpacity>
        </>
      } />
      <ScrollView contentContainerStyle={s.body} showsVerticalScrollIndicator={false}>
        {/* Contact */}
        <View style={s.contactRow}>
          <View style={[s.avatar, { backgroundColor: lent ? FIN.goodSoft : FIN.badSoft }]}>
            <Ionicons name={lent ? 'arrow-up' : 'arrow-down'} size={20} color={lent ? FIN.good : FIN.bad} />
          </View>
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={0.7}
            onPress={() => router.push({ pathname: '/finance/customer', params: { name: e.name } })}>
            <Text style={s.name}>{e.name}</Text>
            <Text style={s.mobile}>{e.mobile ? `${e.mobile} · ` : ''}View profile ›</Text>
          </TouchableOpacity>
          <Pill label={sc.label} fg={sc.fg} bg={sc.bg} />
        </View>

        <HeroCard colors={lent ? [FIN.good, '#0f7a38'] : [FIN.bad, '#991b1b']}>
          <Text style={s.heroLabel}>{lent ? 'LENT AMOUNT (P + I)' : 'BORROWED AMOUNT (P + I)'}</Text>
          <Text style={s.heroVal}>{formatINR(c.total)}</Text>
          <Text style={s.heroSub}>Principal {formatINR(e.principal)} · Interest {formatINR(c.interest)}</Text>
        </HeroCard>

        <Card style={{ marginTop: 12 }}>
          <RowLine k="Principal amount" v={formatINR(e.principal)} />
          <RowLine k="Interest type" v={e.interest_type === 'simple' ? 'Simple' : 'Compound'} />
          <RowLine k="Rate" v={`${e.rate}${e.rate_mode === 'rupees' ? '₹/₹100' : '%'} · ${PERIOD_LABEL[e.period]}`} />
          <RowLine k="Interest amount" v={formatINR(c.interest)} />
          <RowLine k="Total amount" v={formatINR(c.total)} bold />
          <RowLine k="Remaining" v={formatINR(e.remaining)} bold tone={e.remaining > 0 ? 'warn' : 'good'} />
          <RowLine k="Start date" v={fmtDate(e.start_date)} />
          <RowLine k="End date" v={e.end_date ? fmtDate(e.end_date) : '—'} />
          <RowLine k="Last updated" v={fmtDateTime(e.last_updated)} />
        </Card>

        {e.notes ? <Card style={{ marginTop: 12 }}><Text style={s.notesLabel}>Notes</Text><Text style={s.notes}>{e.notes}</Text></Card> : null}

        {/* Actions */}
        <View style={s.actions}>
          <Action icon="cash-outline" label="Update" onPress={() => router.push({ pathname: '/finance/ledger/update', params: { id: e.id } })} primary />
          <Action icon="notifications-outline" label="Remind" onPress={() => router.push({ pathname: '/finance/reminders', params: { refType: 'ledger', refId: e.id, title: `${e.name} — payment` } })} />
          <Action icon="share-outline" label="PDF" onPress={onShare} />
          <Action icon="trash-outline" label="Delete" onPress={onDelete} danger />
        </View>

        {/* Timeline */}
        <Text style={s.section}>Timeline</Text>
        {tl.length === 0 ? (
          <Text style={s.tlEmpty}>No events yet.</Text>
        ) : (
          <View style={s.tl}>
            {tl.map((row, i) => (
              <View key={row.id} style={s.tlRow}>
                <View style={s.tlDotWrap}>
                  <View style={s.tlDot} />
                  {i < tl.length - 1 && <View style={s.tlStem} />}
                </View>
                <View style={{ flex: 1, paddingBottom: 14 }}>
                  <Text style={s.tlKind}>{tlLabel(row.kind)}</Text>
                  <Text style={s.tlDetail}>{row.detail}</Text>
                  <Text style={s.tlTime}>{fmtDateTime(row.at)}</Text>
                </View>
              </View>
            ))}
          </View>
        )}
        <View style={{ height: 30 }} />
      </ScrollView>
    </View>
  );
}

function tlLabel(k: TimelineRow['kind']): string {
  return { created: 'Ledger created', update: 'Amount updated', reminder: 'Reminder added', edit: 'Details edited', note: 'Note updated' }[k] ?? k;
}

function Action({ icon, label, onPress, primary, danger }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void; primary?: boolean; danger?: boolean }) {
  const color = danger ? FIN.bad : primary ? FIN.brandDeep : FIN.text;
  const bg = danger ? FIN.badSoft : primary ? FIN.brandSoft : FIN.card;
  return (
    <TouchableOpacity style={[s.action, { backgroundColor: bg }]} onPress={onPress} activeOpacity={0.85}>
      <Ionicons name={icon} size={20} color={color} />
      <Text style={[s.actionLbl, { color }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  body: { padding: 16 },
  contactRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 },
  avatar: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  name: { color: FIN.text, fontSize: 18, fontWeight: '800' },
  mobile: { color: FIN.sub, fontSize: 13, marginTop: 1 },

  heroLabel: { color: 'rgba(255,255,255,0.85)', fontSize: 10.5, fontWeight: '700', letterSpacing: 0.8 },
  heroVal: { color: '#fff', fontSize: 30, fontWeight: '800', marginTop: 6 },
  heroSub: { color: 'rgba(255,255,255,0.9)', fontSize: 12.5, marginTop: 6 },

  notesLabel: { color: FIN.sub, fontSize: 12, fontWeight: '700', marginBottom: 4 },
  notes: { color: FIN.text, fontSize: 14, lineHeight: 20 },

  actions: { flexDirection: 'row', gap: 8, marginTop: 16 },
  action: { flex: 1, alignItems: 'center', gap: 5, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: FIN.border },
  actionLbl: { fontSize: 11.5, fontWeight: '700' },

  section: { color: FIN.text, fontSize: 16, fontWeight: '800', marginTop: 22, marginBottom: 12 },
  tlEmpty: { color: FIN.sub, fontSize: 13 },
  tl: { paddingLeft: 2 },
  tlRow: { flexDirection: 'row', gap: 12 },
  tlDotWrap: { alignItems: 'center', width: 14 },
  tlDot: { width: 11, height: 11, borderRadius: 6, backgroundColor: FIN.brand, borderWidth: 2, borderColor: FIN.card, marginTop: 3 },
  tlStem: { flex: 1, width: 2, backgroundColor: FIN.line, marginTop: 2 },
  tlKind: { color: FIN.text, fontSize: 13.5, fontWeight: '700' },
  tlDetail: { color: FIN.sub, fontSize: 12.5, marginTop: 2 },
  tlTime: { color: FIN.faint, fontSize: 11, marginTop: 3 },
});
