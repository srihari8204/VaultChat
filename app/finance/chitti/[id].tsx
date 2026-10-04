// app/finance/chitti/[id].tsx — Lucky Draw group detail: Members + manual Collections.
// Members carry name, mobile (validated) and address. Local-only — see db/chitti.ts.

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useFinanceTheme } from '../../../components/finance/useFinanceTheme';
import { KeyboardSafe } from '../../../components/ui';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { TABULAR, FIN_SHADOW, type FinancePalette } from '../../../constants/financeTheme';
import { FinHeader, HeroCard, Segment, StatTile, TileGrid, Field, Btn, Label, Card, LoadingState, ErrorState } from '../../../components/finance/ui';
import { useLoadStatus } from '../../../components/finance/useLoad';
import { nextMemberNumber } from '../../../components/finance/chittiNumber';
import { inrShort, fmtDate, fmtDateTime, num } from '../../../utils/financeFormat';
import { formatINR } from '../../../utils/interest';
import {
  getGroup, deleteGroup, setGroupStatus, insertMember, updateMember, listMembers, deleteMember, normalizeMobile,
  markCollection, listCollections, recordAuction, listAuctions, deleteAuction,
  type ChittiGroup, type ChittiMember, type ChittiCollection, type CollectionStatus, type ChittiAuction, type ChittiStatus,
} from '../../../db/chitti';
import { nextAuction, chittiTermEnd, groupStatusFor } from '../../../utils/financeRules';
import { listTimeline, type TimelineRow } from '../../../db/financeTimeline';
import { splitEvenly } from '../../../utils/money';

type Tab = 'members' | 'collections' | 'auctions' | 'history';
const CYCLE: CollectionStatus[] = ['pending', 'paid', 'overdue'];
const getCollectionMeta = (FIN: FinancePalette): Record<CollectionStatus, { fg: string; bg: string; label: string; icon: keyof typeof Ionicons.glyphMap }> => ({
  paid:    { fg: FIN.good, bg: FIN.goodSoft, label: 'Paid',    icon: 'checkmark-circle' },
  pending: { fg: FIN.warn, bg: FIN.warnSoft, label: 'Pending', icon: 'ellipse-outline' },
  overdue: { fg: FIN.bad,  bg: FIN.badSoft,  label: 'Overdue', icon: 'alert-circle' },
});

