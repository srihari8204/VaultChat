// app/group-invites.tsx — add people to a group, entirely inside crazzychat
// (Groups & Circles, membership v2).
//
// WHAT IS NOT HERE: no QR code, no shareable link, no SMS or WhatsApp hand-off.
// An invitation from this screen is addressed to one account and cannot be
// forwarded. Shareable links DO exist for groups, separately: admins make them
// in Group info → Invite links (/invite-link, POST /chats/:id/invite-links),
// and anyone holding one can join (or ask, when "Approve invite-link joins" is
// on in Group admin). The footer says both, so the two never contradict.
//
// Three sections, matching the three things an admin actually does:
//   Add      search people and invite them
//   Waiting  approve or turn down whoever is part-way in
//   Sent     invitations nobody has answered yet
//
// "Waiting" is the section that did not exist before. Under the default strict
// mode an acceptance is NOT a join — it is a request for the owner's blessing —
// so without a queue to see them in, everyone who says yes simply vanishes.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardSafe } from '../components/ui';
import {
  View, StyleSheet, TouchableOpacity, SectionList, TextInput, Alert,
  ActivityIndicator, Image,
} from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { AuroraBackground } from '../components/ui/AuroraBackground';
import { AppText as Text } from '../components/ui/Text';
import { brandAlpha } from '../constants/theme';
import {
  createInvitation, listInvitations, resendInvitation, revokeInvitation, cancelInvitation,
  inviteCandidates, approveMember, rejectMember, attachmentUrl,
  approveJoinRequest, rejectJoinRequest,
  type Invitation, type InvitationStatus, type InviteCandidate,
} from '../lib/chatService';
import { initialOf } from '../lib/format';
import { useAuthHeader } from '../hooks/useAuthHeader';
import { inkOn } from '../lib/groups/catalog';
import { approvalQueue, isLinkRow, queueKey, type QueueRow } from '../lib/groups/serverContracts';
import { GroupNotFound } from '../components/groups/GroupNotFound';
import { tint } from '../lib/tintColor';

const STATUS_TONE: Record<InvitationStatus, 'good' | 'warn' | 'bad' | 'mute'> = {
  joined: 'good', accepted: 'warn', pending: 'warn',
  rejected: 'bad', cancelled: 'bad', revoked: 'bad', expired: 'mute',
};

const STATUS_LABEL: Record<InvitationStatus, string> = {
  pending: 'Waiting for them',
  accepted: 'Accepted — needs approval',
  joined: 'Joined',
  rejected: 'Declined',
  cancelled: 'Withdrawn',
  expired: 'Expired',
  revoked: 'Revoked',
};

/** Why a search result has no Invite button. Silence would read as a bug. */
const CANDIDATE_NOTE: Record<InviteCandidate['state'], string> = {
  invitable: '',
  member: 'Already in this group',
  invited: 'Already invited',
  cooldown: 'Recently removed',
};

const SEARCH_DEBOUNCE_MS = 300;

/** One row of the screen's SectionList: a search result, a queue row or a sent invitation. */
type Row =
  | { kind: 'result'; c: InviteCandidate }
  | { kind: 'waiting'; p: QueueRow }
  | { kind: 'sent'; inv: Invitation };
type Section = { key: Row['kind']; data: Row[] };
const rowKey = (r: Row) =>
  r.kind === 'result' ? `r:${r.c.id}` : r.kind === 'waiting' ? `w:${queueKey(r.p)}` : `s:${r.inv.id}`;

