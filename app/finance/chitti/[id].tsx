// app/finance/chitti/[id].tsx — Lucky Draw group detail: Members + manual Collections.
// Members carry name, mobile (validated) and address. Local-only — see db/chitti.ts.

import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { FIN, TABULAR } from '../../../constants/financeTheme';
import { FinHeader, HeroCard, Segment, StatTile, Field, Btn, Label, Card } from '../../../components/finance/ui';
import { inrShort, fmtDate, fmtDateTime, num } from '../../../utils/financeFormat';
import { formatINR } from '../../../utils/interest';
import {
  getGroup, deleteGroup, insertMember, updateMember, listMembers, deleteMember, normalizeMobile,
  markCollection, listCollections, recordAuction, listAuctions, deleteAuction,
  type ChittiGroup, type ChittiMember, type ChittiCollection, type CollectionStatus, type ChittiAuction,
} from '../../../db/chitti';
import { listTimeline, type TimelineRow } from '../../../db/financeTimeline';
import { splitEvenly } from '../../../utils/money';

type Tab = 'members' | 'collections' | 'auctions' | 'history';
const CYCLE: CollectionStatus[] = ['pending', 'paid', 'overdue'];
const COL_META: Record<CollectionStatus, { fg: string; bg: string; label: string; icon: keyof typeof Ionicons.glyphMap }> = {
  paid:    { fg: FIN.good, bg: FIN.goodSoft, label: 'Paid',    icon: 'checkmark-circle' },
  pending: { fg: FIN.warn, bg: FIN.warnSoft, label: 'Pending', icon: 'ellipse-outline' },
  overdue: { fg: FIN.bad,  bg: FIN.badSoft,  label: 'Overdue', icon: 'alert-circle' },
};

