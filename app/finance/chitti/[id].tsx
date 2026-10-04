// app/finance/chitti/[id].tsx — Lucky Draw group detail: hero, status and the
// Members / Dues / Auctions / History tabs (one file each in components/finance/chitti).
// Local-only — see db/chitti.ts.

import React, { useCallback, useMemo, useState } from 'react';
import { useFinanceTheme } from '../../../components/finance/useFinanceTheme';
import { KeyboardSafe } from '../../../components/ui';
import { View, Text, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { FinHeader, HeroCard, Segment, StatTile, TileGrid, LoadingState, ErrorState } from '../../../components/finance/ui';
import { useLoadStatus } from '../../../components/finance/useLoad';
import { inrShort, fmtDate } from '../../../utils/financeFormat';
import {
  getGroup, deleteGroup, setGroupStatus, listMembers, listCollections, listAuctions,
  type ChittiGroup, type ChittiMember, type ChittiCollection, type CollectionStatus, type ChittiAuction, type ChittiStatus,
} from '../../../db/chitti';
import { nextAuction, chittiTermEnd, groupStatusFor } from '../../../utils/financeRules';
import { listTimeline, type TimelineRow } from '../../../db/financeTimeline';
import { makeChittiStyles, collectionStatus } from '../../../components/finance/chitti/chittiStyles';
import { MembersTab, EMPTY_MEMBER_DRAFT, type MemberDraft } from '../../../components/finance/chitti/MembersTab';
import { DuesTab } from '../../../components/finance/chitti/DuesTab';
import { AuctionsTab, EMPTY_AUCTION_DRAFT, type AuctionDraft } from '../../../components/finance/chitti/AuctionsTab';
import { HistoryTab } from '../../../components/finance/chitti/HistoryTab';
import { userErrorText } from '../../../lib/userErrorText';

type Tab = 'members' | 'collections' | 'auctions' | 'history';

export default function ChittiDetail() {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeChittiStyles(FIN), [FIN]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [g, setG] = useState<ChittiGroup | null>(null);
  const [tab, setTab] = useState<Tab>('members');
  const [members, setMembers] = useState<ChittiMember[]>([]);
  const [collections, setCollections] = useState<ChittiCollection[]>([]);
  const [auctions, setAuctions] = useState<ChittiAuction[]>([]);
  const [timeline, setTimeline] = useState<TimelineRow[]>([]);
  const [historyFailed, setHistoryFailed] = useState(false);
  // Shared by the tiles, Dues and Auctions.
  const [month, setMonth] = useState(1);
  // The half-typed member and auction forms live here, not in their tabs:
  // only the open tab is rendered, and a switch must not lose what was typed.
  const [memberDraft, setMemberDraft] = useState<MemberDraft>(EMPTY_MEMBER_DRAFT);
  const [auctionDraft, setAuctionDraft] = useState<AuctionDraft>(EMPTY_AUCTION_DRAFT);

  const { status, begin, done, fail } = useLoadStatus();
  // Resolves once the group's rows are on screen (or the error is), so the
  // dues latch can wait for it. Never rejects.
  const reload = useCallback((): Promise<void> => {
    if (!id) { fail(); return Promise.resolve(); }
    begin();
    // History is secondary: a failed read is said in the History tab rather
    // than failing the screen — and never shown as "No activity yet".
    listTimeline('chitti', id).then((t) => { setTimeline(t); setHistoryFailed(false); }).catch(() => setHistoryFailed(true));
    return Promise.all([getGroup(id), listMembers(id), listCollections(id), listAuctions(id)])
      .then(([grp, mem, col, auc]) => {
        setG(grp); setMembers(mem); setCollections(col); setAuctions(auc);
        // A picked winner who has since been removed would be recorded as "—".
        setAuctionDraft((d) => (d.winnerId && !mem.some((m) => m.id === d.winnerId) ? { ...d, winnerId: null } : d));
        done();
      })
      .catch(fail);
  }, [id, begin, done, fail]);
  useFocusEffect(useCallback(() => { reload(); }, [reload]));

  const statusFor = useCallback(
    (memberId: string): CollectionStatus => collectionStatus(collections, memberId, month),
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

  const onDelete = () => Alert.alert('Delete group?', `Delete ${g.name} with its members, dues, auctions and history? This cannot be undone.`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => {
      deleteGroup(g.id).then(() => router.back())
        .catch((e) => Alert.alert('Could not delete the group', userErrorText(e, 'Try again.')));
    } },
  ]);

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
        setGroupStatus(g.id, next).then(reload).catch((e) => Alert.alert('Could not change the status', userErrorText(e, 'Try again.')));
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
          value={g.status} onChange={changeStatus} small label="Group status"
        />

        <View style={{ marginTop: 16 }}>
          <Segment<Tab> options={[{ k: 'members', label: 'Members' }, { k: 'collections', label: 'Dues' }, { k: 'auctions', label: 'Auctions' }, { k: 'history', label: 'History' }]} value={tab} tabs onChange={setTab} small />
        </View>

        {/* Only the open tab renders (a large group's members used to render
            in three hidden tabs on every reload); the form drafts are above. */}
        {tab === 'members' && <MembersTab group={g} members={members} onChanged={reload} draft={memberDraft} setDraft={setMemberDraft} />}
        {tab === 'collections' && <DuesTab group={g} members={members} collections={collections} month={month} onMonth={setMonth} onChanged={reload} />}
        {tab === 'auctions' && (
          <AuctionsTab group={g} members={members} auctions={auctions} month={month} onMonth={setMonth} onChanged={reload}
            draft={auctionDraft} setDraft={setAuctionDraft} />
        )}
        {tab === 'history' && <HistoryTab timeline={timeline} failed={historyFailed} onRetry={reload} />}
        <View style={{ height: 30 }} />
      </ScrollView>
      </KeyboardSafe>
    </View>
  );
}