export default function GroupInvitesScreen() {
  const { colors } = useTheme();
  const authHeader = useAuthHeader();
  // `fresh`: opened straight after creating the group (app/create-group.tsx's
  // "Create & add people", or app/group-create.tsx).
  const params = useLocalSearchParams<{ chatId?: string; name?: string; fresh?: string }>();
  const chatId = String(params.chatId || '');
  const groupName = String(params.name || 'this group');

  const [q, setQ] = useState('');
  const [results, setResults] = useState<InviteCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  // The search request failed: "Nobody found" would be a false answer.
  const [searchFailed, setSearchFailed] = useState(false);
  const [inviting, setInviting] = useState<string | null>(null);

  // One queue: invitations, plus invite-link requests once the server merges
  // them (R4 backend C8; today the server returns invitations only and the
  // link requests stay in Group admin).
  const [waiting, setWaiting] = useState<QueueRow[]>([]);
  const [sent, setSent] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  // Which half of the last refresh failed, shown over the lists instead of silence.
  const [refreshFailed, setRefreshFailed] = useState(false);
  // Resend / withdraw in flight, per invitation (double-tap guard).
  const [resending, setResending] = useState<number | null>(null);
  const [withdrawing, setWithdrawing] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    if (!chatId) { setLoading(false); return; }
    // Settled either way: a permission error on one half should not blank the
    // other, and neither should stop the spinner from clearing.
    const [inv, pend] = await Promise.allSettled([
      listInvitations(chatId),
      approvalQueue(chatId),
    ]);
    if (inv.status === 'fulfilled') setSent(inv.value);
    if (pend.status === 'fulfilled') setWaiting(pend.value);
    setRefreshFailed(inv.status === 'rejected' || pend.status === 'rejected');
    setLoading(false);
  }, [chatId]);

  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));

  // Debounced search. The sequence guard makes a slow early response unable to
  // overwrite a fast later one — otherwise typing quickly leaves you looking at
  // results for a prefix you have already deleted.
  const seq = useRef(0);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setResults([]); setSearched(false); setSearchFailed(false); setSearching(false); return; }
    setSearching(true);
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const hits = await inviteCandidates(chatId, term);
        if (mine === seq.current) { setResults(hits); setSearched(true); setSearchFailed(false); }
      } catch {
        if (mine === seq.current) { setResults([]); setSearched(true); setSearchFailed(true); }
      } finally {
        if (mine === seq.current) setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q, chatId]);

  const tone = (t: 'good' | 'warn' | 'bad' | 'mute') =>
    t === 'good' ? colors.success : t === 'warn' ? colors.primary
      : t === 'bad' ? colors.danger : colors.textDim;

  const invite = async (c: InviteCandidate) => {
    if (inviting) return;
    setInviting(c.id);
    try {
      await createInvitation(chatId, { userId: c.id });
      // Mark the row in place rather than dropping it — a result that vanishes
      // on tap looks like the tap failed.
      setResults((prev) => prev.map((r) => (r.id === c.id ? { ...r, state: 'invited' } : r)));
      refresh();
    } catch (e: any) {
      Alert.alert('Could not invite', e?.message ?? 'Try again.');
    } finally { setInviting(null); }
  };

  // A link request is approved by user id on /join-requests; an invitation by its id.
  // The exact guard: `acting` inside an Alert callback is the value from when
  // the Alert opened, so a second confirm could slip past it.
  const actingRef = useRef(false);
  const approve = async (p: QueueRow) => {
    if (actingRef.current) return;
    actingRef.current = true;
    setActing(queueKey(p));
    try {
      if (isLinkRow(p)) await approveJoinRequest(chatId, String(p.userId));
      else await approveMember(chatId, Number(p.id));
      await refresh();
    }
    catch (e: any) { Alert.alert('Could not approve', e?.message ?? 'Try again.'); }
    finally { actingRef.current = false; setActing(null); }
  };

  const decline = (p: QueueRow) => {
    Alert.alert(
      p.requested ? 'Turn down this request?' : 'Turn down this person?',
      `${p.name ?? 'They'} will not join ${groupName}. You can invite them again later.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Turn down', style: 'destructive', onPress: async () => {
          if (actingRef.current) return;
          actingRef.current = true;
          setActing(queueKey(p));
          try {
            if (isLinkRow(p)) await rejectJoinRequest(chatId, String(p.userId));
            else await rejectMember(chatId, Number(p.id));
            await refresh();
          }
          catch (e: any) { Alert.alert('Could not do that', e?.message ?? 'Try again.'); }
          finally { actingRef.current = false; setActing(null); }
        } },
      ],
    );
  };

  const doResend = async (inv: Invitation) => {
    if (resending != null) return;
    setResending(inv.id);
    try { await resendInvitation(chatId, inv.id); await refresh(); }
    catch (e: any) { Alert.alert('Could not renew', e?.message ?? 'Try again.'); }
    finally { setResending(null); }
  };

  // Withdrawing your OWN invitation and revoking somebody else's are different
  // acts on the server — they land in different statuses so the group's history
  // still says who ended it. Offering the right one is the only way that
  // distinction survives contact with a user.
  const withdrawingRef = useRef(false);
  const doWithdraw = (inv: Invitation) => {
    Alert.alert(
      inv.mine ? 'Withdraw your invitation?' : 'Revoke this invitation?',
      'It disappears from their invitations straight away.',
      [
        { text: 'Keep it', style: 'cancel' },
        { text: inv.mine ? 'Withdraw' : 'Revoke', style: 'destructive', onPress: async () => {
          if (withdrawingRef.current) return;
          withdrawingRef.current = true;
          setWithdrawing(inv.id);
          try {
            if (inv.mine) await cancelInvitation(chatId, inv.id);
            else await revokeInvitation(chatId, inv.id);
            await refresh();
          } catch (e: any) { Alert.alert('Could not do that', e?.message ?? 'Try again.'); }
          finally { withdrawingRef.current = false; setWithdrawing(null); }
        } },
      ],
    );
  };

  // Anyone still to answer. Accepted invitations live in "Waiting" instead, so
  // showing them here as well would ask the admin to act on the same person in
  // two places.
  const unanswered = useMemo(
    () => sent.filter((s) => s.status === 'pending' || s.status === 'expired'),
    [sent],
  );

  // A SectionList, not .map in a ScrollView: the server caps each list (20
  // search results, 200 sent, 200 + 200 waiting), but a busy group can still
  // reach hundreds of rows, and only the visible ones should be laid out.
  const sections = useMemo<Section[]>(() => [
    { key: 'result', data: results.map((c) => ({ kind: 'result' as const, c })) },
    { key: 'waiting', data: waiting.map((p) => ({ kind: 'waiting' as const, p })) },
    { key: 'sent', data: unanswered.map((inv) => ({ kind: 'sent' as const, inv })) },
  ], [results, waiting, unanswered]);
  // Everything the rows, headers and footers draw besides `sections`.
  const rowDeps = useMemo(
    () => ({ inviting, acting, resending, withdrawing, authHeader, loading, refreshFailed, colors }),
    [inviting, acting, resending, withdrawing, authHeader, loading, refreshFailed, colors],
  );

  // photoURL is an attachment id behind auth (users.photo_url), as in app/group-info.tsx.
  const avatar = (name: string | null, photoURL: string | null, size = 36) => (
    photoURL && authHeader
      ? <Image source={{ uri: attachmentUrl(photoURL), headers: { Authorization: authHeader } }} style={{ width: size, height: size, borderRadius: size / 2 }} />
      : (
        <View style={[st.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: brandAlpha(0.18) }]}>
          <Text style={{ color: colors.primary, fontWeight: '800', fontSize: size * 0.4 }}>
            {initialOf(name)}
          </Text>
        </View>
      )
  );

  if (!chatId) return <GroupNotFound title="Add people" />;

  return (
    <KeyboardSafe style={{ flex: 1, backgroundColor: colors.bg }}>
      <AuroraBackground variant="chat" />
      <Stack.Screen options={{
        headerShown: true, title: 'Add people', headerTitleAlign: 'center',
        headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text, headerShadowVisible: false,
      }} />
      <SectionList<Row, Section>
        sections={sections}
        keyExtractor={rowKey}
        stickySectionHeadersEnabled={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        extraData={rowDeps}
        ListHeaderComponent={<>
          <Text style={[st.h, { color: colors.text }]} accessibilityRole="header">Add to {groupName}</Text>
          {params.fresh === '1' && sent.length === 0 && (
            <Text style={{ color: colors.textDim, fontSize: 12.5, lineHeight: 17, marginBottom: 12 }}>
              {groupName} is already created, with just you in it. If you go back without inviting
              anyone it stays that way; you can leave it from Group info.
            </Text>
          )}

          <View style={[st.field, { borderColor: colors.glassStroke, backgroundColor: colors.glassSoft }]}>
            <Ionicons name="search" size={17} color={colors.textDim} />
            <TextInput
              value={q} onChangeText={setQ}
              placeholder="Name, phone number or email"
              placeholderTextColor={colors.textFaint}
              style={[st.input, { color: colors.text }]}
              autoCapitalize="none" autoCorrect={false} returnKeyType="search"
              accessibilityLabel="Search people to invite"
            />
            {searching && <ActivityIndicator size="small" color={colors.primary} />}
            {!searching && q.length > 0 && (
              <TouchableOpacity onPress={() => setQ('')} accessibilityRole="button" accessibilityLabel="Clear the search" hitSlop={12}>
                <Ionicons name="close-circle" size={17} color={colors.textFaint} />
              </TouchableOpacity>
            )}
          </View>

          <Text style={{ color: colors.textFaint, fontSize: 11.5, marginTop: 8, lineHeight: 16 }}>
            Search people you already chat with by name, or anyone on crazzychat by their exact
            phone number or email.
          </Text>

          {searched && searchFailed && !searching && (
            <View style={[st.empty, { borderColor: colors.danger }]} accessibilityLiveRegion="polite">
              <Ionicons name="cloud-offline-outline" size={17} color={colors.danger} />
              <Text style={{ color: colors.danger, fontSize: 12.5, flex: 1, lineHeight: 17 }}>
                Couldn’t search right now. Check your connection and try again.
              </Text>
            </View>
          )}

          {searched && !searchFailed && results.length === 0 && !searching && (
            <View style={[st.empty, { borderColor: colors.glassStroke }]}>
              <Ionicons name="person-outline" size={17} color={colors.textDim} />
              <Text style={{ color: colors.textDim, fontSize: 12.5, flex: 1, lineHeight: 17 }}>
                Nobody found. They need a crazzychat account before they can be added — there is
                no invitation to send outside the app.
              </Text>
            </View>
          )}
        </>}
        renderSectionHeader={({ section }) => section.key === 'waiting' ? (
          <>
            {refreshFailed && !loading && (
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Couldn't refresh invitations. Retry" onPress={() => { setLoading(true); refresh(); }}
                style={[st.empty, { borderColor: colors.danger, marginTop: 24 }]}>
                <Ionicons name="cloud-offline-outline" size={17} color={colors.danger} />
                <Text style={{ color: colors.danger, fontSize: 12.5, flex: 1 }}>Couldn’t refresh the lists below. Tap to retry.</Text>
              </TouchableOpacity>
            )}

            {/* ── waiting on the owner ── */}
            <View style={st.sechead}>
              <Text style={[st.h, { color: colors.text, marginBottom: 0 }]} accessibilityRole="header">Waiting ({waiting.length})</Text>
              {loading && <ActivityIndicator size="small" color={colors.primary} />}
            </View>
          </>
        ) : section.key === 'sent' ? (
          <>
            {/* ── sent but unanswered ── */}
            <View style={st.sechead}>
              <Text style={[st.h, { color: colors.text, marginBottom: 0 }]} accessibilityRole="header">Sent ({unanswered.length})</Text>
            </View>
          </>
        ) : null}
        renderSectionFooter={({ section }) => section.key === 'waiting' ? (
          <>
            {!loading && waiting.length === 0 && (
              <Text style={{ color: colors.textDim, fontSize: 13.5 }}>
                Nobody is waiting. People appear here once they accept an invitation or ask to join.
              </Text>
            )}
          </>
        ) : section.key === 'sent' ? (
          <>
            {!loading && unanswered.length === 0 && (
              <Text style={{ color: colors.textDim, fontSize: 13.5 }}>
                No invitations outstanding.
              </Text>
            )}
          </>
        ) : null}
        renderItem={({ item }) => {
          if (item.kind === 'result') {
            const c = item.c;
            return (
              <View style={[st.row, { borderColor: colors.glassStroke }]}>
                {avatar(c.name, c.photoURL)}
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ color: colors.text, fontWeight: '600', fontSize: 14 }} numberOfLines={1}>
                    {c.name ?? 'crazzychat user'}
                  </Text>
                  {c.state !== 'invitable' && (
                    <Text style={{ color: colors.textDim, fontSize: 11.5 }}>{CANDIDATE_NOTE[c.state]}</Text>
                  )}
                </View>
                {c.state === 'invitable' ? (
                  <TouchableOpacity onPress={() => invite(c)} disabled={inviting === c.id}
                    accessibilityRole="button" accessibilityLabel={`Invite ${c.name ?? 'crazzychat user'}`}
                    accessibilityState={{ disabled: inviting === c.id, busy: inviting === c.id }} hitSlop={6}
                    style={[st.pill, { backgroundColor: colors.primary }]}>
                    {inviting === c.id ? <ActivityIndicator size="small" color={colors.onPrimary} />
                      : <Text style={[st.pillTxt, { color: colors.onPrimary }]}>Invite</Text>}
                  </TouchableOpacity>
                ) : (
                  <Ionicons
                    name={c.state === 'member' ? 'checkmark-circle' : c.state === 'invited' ? 'time' : 'lock-closed'}
                    size={19} color={colors.textFaint}
                  />
                )}
              </View>
            );
          }
          if (item.kind === 'waiting') {
            const p = item.p;
            return (
              <View style={[st.row, { borderColor: colors.glassStroke }]}>
                {avatar(p.name, p.photoURL)}
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ color: colors.text, fontWeight: '600', fontSize: 14 }} numberOfLines={1}>
                    {p.name ?? 'crazzychat user'}
                  </Text>
                  <Text style={{ color: p.canApprove ? colors.primary : colors.textDim, fontSize: 11.5 }} numberOfLines={1}>
                    {isLinkRow(p) ? 'Opened an invite link — approve to let them in'
                      : p.requested ? 'Asked to join'
                      : p.canApprove ? 'Accepted — approve to let them in'
                      : 'Invited, has not answered'}
                  </Text>
                </View>
                {acting === queueKey(p) ? <ActivityIndicator size="small" color={colors.primary} /> : (
                  <>
                    {p.canApprove && (
                      <TouchableOpacity onPress={() => approve(p)} style={[st.pill, { backgroundColor: colors.success }]} hitSlop={6}
                        accessibilityRole="button" accessibilityLabel={`Approve ${p.name ?? 'crazzychat user'}`}>
                        <Text style={[st.pillTxt, { color: inkOn(colors.success) }]}>Approve</Text>
                      </TouchableOpacity>
                    )}
                    {p.canReject && (
                      <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Decline ${p.name ?? "crazzychat user"}`} onPress={() => decline(p)} style={st.rowBtn} hitSlop={8}>
                        <Ionicons name="close-circle" size={19} color={colors.danger} />
                      </TouchableOpacity>
                    )}
                  </>
                )}
              </View>
            );
          }
          const inv = item.inv;
          const t = tone(STATUS_TONE[inv.status]);
          return (
            <View style={[st.row, { borderColor: colors.glassStroke }]}>
              <View style={[st.rowIcon, { backgroundColor: tint(t, 0.13) }]}>
                <Ionicons name={inv.status === 'expired' ? 'hourglass' : 'paper-plane'} size={16} color={t} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: colors.text, fontWeight: '600', fontSize: 14 }} numberOfLines={1}>
                  {inv.name ?? inv.ref ?? 'crazzychat user'}
                </Text>
                <Text style={{ color: t, fontSize: 11.5 }}>{STATUS_LABEL[inv.status]}</Text>
              </View>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Resend the invitation to ${inv.name ?? inv.ref ?? "crazzychat user"}`}
                accessibilityState={{ disabled: resending != null, busy: resending === inv.id }}
                disabled={resending != null} onPress={() => doResend(inv)} style={st.rowBtn} hitSlop={8}>
                {resending === inv.id
                  ? <ActivityIndicator size="small" color={colors.primary} />
                  : <Ionicons name="refresh" size={17} color={colors.primary} />}
              </TouchableOpacity>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel={`${inv.mine ? 'Withdraw' : 'Revoke'} the invitation to ${inv.name ?? inv.ref ?? "crazzychat user"}`}
                accessibilityState={{ disabled: withdrawing != null, busy: withdrawing === inv.id }}
                disabled={withdrawing != null} onPress={() => doWithdraw(inv)} style={st.rowBtn} hitSlop={8}>
                {withdrawing === inv.id
                  ? <ActivityIndicator size="small" color={colors.danger} />
                  : <Ionicons name="close-circle" size={17} color={colors.danger} />}
              </TouchableOpacity>
            </View>
          );
        }}
        ListFooterComponent={
          <View style={[st.footer, { borderColor: colors.glassStroke }]}>
            <Ionicons name="lock-closed-outline" size={15} color={colors.textDim} />
            <Text style={{ color: colors.textDim, fontSize: 11.5, flex: 1, lineHeight: 16 }}>
              Invitations sent here go to one account and cannot be forwarded. A group can
              also have invite links (Group info → Invite links): anyone with a link can join,
              or ask to, if link joins need approval.
            </Text>
          </View>
        }
      />
    </KeyboardSafe>
  );
}

const st = StyleSheet.create({
  h: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 10 },
  field: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, minHeight: 50 },
  input: { flex: 1, fontSize: 15 },
  empty: { flexDirection: 'row', alignItems: 'center', gap: 9, padding: 12, borderWidth: 1, borderRadius: 12, marginTop: 14 },
  sechead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 30, marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth },
  rowIcon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  rowBtn: { padding: 6 },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  pill: { paddingHorizontal: 14, minHeight: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', minWidth: 74 },
  pillTxt: { fontSize: 12.5, fontWeight: '800' },
  footer: { flexDirection: 'row', gap: 9, alignItems: 'flex-start', marginTop: 28, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth },
});