export default function ChittiDetail() {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const COL_META = React.useMemo(() => getCollectionMeta(FIN), [FIN]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [g, setG] = useState<ChittiGroup | null>(null);
  const [tab, setTab] = useState<Tab>('members');
  const [members, setMembers] = useState<ChittiMember[]>([]);
  const [collections, setCollections] = useState<ChittiCollection[]>([]);
  const [auctions, setAuctions] = useState<ChittiAuction[]>([]);
  const [timeline, setTimeline] = useState<TimelineRow[]>([]);
  const [historyFailed, setHistoryFailed] = useState(false);
  // One dues tap at a time: each tap reads the status the LAST write left,
  // so a double tap used to skip a state (Pending → Overdue) silently.
  const cycling = useRef(false);
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

  const { status, begin, done, fail } = useLoadStatus();
  const reload = useCallback(() => {
    if (!id) { fail(); return; }
    begin();
    Promise.all([getGroup(id), listMembers(id), listCollections(id), listAuctions(id)])
      .then(([grp, mem, col, auc]) => { setG(grp); setMembers(mem); setCollections(col); setAuctions(auc); done(); })
      .catch(fail);
    // History is secondary: a failed read is said in the History tab rather
    // than failing the screen — and never shown as "No activity yet".
    listTimeline('chitti', id).then((t) => { setTimeline(t); setHistoryFailed(false); }).catch(() => setHistoryFailed(true));
  }, [id, begin, done, fail]);
  useFocusEffect(reload);

  const statusFor = useCallback(
    (memberId: string): CollectionStatus => collections.find(c => c.member_id === memberId && c.month === month)?.status ?? 'pending',
    [collections, month],
  );

  const countThisMonth = useMemo(() => {
    const c: Record<CollectionStatus, number> = { paid: 0, pending: 0, overdue: 0 };
    for (const m of members) c[statusFor(m.id)] += 1;
    return c;
  }, [members, statusFor]);

  if (!g) {
    return (
      <View style={s.screen}>
        <FinHeader title="Lucky Draw Group" />
        {status === 'loading' && <LoadingState label="Loading group" />}
        {status === 'error' && <ErrorState title="Could not load this group" sub="Nothing has been lost." onRetry={reload} />}
        {status === 'ready' && <ErrorState title="Group not found" sub="It may have been deleted." />}
      </View>
    );
  }

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
    if (!editingId && g.members > 0 && members.length >= g.members) {
      return Alert.alert('Group is full', `${g.name} is set up for ${g.members} members.`);
    }
    try {
      if (editingId) {
        await updateMember(editingId, { name, phone, address });
      } else {
        await insertMember({ group_id: g.id, name, phone, address, number: nextMemberNumber(members) });
      }
    } catch (e: any) { return Alert.alert('Could not save the member', e?.message ?? 'Try again.'); }
    setShowMemberForm(false);
    reload();
  };

  const cycleStatus = async (m: ChittiMember) => {
    if (cycling.current) return;
    cycling.current = true;
    const cur = statusFor(m.id);
    const next = CYCLE[(CYCLE.indexOf(cur) + 1) % CYCLE.length];
    try {
      await markCollection(g.id, m.id, month, g.installment, next);
      reload();
    } catch (e: any) {
      Alert.alert('Could not update the due', e?.message ?? 'Nothing was changed. Try again.');
    } finally { cycling.current = false; }
  };

  const submitAuction = async () => {
    // `|| 0` SWALLOWED THE HARDENED PARSER (2026-09-17). num() answers NaN for
    // a half-typed "1,2" precisely so a guard can see it; `|| 0` converted that
    // back to a believable zero, so a commission the organiser typed was
    // RECORDED AS NONE and the whole bid was then split across every member —
    // over-distributing real money, silently. `!(c >= 0)` rejects the NaN and a
    // negative commission alike; blank stays 0, because num('') is 0.
    const b = num(bid), c = num(commission);
    if (!winnerId) return Alert.alert('Winner', 'Select the winning member.');
    if (!(b > 0)) return Alert.alert('Winning bid', 'Enter the winning bid amount.');
    if (!(c >= 0)) return Alert.alert('Commission', 'The commission must be a plain number — digits only, 1200 or 1,200 — or empty for none. It cannot be negative.');
    // The discount a winner forgoes cannot exceed the pot, and the foreman's
    // commission comes out of that discount — past either bound the dividend
    // the group is told to pay out is money that does not exist.
    if (b > g.chit_value) return Alert.alert('Winning bid', `The bid cannot be more than the chit value, ${formatINR(g.chit_value)}.`);
    if (c > b) return Alert.alert('Commission', 'The commission cannot be more than the winning bid.');
    const existing = auctions.find(a => a.month === month);
    if (existing) {
      const go = await new Promise<boolean>((resolve) => Alert.alert(
        `Replace month ${month}'s auction?`,
        `Month ${month} is already recorded: ${existing.winner_name}, bid ${formatINR(existing.winning_bid)}. Recording again replaces it. The change is kept in History.`,
        [{ text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
         { text: 'Replace', style: 'destructive', onPress: () => resolve(true) }],
        { cancelable: true, onDismiss: () => resolve(false) },
      ));
      if (!go) return;
    }
    const winner = members.find(m => m.id === winnerId);
    try {
      await recordAuction(g, month, winnerId, winner?.name ?? '—', b, c);
    } catch (e: any) { return Alert.alert('Could not record the auction', e?.message ?? 'Nothing was saved. Try again.'); }
    setBid(''); setCommission(''); setWinnerId(null);
    reload();
  };
  // Mirrors recordAuction exactly, so the preview can never promise a number
  // the recorded auction won't produce.
  const previewSplit = () => {
    const b = num(bid), c = num(commission);
    // Same `!(c >= 0)` as submitAuction, for the same reason the mirror exists:
    // with `|| 0` the preview promised a full undiscounted split for a
    // commission the recorded auction will now refuse outright (2026-09-17).
    if (!(b > 0) || !(c >= 0)) return { each: 0, remainder: 0, remainderPaise: 0 };
    return splitEvenly(Math.max(0, b - c), g.members || 1);
  };

  const onDelete = () => Alert.alert('Delete group?', `Delete ${g.name} with its members, dues, auctions and history? This cannot be undone.`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => {
      deleteGroup(g.id).then(() => router.back())
        .catch((e: any) => Alert.alert('Could not delete the group', e?.message ?? 'Try again.'));
    } },
  ]);

  const removeMember = (m: ChittiMember) => Alert.alert(
    'Remove member?',
    `Remove ${m.name} from ${g.name}? Their collection history stays in the group totals but is no longer attributed. This cannot be undone.`,
    [{ text: 'Cancel', style: 'cancel' },
     { text: 'Remove', style: 'destructive', onPress: () => {
       deleteMember(m.id).then(reload).catch((e: any) => Alert.alert('Could not remove the member', e?.message ?? 'Try again.'));
     } }],
  );

  const removeAuction = (a: ChittiAuction) => Alert.alert(
    'Delete auction?',
    `Delete month ${a.month}'s auction? The bid and the winner are removed; the deletion is noted in History. This cannot be undone.`,
    [{ text: 'Cancel', style: 'cancel' },
     { text: 'Delete', style: 'destructive', onPress: () => {
       deleteAuction(a.id).then(reload).catch((e: any) => Alert.alert('Could not delete the auction', e?.message ?? 'Try again.'));
     } }],
  );

  // The organiser's own status choice. An active group closes by itself the
  // day after its last auction (db/chitti listGroups/getGroup); re-activating
  // one whose term has ended would only be closed again, so that is explained
  // instead of silently undone.
  const changeStatus = (next: ChittiStatus) => {
    if (next === g.status) return;
    if (next === 'active' && groupStatusFor({ ...g, status: 'active' }, Date.now()) === 'closed') {
      return Alert.alert('This group has finished',
        `Its last auction was on ${fmtDate(chittiTermEnd(g))}, so it closes automatically. It stays in Closed with all its records.`);
    }
    const word = { active: 'Active', closed: 'Closed', draft: 'Draft' }[next];
    Alert.alert(`Mark as ${word}?`, `${g.name} moves to the ${word} tab of Lucky Draw. Members, dues and auctions are kept.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: `Mark ${word}`, onPress: () => {
        setGroupStatus(g.id, next).then(reload).catch((e: any) => Alert.alert('Could not change the status', e?.message ?? 'Try again.'));
      } },
    ]);
  };

  // Calendar months from the start date, and the next one from TODAY — not
  // 30-day months from whichever month tab happens to be selected.
  const upcoming = nextAuction(g, Date.now());

  return (
    <View style={s.screen}>
      <FinHeader title={g.name} right={
        <>
          {/* Reuses the existing finance reminders flow (local notifications)
              via its refType/refId/title prefill — no separate scheduler. */}
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Set a reminder"
            onPress={() => router.push({
              pathname: '/finance/reminders',
              params: { refType: 'chitti', refId: g.id, title: `${g.name} — collection due` },
            })}
            hitSlop={8}
          >
            <Ionicons name="notifications-outline" size={20} color={FIN.brandDeep} />
          </TouchableOpacity>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Delete this group" onPress={onDelete} hitSlop={8}><Ionicons name="trash-outline" size={20} color={FIN.bad} /></TouchableOpacity>
        </>
      } />
      {/* The member form and the auction fields sit low on a long page: the
          keyboard must not cover them on Android (edge-to-edge). */}
      <KeyboardSafe>
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <HeroCard>
          <Text style={s.heroLabel}>CHIT VALUE</Text>
          <Text style={s.heroVal}>{inrShort(g.chit_value)}</Text>
          <View style={s.heroFoot}>
            <Text style={s.heroFootTxt}>Installment {inrShort(g.installment)}</Text>
            <Text style={s.heroFootTxt}>{upcoming ? `Next auction M${upcoming.month} · ${fmtDate(upcoming.at)}` : 'All auctions done'}</Text>
          </View>
        </HeroCard>

        <View style={s.tileRow}>
          <TileGrid>
          <StatTile value={String(members.length)} label={`of ${g.members} members`} tone="brand" />
          <StatTile value={String(countThisMonth.paid)} label={`Paid · M${month}`} tone="good" />
          <StatTile value={String(countThisMonth.pending)} label={`Pending · M${month}`} tone="warn" />
          <StatTile value={String(countThisMonth.overdue)} label={`Overdue · M${month}`} tone="bad" />
          </TileGrid>
        </View>

        <Text style={s.formLabel} accessibilityRole="header">Group status</Text>
        <Segment<ChittiStatus>
          options={[{ k: 'active', label: 'Active' }, { k: 'closed', label: 'Closed' }, { k: 'draft', label: 'Draft' }]}
          value={g.status} onChange={changeStatus} small
        />

        <View style={{ marginTop: 16 }}>
          <Segment<Tab> options={[{ k: 'members', label: 'Members' }, { k: 'collections', label: 'Dues' }, { k: 'auctions', label: 'Auctions' }, { k: 'history', label: 'History' }]} value={tab} onChange={setTab} small />
        </View>

        {tab === 'members' ? (
          <>
            {/* @members */}
            {showMemberForm ? (
              <Card style={{ marginTop: 16 }}>
                <Label>Name</Label>
                <Field label="Member name" value={mName} onChangeText={setMName} placeholder="Member's full name" />
                <Label hint="(optional)">Mobile Number</Label>
                <Field label="Mobile number, optional" value={mPhone} onChangeText={setMPhone} placeholder="e.g. 98765 43210" keyboardType="phone-pad" />
                <Label hint="(optional)">Address</Label>
                <Field label="Address, optional" value={mAddress} onChangeText={setMAddress} placeholder="Door no., street, area, city" multiline />
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
                  <Btn label="Cancel" kind="ghost" onPress={closeMemberForm} wide />
                  <Btn label={editingId ? 'Save Changes' : 'Add Member'} icon="checkmark" onPress={saveMember} wide />
                </View>
              </Card>
            ) : (
              <TouchableOpacity style={s.addRow} onPress={openAddMember} activeOpacity={0.85}
                accessibilityRole="button" accessibilityLabel="Add member">
                <View style={s.addBtn}><Ionicons name="add" size={20} color={FIN.onBrand} /></View>
                <Text style={s.addRowTxt}>Add member</Text>
              </TouchableOpacity>
            )}
            {members.length === 0 ? <Text style={s.empty}>No members yet — add them above.</Text> : members.map(m => (
              <TouchableOpacity key={m.id} style={s.memRow} activeOpacity={0.85} onPress={() => openEditMember(m)}
                accessibilityRole="button"
                accessibilityLabel={`Member ${m.number}, ${m.name}${m.phone ? `, ${m.phone}` : ''}. Edit`}
                accessibilityActions={[{ name: 'remove', label: `Remove ${m.name}` }]}
                onAccessibilityAction={(ev) => { if (ev.nativeEvent.actionName === 'remove') removeMember(m); }}>
                <View style={s.memNum}><Text style={s.memNumTxt}>{m.number}</Text></View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.memName} numberOfLines={1}>{m.name}</Text>
                  {(m.phone || m.address) && (
                    <Text style={s.memSub} numberOfLines={1}>
                      {[m.phone, m.address].filter(Boolean).join(' · ')}
                    </Text>
                  )}
                </View>
                <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Remove ${m.name}`} onPress={() => removeMember(m)} hitSlop={14}>
                  <Ionicons name="close" size={16} color={FIN.faint} />
                </TouchableOpacity>
              </TouchableOpacity>
            ))}
          </>
        ) : tab === 'collections' ? (
          <>
            <MonthChips count={g.duration} value={month} onChange={setMonth} />
            {members.length === 0 ? <Text style={s.empty}>Add members first to record collections.</Text> : members.map(m => {
              const st = statusFor(m.id);
              const meta = COL_META[st];
              const nextLabel = COL_META[CYCLE[(CYCLE.indexOf(st) + 1) % CYCLE.length]].label;
              return (
                <TouchableOpacity key={m.id} style={s.memRow} activeOpacity={0.85} onPress={() => cycleStatus(m)}
                  accessibilityRole="button"
                  accessibilityLabel={`${m.name}, month ${month}: ${meta.label}`}
                  accessibilityHint={`Marks it ${nextLabel}`}>
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
                <MonthChips count={g.duration} value={month} onChange={setMonth} />
                <Text style={s.formLabel}>Winner</Text>
                <View style={s.winnerWrap} accessibilityRole="radiogroup" accessibilityLabel="Winner">
                  {members.map(m => (
                    <TouchableOpacity key={m.id} style={[s.winnerChip, winnerId === m.id && s.winnerChipOn]} onPress={() => setWinnerId(m.id)}
                      accessibilityRole="radio" accessibilityState={{ selected: winnerId === m.id }}
                      accessibilityLabel={`${m.name}, member ${m.number}`}>
                      <Text numberOfLines={1} style={[s.winnerTxt, winnerId === m.id && { color: FIN.onBrand }]}>{m.name}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                  <View style={{ flex: 1 }}><Text style={s.formLabel}>Winning bid</Text><Field label="Winning bid" value={bid} onChangeText={setBid} placeholder="₹ 0" keyboardType="numeric" /></View>
                  <View style={{ flex: 1 }}><Text style={s.formLabel}>Commission</Text><Field label="Commission" value={commission} onChangeText={setCommission} placeholder="₹ 0" keyboardType="numeric" /></View>
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
                {/* Confirmed like the group delete above (2026-09-17); the
                    delete also writes a timeline entry, so a removed settled
                    auction (month, bid, winner) leaves a trace. */}
                <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Delete month ${a.month}'s auction`}
                  onPress={() => removeAuction(a)} hitSlop={14}><Ionicons name="close" size={16} color={FIN.faint} /></TouchableOpacity>
              </View>
            ))}
          </>
        ) : (
          <>
            {/* @history — append-only record of every change to this group. */}
            {historyFailed ? (
              <View style={{ paddingVertical: 16, gap: 8 }}>
                <Text style={s.empty} accessibilityRole="alert">Could not load the history. Nothing has been lost.</Text>
                <Btn label="Try again" kind="ghost" icon="refresh" onPress={reload} />
              </View>
            ) : timeline.length === 0 ? (
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
      </KeyboardSafe>
    </View>
  );
}

/** Month selector shared by Dues and Auctions: a radio group of M1…Mn. */
function MonthChips({ count, value, onChange }: { count: number; value: number; onChange: (m: number) => void }) {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.monthRow}
      accessibilityRole="radiogroup" accessibilityLabel="Month">
      {Array.from({ length: count }, (_, i) => i + 1).map(mn => (
        <TouchableOpacity key={mn} style={[s.monthChip, value === mn && s.monthChipOn]} onPress={() => onChange(mn)}
          accessibilityRole="radio" accessibilityState={{ selected: value === mn }} accessibilityLabel={`Month ${mn}`}>
          <Text style={[s.monthTxt, value === mn && { color: FIN.onBrand }]}>M{mn}</Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const makeStyles = (FIN: FinancePalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  body: { padding: 16, alignSelf: 'center', width: '100%', maxWidth: FIN.contentMax },
  // Fixed white on the always-dark FIN_HERO gradient (no scheme token applies).
  heroLabel: { color: 'rgba(255,255,255,0.85)', fontSize: 10.5, fontWeight: '700', letterSpacing: 0.8 },
  heroVal: { color: '#fff', fontSize: 28, fontWeight: '800', marginTop: 6, ...TABULAR },
  heroFoot: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.2)' },
  heroFootTxt: { color: 'rgba(255,255,255,0.9)', fontSize: 12, fontWeight: '600' },
  tileRow: { marginTop: 12 },

  addRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16, backgroundColor: FIN.card, borderRadius: 12, padding: 10, borderWidth: 1, borderColor: FIN.glassEdge, ...FIN_SHADOW.rest },
  addRowTxt: { color: FIN.brandDeep, fontSize: 14.5, fontWeight: '700' },
  addBtn: { width: 36, height: 36, borderRadius: 10, backgroundColor: FIN.brandDeep, alignItems: 'center', justifyContent: 'center' },

  memRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: FIN.card, borderRadius: 12, padding: 13, marginTop: 10, borderWidth: 1, borderColor: FIN.glassEdge, ...FIN_SHADOW.rest },
  memNum: { width: 26, height: 26, borderRadius: 13, backgroundColor: FIN.brandSoft, alignItems: 'center', justifyContent: 'center' },
  memNumTxt: { color: FIN.brandDeep, fontSize: 12, fontWeight: '800' },
  memName: { color: FIN.text, fontSize: 15, fontWeight: '600' },
  memSub: { color: FIN.sub, fontSize: 12, marginTop: 2 },

  monthRow: { gap: 8, paddingVertical: 14 },
  monthChip: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: FIN.border, backgroundColor: FIN.card },
  monthChipOn: { backgroundColor: FIN.brandDeep, borderColor: FIN.brandDeep },
  monthTxt: { color: FIN.sub, fontSize: 13, fontWeight: '700' },

  colPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  colTxt: { fontSize: 11.5, fontWeight: '800' },

  empty: { color: FIN.sub, fontSize: 13, textAlign: 'center', paddingVertical: 24 },
  hint: { color: FIN.faint, fontSize: 11.5, textAlign: 'center', marginTop: 10 },

  auctionForm: { backgroundColor: FIN.card, borderRadius: 14, padding: 14, marginTop: 14, borderWidth: 1, borderColor: FIN.glassEdge, ...FIN_SHADOW.rest },
  formLabel: { color: FIN.text, fontSize: 13, fontWeight: '700', marginBottom: 6, marginTop: 4 },
  winnerWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  winnerChip: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: FIN.border, backgroundColor: FIN.card2 },
  winnerChipOn: { backgroundColor: FIN.brandDeep, borderColor: FIN.brandDeep },
  winnerTxt: { color: FIN.sub, fontSize: 12.5, fontWeight: '700' },
  dividendHint: { color: FIN.brandDeep, fontSize: 12.5, fontWeight: '700', marginTop: 10 },
  dividendNote: { color: FIN.sub, fontSize: 11.5, marginTop: 3 },

  auctionRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: FIN.card, borderRadius: 12, padding: 13, marginTop: 10, borderWidth: 1, borderColor: FIN.glassEdge, ...FIN_SHADOW.rest },
  aMonth: { width: 34, height: 34, borderRadius: 10, backgroundColor: FIN.brandSoft, alignItems: 'center', justifyContent: 'center' },
  aMonthTxt: { color: FIN.brandDeep, fontSize: 12, fontWeight: '800' },
  aWinner: { color: FIN.text, fontSize: 14.5, fontWeight: '700' },
  aSub: { color: FIN.sub, fontSize: 12, marginTop: 2 },
  aDiv: { color: FIN.good, fontSize: 12, fontWeight: '700', marginTop: 2 },

  histRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: FIN.card, borderRadius: 12, padding: 13, marginTop: 10, borderWidth: 1, borderColor: FIN.glassEdge, ...FIN_SHADOW.rest },
  histDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: FIN.brand, marginTop: 5 },
  histTxt: { color: FIN.text, fontSize: 13.5, fontWeight: '600' },
  histAt: { color: FIN.sub, fontSize: 11.5, marginTop: 3 },
});