export default function ChittiDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [g, setG] = useState<ChittiGroup | null>(null);
  const [tab, setTab] = useState<Tab>('members');
  const [members, setMembers] = useState<ChittiMember[]>([]);
  const [collections, setCollections] = useState<ChittiCollection[]>([]);
  const [auctions, setAuctions] = useState<ChittiAuction[]>([]);
  const [timeline, setTimeline] = useState<TimelineRow[]>([]);
  const [month, setMonth] = useState(1);

  // member add/edit form — one card serves both, keyed by editingId
  const [showMemberForm, setShowMemberForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [mName, setMName] = useState('');
  const [mPhone, setMPhone] = useState('');
  const [mAddress, setMAddress] = useState('');

  // auction form
  const [winnerId, setWinnerId] = useState<string | null>(null);
  const [bid, setBid] = useState('');
  const [commission, setCommission] = useState('');

  const reload = useCallback(() => {
    if (!id) return;
    getGroup(id).then(setG);
    listMembers(id).then(setMembers);
    listCollections(id).then(setCollections);
    listAuctions(id).then(setAuctions);
    listTimeline('chitti', id).then(setTimeline).catch(() => {});
  }, [id]);
  useFocusEffect(reload);

  const statusFor = useCallback(
    (memberId: string): CollectionStatus => collections.find(c => c.member_id === memberId && c.month === month)?.status ?? 'pending',
    [collections, month],
  );

  const paidThisMonth = useMemo(
    () => members.filter(m => statusFor(m.id) === 'paid').length,
    [members, statusFor],
  );

  if (!g) return <View style={s.screen}><FinHeader title="Lucky Draw Group" /></View>;

  const openAddMember = () => {
    setEditingId(null); setMName(''); setMPhone(''); setMAddress('');
    setShowMemberForm(true);
  };
  const openEditMember = (m: ChittiMember) => {
    setEditingId(m.id); setMName(m.name); setMPhone(m.phone ?? ''); setMAddress(m.address ?? '');
    setShowMemberForm(true);
  };
  const closeMemberForm = () => setShowMemberForm(false);

  const saveMember = async () => {
    const name = mName.trim();
    if (!name) return Alert.alert('Name', 'Enter the member’s name.');
    let phone: string | null = null;
    if (mPhone.trim()) {
      const norm = normalizeMobile(mPhone);
      if (!norm) return Alert.alert('Mobile number', 'Enter a valid 10-digit mobile number.');
      phone = norm;
    }
    const address = mAddress.trim() || null;
    if (editingId) {
      await updateMember(editingId, { name, phone, address });
    } else {
      await insertMember({ group_id: g.id, name, phone, address, number: members.length + 1 });
    }
    setShowMemberForm(false);
    reload();
  };

  const cycleStatus = async (m: ChittiMember) => {
    const cur = statusFor(m.id);
    const next = CYCLE[(CYCLE.indexOf(cur) + 1) % CYCLE.length];
    await markCollection(g.id, m.id, month, g.installment, next);
    reload();
  };

  const submitAuction = async () => {
    const b = num(bid), c = num(commission) || 0;
    if (!winnerId) return Alert.alert('Winner', 'Select the winning member.');
    if (!(b > 0)) return Alert.alert('Winning bid', 'Enter the winning bid amount.');
    const winner = members.find(m => m.id === winnerId);
    await recordAuction(g, month, winnerId, winner?.name ?? '—', b, c);
    setBid(''); setCommission(''); setWinnerId(null);
    reload();
  };
  // Mirrors recordAuction exactly, so the preview can never promise a number
  // the recorded auction won't produce.
  const previewSplit = () => {
    const b = num(bid), c = num(commission) || 0;
    if (!(b > 0)) return { each: 0, remainder: 0, remainderPaise: 0 };
    return splitEvenly(Math.max(0, b - c), g.members || 1);
  };

  const onDelete = () => Alert.alert('Delete group?', `Delete ${g.name} with its members, dues, auctions and history? This cannot be undone.`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => deleteGroup(g.id).then(() => router.back()) },
  ]);

  const nextAuction = g.start_date + (month) * 30 * 86400000;

  return (
    <View style={s.screen}>
      <FinHeader title={g.name} right={
        <>
          {/* Reuses the existing finance reminders flow (local notifications)
              via its refType/refId/title prefill — no separate scheduler. */}
          <TouchableOpacity
            onPress={() => router.push({
              pathname: '/finance/reminders',
              params: { refType: 'chitti', refId: g.id, title: `${g.name} — collection due` },
            })}
            hitSlop={8}
          >
            <Ionicons name="notifications-outline" size={20} color={FIN.brandDeep} />
          </TouchableOpacity>
          <TouchableOpacity onPress={onDelete} hitSlop={8}><Ionicons name="trash-outline" size={20} color={FIN.bad} /></TouchableOpacity>
        </>
      } />
      <ScrollView contentContainerStyle={s.body} showsVerticalScrollIndicator={false}>
        <HeroCard>
          <Text style={s.heroLabel}>CHIT VALUE</Text>
          <Text style={s.heroVal}>{inrShort(g.chit_value)}</Text>
          <View style={s.heroFoot}>
            <Text style={s.heroFootTxt}>Installment {inrShort(g.installment)}</Text>
            <Text style={s.heroFootTxt}>Next auction {fmtDate(nextAuction)}</Text>
          </View>
        </HeroCard>

        <View style={s.tileRow}>
          <StatTile value={String(members.length)} label={`of ${g.members} members`} tone="brand" />
          <StatTile value={String(paidThisMonth)} label="Paid this month" tone="good" />
          <StatTile value={String(members.length - paidThisMonth)} label="Pending" tone="warn" />
        </View>

        <View style={{ marginTop: 16 }}>
          <Segment<Tab> options={[{ k: 'members', label: 'Members' }, { k: 'collections', label: 'Dues' }, { k: 'auctions', label: 'Auctions' }, { k: 'history', label: 'History' }]} value={tab} onChange={setTab} small />
        </View>

        {tab === 'members' ? (
          <>
            {/* @members */}
            {showMemberForm ? (
              <Card style={{ marginTop: 16 }}>
                <Label>Name</Label>
                <Field value={mName} onChangeText={setMName} placeholder="Member's full name" />
                <Label hint="(optional)">Mobile Number</Label>
                <Field value={mPhone} onChangeText={setMPhone} placeholder="e.g. 98765 43210" keyboardType="phone-pad" />
                <Label hint="(optional)">Address</Label>
                <Field value={mAddress} onChangeText={setMAddress} placeholder="Door no., street, area, city" multiline />
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
                  <Btn label="Cancel" kind="ghost" onPress={closeMemberForm} wide />
                  <Btn label={editingId ? 'Save Changes' : 'Add Member'} icon="checkmark" onPress={saveMember} wide />
                </View>
              </Card>
            ) : (
              <TouchableOpacity style={s.addRow} onPress={openAddMember} activeOpacity={0.85}>
                <View style={s.addBtn}><Ionicons name="add" size={20} color="#fff" /></View>
                <Text style={s.addRowTxt}>Add member</Text>
              </TouchableOpacity>
            )}
            {members.length === 0 ? <Text style={s.empty}>No members yet — add them above.</Text> : members.map(m => (
              <TouchableOpacity key={m.id} style={s.memRow} activeOpacity={0.85} onPress={() => openEditMember(m)}>
                <View style={s.memNum}><Text style={s.memNumTxt}>{m.number}</Text></View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.memName} numberOfLines={1}>{m.name}</Text>
                  {(m.phone || m.address) && (
                    <Text style={s.memSub} numberOfLines={1}>
                      {[m.phone, m.address].filter(Boolean).join(' · ')}
                    </Text>
                  )}
                </View>
                <TouchableOpacity onPress={() => deleteMember(m.id).then(reload)} hitSlop={8}>
                  <Ionicons name="close" size={16} color={FIN.faint} />
                </TouchableOpacity>
              </TouchableOpacity>
            ))}
          </>
        ) : tab === 'collections' ? (
          <>
            {/* Month selector */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.monthRow}>
              {Array.from({ length: g.duration }, (_, i) => i + 1).map(mn => (
                <TouchableOpacity key={mn} style={[s.monthChip, month === mn && s.monthChipOn]} onPress={() => setMonth(mn)}>
                  <Text style={[s.monthTxt, month === mn && { color: '#fff' }]}>M{mn}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            {members.length === 0 ? <Text style={s.empty}>Add members first to record collections.</Text> : members.map(m => {
              const st = statusFor(m.id);
              const meta = COL_META[st];
              return (
                <TouchableOpacity key={m.id} style={s.memRow} activeOpacity={0.85} onPress={() => cycleStatus(m)}>
                  <View style={s.memNum}><Text style={s.memNumTxt}>{m.number}</Text></View>
                  <Text style={[s.memName, { flex: 1 }]} numberOfLines={1}>{m.name}</Text>
                  <View style={[s.colPill, { backgroundColor: meta.bg }]}>
                    <Ionicons name={meta.icon} size={13} color={meta.fg} />
                    <Text style={[s.colTxt, { color: meta.fg }]}>{meta.label}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
            {members.length > 0 && <Text style={s.hint}>Tap a row to cycle Pending → Paid → Overdue</Text>}
          </>
        ) : tab === 'auctions' ? (
          <>
            {/* @auctions */}
            {members.length === 0 ? <Text style={s.empty}>Add members first to record auctions.</Text> : (
              <View style={s.auctionForm}>
                <Text style={s.formLabel}>Record auction · Month {month}</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.monthRow}>
                  {Array.from({ length: g.duration }, (_, i) => i + 1).map(mn => (
                    <TouchableOpacity key={mn} style={[s.monthChip, month === mn && s.monthChipOn]} onPress={() => setMonth(mn)}>
                      <Text style={[s.monthTxt, month === mn && { color: '#fff' }]}>M{mn}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
                <Text style={s.formLabel}>Winner</Text>
                <View style={s.winnerWrap}>
                  {members.map(m => (
                    <TouchableOpacity key={m.id} style={[s.winnerChip, winnerId === m.id && s.winnerChipOn]} onPress={() => setWinnerId(m.id)}>
                      <Text style={[s.winnerTxt, winnerId === m.id && { color: '#fff' }]}>{m.name}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                  <View style={{ flex: 1 }}><Text style={s.formLabel}>Winning bid</Text><Field value={bid} onChangeText={setBid} placeholder="₹ 0" keyboardType="numeric" /></View>
                  <View style={{ flex: 1 }}><Text style={s.formLabel}>Commission</Text><Field value={commission} onChangeText={setCommission} placeholder="₹ 0" keyboardType="numeric" /></View>
                </View>
                {(() => {
                  const sp = previewSplit();
                  return (
                    <>
                      <Text style={s.dividendHint}>Dividend / member {formatINR(sp.each)} × {g.members}</Text>
                      {sp.remainderPaise > 0 && (
                        <Text style={s.dividendNote}>
                          {formatINR(sp.remainder)} cannot divide evenly and stays in the pot.
                        </Text>
                      )}
                    </>
                  );
                })()}
                <View style={{ marginTop: 10 }}><Btn label="Record Auction" icon="hammer-outline" onPress={submitAuction} wide /></View>
              </View>
            )}

            {auctions.length > 0 && <Text style={[s.formLabel, { marginTop: 18 }]}>Auction history</Text>}
            {auctions.map(a => (
              <View key={a.id} style={s.auctionRow}>
                <View style={s.aMonth}><Text style={s.aMonthTxt}>M{a.month}</Text></View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.aWinner} numberOfLines={1}>{a.winner_name}</Text>
                  <Text style={s.aSub}>Bid {formatINR(a.winning_bid)} · Commission {formatINR(a.commission)}</Text>
                  <Text style={s.aDiv}>Dividend/member {formatINR(a.dividend)}</Text>
                </View>
                <TouchableOpacity onPress={() => deleteAuction(a.id).then(reload)} hitSlop={8}><Ionicons name="close" size={16} color={FIN.faint} /></TouchableOpacity>
              </View>
            ))}
          </>
        ) : (
          <>
            {/* @history — append-only record of every change to this group. */}
            {timeline.length === 0 ? (
              <Text style={s.empty}>No activity yet. Adding members and marking dues will show up here.</Text>
            ) : timeline.map(t => (
              <View key={t.id} style={s.histRow}>
                <View style={s.histDot} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.histTxt}>{t.detail}</Text>
                  <Text style={s.histAt}>{fmtDateTime(t.at)}</Text>
                </View>
              </View>
            ))}
          </>
        )}
        <View style={{ height: 30 }} />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  body: { padding: 16, alignSelf: 'center', width: '100%', maxWidth: FIN.contentMax },
  heroLabel: { color: 'rgba(255,255,255,0.85)', fontSize: 10.5, fontWeight: '700', letterSpacing: 0.8 },
  heroVal: { color: '#fff', fontSize: 28, fontWeight: '800', marginTop: 6, ...TABULAR },
  heroFoot: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.2)' },
  heroFootTxt: { color: 'rgba(255,255,255,0.9)', fontSize: 12, fontWeight: '600' },
  tileRow: { flexDirection: 'row', gap: 8, marginTop: 12 },

  addRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16, backgroundColor: FIN.card, borderRadius: 12, padding: 10, borderWidth: 1, borderColor: FIN.glassEdge, shadowColor: '#101828', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 2 },
  addRowTxt: { color: FIN.brandDeep, fontSize: 14.5, fontWeight: '700' },
  addBtn: { width: 36, height: 36, borderRadius: 10, backgroundColor: FIN.brandDeep, alignItems: 'center', justifyContent: 'center' },

  memRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: FIN.card, borderRadius: 12, padding: 13, marginTop: 10, borderWidth: 1, borderColor: FIN.glassEdge, shadowColor: '#101828', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 2 },
  memNum: { width: 26, height: 26, borderRadius: 13, backgroundColor: FIN.brandSoft, alignItems: 'center', justifyContent: 'center' },
  memNumTxt: { color: FIN.brandDeep, fontSize: 12, fontWeight: '800' },
  memName: { color: FIN.text, fontSize: 15, fontWeight: '600' },
  memSub: { color: FIN.sub, fontSize: 12, marginTop: 2 },

  monthRow: { gap: 8, paddingVertical: 14 },
  monthChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: FIN.border, backgroundColor: FIN.card },
  monthChipOn: { backgroundColor: FIN.brand, borderColor: FIN.brand },
  monthTxt: { color: FIN.sub, fontSize: 13, fontWeight: '700' },

  colPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  colTxt: { fontSize: 11.5, fontWeight: '800' },

  empty: { color: FIN.sub, fontSize: 13, textAlign: 'center', paddingVertical: 24 },
  hint: { color: FIN.faint, fontSize: 11.5, textAlign: 'center', marginTop: 10 },

  auctionForm: { backgroundColor: FIN.card, borderRadius: 14, padding: 14, marginTop: 14, borderWidth: 1, borderColor: FIN.glassEdge, shadowColor: '#101828', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 2 },
  formLabel: { color: FIN.text, fontSize: 13, fontWeight: '700', marginBottom: 6, marginTop: 4 },
  winnerWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  winnerChip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: FIN.border, backgroundColor: FIN.card2 },
  winnerChipOn: { backgroundColor: FIN.brand, borderColor: FIN.brand },
  winnerTxt: { color: FIN.sub, fontSize: 12.5, fontWeight: '700' },
  dividendHint: { color: FIN.brandDeep, fontSize: 12.5, fontWeight: '700', marginTop: 10 },
  dividendNote: { color: FIN.sub, fontSize: 11.5, marginTop: 3 },

  auctionRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: FIN.card, borderRadius: 12, padding: 13, marginTop: 10, borderWidth: 1, borderColor: FIN.glassEdge, shadowColor: '#101828', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 2 },
  aMonth: { width: 34, height: 34, borderRadius: 10, backgroundColor: FIN.brandSoft, alignItems: 'center', justifyContent: 'center' },
  aMonthTxt: { color: FIN.brandDeep, fontSize: 12, fontWeight: '800' },
  aWinner: { color: FIN.text, fontSize: 14.5, fontWeight: '700' },
  aSub: { color: FIN.sub, fontSize: 12, marginTop: 2 },
  aDiv: { color: FIN.good, fontSize: 12, fontWeight: '700', marginTop: 2 },

  histRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: FIN.card, borderRadius: 12, padding: 13, marginTop: 10, borderWidth: 1, borderColor: FIN.glassEdge, shadowColor: '#101828', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 2 },
  histDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: FIN.brand, marginTop: 5 },
  histTxt: { color: FIN.text, fontSize: 13.5, fontWeight: '600' },
  histAt: { color: FIN.sub, fontSize: 11.5, marginTop: 3 },
});
