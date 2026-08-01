// app/finance/chitti/[id].tsx — Chitti group detail: Members + manual Collections.
// v1 (no auctions): add members, and mark each installment paid/pending/overdue.

import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, TextInput, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { FIN } from '../../../constants/financeTheme';
import { FinHeader, HeroCard, Segment, StatTile } from '../../../components/finance/ui';
import { inrShort, fmtDate } from '../../../utils/financeFormat';
import {
  getGroup, deleteGroup, insertMember, listMembers, deleteMember,
  markCollection, listCollections,
  type ChittiGroup, type ChittiMember, type ChittiCollection, type CollectionStatus,
} from '../../../db/chitti';

type Tab = 'members' | 'collections';
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
  const [month, setMonth] = useState(1);
  const [newMember, setNewMember] = useState('');

  const reload = useCallback(() => {
    if (!id) return;
    getGroup(id).then(setG);
    listMembers(id).then(setMembers);
    listCollections(id).then(setCollections);
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

  if (!g) return <View style={s.screen}><FinHeader title="Chitti Group" /></View>;

  const addMember = async () => {
    if (!newMember.trim()) return;
    await insertMember({ group_id: g.id, name: newMember.trim(), phone: null, number: members.length + 1 });
    setNewMember('');
    reload();
  };

  const cycleStatus = async (m: ChittiMember) => {
    const cur = statusFor(m.id);
    const next = CYCLE[(CYCLE.indexOf(cur) + 1) % CYCLE.length];
    await markCollection(g.id, m.id, month, g.installment, next);
    reload();
  };

  const onDelete = () => Alert.alert('Delete group?', `Delete ${g.name} and all its members/collections?`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => deleteGroup(g.id).then(() => router.back()) },
  ]);

  const nextAuction = g.start_date + (month) * 30 * 86400000;

  return (
    <View style={s.screen}>
      <FinHeader title={g.name} right={
        <TouchableOpacity onPress={onDelete} hitSlop={8}><Ionicons name="trash-outline" size={20} color={FIN.bad} /></TouchableOpacity>
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
          <Segment<Tab> options={[{ k: 'members', label: 'Members' }, { k: 'collections', label: 'Collections' }]} value={tab} onChange={setTab} />
        </View>

        {tab === 'members' ? (
          <>
            <View style={s.addRow}>
              <TextInput style={s.addInput} value={newMember} onChangeText={setNewMember} placeholder="Add member name" placeholderTextColor={FIN.faint} onSubmitEditing={addMember} returnKeyType="done" />
              <TouchableOpacity style={s.addBtn} onPress={addMember}><Ionicons name="add" size={22} color="#fff" /></TouchableOpacity>
            </View>
            {members.length === 0 ? <Text style={s.empty}>No members yet — add them above.</Text> : members.map(m => (
              <View key={m.id} style={s.memRow}>
                <View style={s.memNum}><Text style={s.memNumTxt}>{m.number}</Text></View>
                <Text style={s.memName}>{m.name}</Text>
                <TouchableOpacity onPress={() => deleteMember(m.id).then(reload)} hitSlop={8}>
                  <Ionicons name="close" size={16} color={FIN.faint} />
                </TouchableOpacity>
              </View>
            ))}
          </>
        ) : (
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
                  <Text style={s.memName}>{m.name}</Text>
                  <View style={[s.colPill, { backgroundColor: meta.bg }]}>
                    <Ionicons name={meta.icon} size={13} color={meta.fg} />
                    <Text style={[s.colTxt, { color: meta.fg }]}>{meta.label}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
            {members.length > 0 && <Text style={s.hint}>Tap a row to cycle Pending → Paid → Overdue</Text>}
          </>
        )}
        <View style={{ height: 30 }} />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  body: { padding: 16 },
  heroLabel: { color: 'rgba(255,255,255,0.85)', fontSize: 10.5, fontWeight: '700', letterSpacing: 0.8 },
  heroVal: { color: '#fff', fontSize: 28, fontWeight: '800', marginTop: 6 },
  heroFoot: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.2)' },
  heroFootTxt: { color: 'rgba(255,255,255,0.9)', fontSize: 12, fontWeight: '600' },
  tileRow: { flexDirection: 'row', gap: 8, marginTop: 12 },

  addRow: { flexDirection: 'row', gap: 8, marginTop: 16 },
  addInput: { flex: 1, backgroundColor: FIN.card, borderWidth: 1, borderColor: FIN.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, fontSize: 15, color: FIN.text },
  addBtn: { width: 48, borderRadius: 10, backgroundColor: FIN.brandDeep, alignItems: 'center', justifyContent: 'center' },

  memRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: FIN.card, borderRadius: 12, padding: 13, marginTop: 10, borderWidth: 1, borderColor: FIN.border },
  memNum: { width: 26, height: 26, borderRadius: 13, backgroundColor: FIN.brandSoft, alignItems: 'center', justifyContent: 'center' },
  memNumTxt: { color: FIN.brandDeep, fontSize: 12, fontWeight: '800' },
  memName: { flex: 1, color: FIN.text, fontSize: 15, fontWeight: '600' },

  monthRow: { gap: 8, paddingVertical: 14 },
  monthChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: FIN.border, backgroundColor: FIN.card },
  monthChipOn: { backgroundColor: FIN.brand, borderColor: FIN.brand },
  monthTxt: { color: FIN.sub, fontSize: 13, fontWeight: '700' },

  colPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  colTxt: { fontSize: 11.5, fontWeight: '800' },

  empty: { color: FIN.sub, fontSize: 13, textAlign: 'center', paddingVertical: 24 },
  hint: { color: FIN.faint, fontSize: 11.5, textAlign: 'center', marginTop: 10 },
});
