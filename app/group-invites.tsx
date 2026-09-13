// app/group-invites.tsx — add people to a group, entirely inside VaultChat
// (Groups & Circles, membership v2).
//
// WHAT IS NOT HERE, deliberately: no QR code, no shareable link, no SMS or
// WhatsApp hand-off, no "copy invite code". Every one of those turns an
// invitation into something forwardable, and a forwardable invitation is a
// credential — the wrong way to protect a group that is mostly family.
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
  View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput, Alert,
  ActivityIndicator, Platform, Image,
} from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { brandAlpha } from '../constants/theme';
import {
  createInvitation, listInvitations, resendInvitation, revokeInvitation, cancelInvitation,
  inviteCandidates, pendingMembers, approveMember, rejectMember,
  type Invitation, type InvitationStatus, type InviteCandidate, type PendingMember,
} from '../lib/chatService';

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

export default function GroupInvitesScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ chatId?: string; name?: string }>();
  const chatId = String(params.chatId || '');
  const groupName = String(params.name || 'this group');

  const [q, setQ] = useState('');
  const [results, setResults] = useState<InviteCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [inviting, setInviting] = useState<string | null>(null);

  const [waiting, setWaiting] = useState<PendingMember[]>([]);
  const [sent, setSent] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    if (!chatId) { setLoading(false); return; }
    // Settled either way: a permission error on one half should not blank the
    // other, and neither should stop the spinner from clearing.
    const [inv, pend] = await Promise.allSettled([
      listInvitations(chatId),
      pendingMembers(chatId),
    ]);
    if (inv.status === 'fulfilled') setSent(inv.value);
    if (pend.status === 'fulfilled') setWaiting(pend.value);
    setLoading(false);
  }, [chatId]);

  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));

  // Debounced search. The sequence guard makes a slow early response unable to
  // overwrite a fast later one — otherwise typing quickly leaves you looking at
  // results for a prefix you have already deleted.
  const seq = useRef(0);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setResults([]); setSearched(false); setSearching(false); return; }
    setSearching(true);
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const hits = await inviteCandidates(chatId, term);
        if (mine === seq.current) { setResults(hits); setSearched(true); }
      } catch {
        if (mine === seq.current) { setResults([]); setSearched(true); }
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

  const approve = async (p: PendingMember) => {
    if (acting) return;
    setActing(p.id);
    try { await approveMember(chatId, p.id); await refresh(); }
    catch (e: any) { Alert.alert('Could not approve', e?.message ?? 'Try again.'); }
    finally { setActing(null); }
  };

  const decline = (p: PendingMember) => {
    Alert.alert(
      p.requested ? 'Turn down this request?' : 'Turn down this person?',
      `${p.name ?? 'They'} will not join ${groupName}. You can invite them again later.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Turn down', style: 'destructive', onPress: async () => {
          setActing(p.id);
          try { await rejectMember(chatId, p.id); await refresh(); }
          catch (e: any) { Alert.alert('Could not do that', e?.message ?? 'Try again.'); }
          finally { setActing(null); }
        } },
      ],
    );
  };

  const doResend = async (inv: Invitation) => {
    try { await resendInvitation(chatId, inv.id); refresh(); }
    catch (e: any) { Alert.alert('Could not renew', e?.message ?? 'Try again.'); }
  };

  // Withdrawing your OWN invitation and revoking somebody else's are different
  // acts on the server — they land in different statuses so the group's history
  // still says who ended it. Offering the right one is the only way that
  // distinction survives contact with a user.
  const doWithdraw = (inv: Invitation) => {
    Alert.alert(
      inv.mine ? 'Withdraw your invitation?' : 'Revoke this invitation?',
      'It disappears from their invitations straight away.',
      [
        { text: 'Keep it', style: 'cancel' },
        { text: inv.mine ? 'Withdraw' : 'Revoke', style: 'destructive', onPress: async () => {
          try {
            if (inv.mine) await cancelInvitation(chatId, inv.id);
            else await revokeInvitation(chatId, inv.id);
            refresh();
          } catch (e: any) { Alert.alert('Could not do that', e?.message ?? 'Try again.'); }
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

  const avatar = (name: string | null, photoURL: string | null, size = 36) => (
    photoURL
      ? <Image source={{ uri: photoURL }} style={{ width: size, height: size, borderRadius: size / 2 }} />
      : (
        <View style={[st.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: brandAlpha(0.18) }]}>
          <Text style={{ color: colors.primary, fontWeight: '800', fontSize: size * 0.4 }}>
            {(name ?? '?').trim()[0]?.toUpperCase() ?? '?'}
          </Text>
        </View>
      )
  );

  return (
    <KeyboardSafe style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{
        headerShown: true, title: 'Add people', headerTitleAlign: 'center',
        headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text, headerShadowVisible: false,
      }} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">

        <Text style={[st.h, { color: colors.text }]}>Add to {groupName}</Text>

        <View style={[st.field, { borderColor: colors.glassStroke, backgroundColor: colors.glassSoft }]}>
          <Ionicons name="search" size={17} color={colors.textDim} />
          <TextInput
            value={q} onChangeText={setQ}
            placeholder="Name, email or phone number"
            placeholderTextColor={colors.textFaint}
            style={[st.input, { color: colors.text }]}
            autoCapitalize="none" autoCorrect={false} returnKeyType="search"
          />
          {searching && <ActivityIndicator size="small" color={colors.primary} />}
          {!searching && q.length > 0 && (
            <TouchableOpacity onPress={() => setQ('')} accessibilityLabel="Clear the search" hitSlop={8}>
              <Ionicons name="close-circle" size={17} color={colors.textFaint} />
            </TouchableOpacity>
          )}
        </View>

        <Text style={{ color: colors.textFaint, fontSize: 11.5, marginTop: 8, lineHeight: 16 }}>
          Search people you already chat with by name, or anyone on VaultChat by their exact
          email or phone number.
        </Text>

        {searched && results.length === 0 && !searching && (
          <View style={[st.empty, { borderColor: colors.glassStroke }]}>
            <Ionicons name="person-outline" size={17} color={colors.textDim} />
            <Text style={{ color: colors.textDim, fontSize: 12.5, flex: 1, lineHeight: 17 }}>
              Nobody found. They need a VaultChat account before they can be added — there is
              no invitation to send outside the app.
            </Text>
          </View>
        )}

        {results.map((c) => (
          <View key={c.id} style={[st.row, { borderColor: colors.glassStroke }]}>
            {avatar(c.name, c.photoURL)}
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: colors.text, fontWeight: '600', fontSize: 14 }} numberOfLines={1}>
                {c.name ?? 'VaultChat user'}
              </Text>
              {c.state !== 'invitable' && (
                <Text style={{ color: colors.textDim, fontSize: 11.5 }}>{CANDIDATE_NOTE[c.state]}</Text>
              )}
            </View>
            {c.state === 'invitable' ? (
              <TouchableOpacity onPress={() => invite(c)} disabled={inviting === c.id}
                style={[st.pill, { backgroundColor: colors.primary }]}>
                {inviting === c.id ? <ActivityIndicator size="small" color="#fff" />
                  : <Text style={st.pillTxt}>Invite</Text>}
              </TouchableOpacity>
            ) : (
              <Ionicons
                name={c.state === 'member' ? 'checkmark-circle' : c.state === 'invited' ? 'time' : 'lock-closed'}
                size={19} color={colors.textFaint}
              />
            )}
          </View>
        ))}

        {/* ── waiting on the owner ── */}
        <View style={st.sechead}>
          <Text style={[st.h, { color: colors.text, marginBottom: 0 }]}>Waiting ({waiting.length})</Text>
          {loading && <ActivityIndicator size="small" color={colors.primary} />}
        </View>

        {!loading && waiting.length === 0 && (
          <Text style={{ color: colors.textDim, fontSize: 13.5 }}>
            Nobody is waiting. People appear here once they accept an invitation or ask to join.
          </Text>
        )}

        {waiting.map((p) => (
          <View key={p.id} style={[st.row, { borderColor: colors.glassStroke }]}>
            {avatar(p.name, p.photoURL)}
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: colors.text, fontWeight: '600', fontSize: 14 }} numberOfLines={1}>
                {p.name ?? 'VaultChat user'}
              </Text>
              <Text style={{ color: p.canApprove ? colors.primary : colors.textDim, fontSize: 11.5 }} numberOfLines={1}>
                {p.requested ? 'Asked to join'
                  : p.canApprove ? 'Accepted — approve to let them in'
                  : 'Invited, has not answered'}
              </Text>
            </View>
            {acting === p.id ? <ActivityIndicator size="small" color={colors.primary} /> : (
              <>
                {p.canApprove && (
                  <TouchableOpacity onPress={() => approve(p)} style={[st.pill, { backgroundColor: colors.success }]}>
                    <Text style={st.pillTxt}>Approve</Text>
                  </TouchableOpacity>
                )}
                {p.canReject && (
                  <TouchableOpacity accessibilityLabel={`Decline ${p.name ?? "VaultChat user"}`} onPress={() => decline(p)} style={st.rowBtn}>
                    <Ionicons name="close-circle" size={19} color={colors.danger} />
                  </TouchableOpacity>
                )}
              </>
            )}
          </View>
        ))}

        {/* ── sent but unanswered ── */}
        <View style={st.sechead}>
          <Text style={[st.h, { color: colors.text, marginBottom: 0 }]}>Sent ({unanswered.length})</Text>
        </View>

        {!loading && unanswered.length === 0 && (
          <Text style={{ color: colors.textDim, fontSize: 13.5 }}>
            No invitations outstanding.
          </Text>
        )}

        {unanswered.map((inv) => {
          const t = tone(STATUS_TONE[inv.status]);
          return (
            <View key={inv.id} style={[st.row, { borderColor: colors.glassStroke }]}>
              <View style={[st.rowIcon, { backgroundColor: t + '22' }]}>
                <Ionicons name={inv.status === 'expired' ? 'hourglass' : 'paper-plane'} size={16} color={t} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: colors.text, fontWeight: '600', fontSize: 14 }} numberOfLines={1}>
                  {inv.name ?? inv.ref ?? 'VaultChat user'}
                </Text>
                <Text style={{ color: t, fontSize: 11.5 }}>{STATUS_LABEL[inv.status]}</Text>
              </View>
              <TouchableOpacity accessibilityLabel={`Resend the invitation to ${inv.name ?? inv.ref ?? "VaultChat user"}`} onPress={() => doResend(inv)} style={st.rowBtn}>
                <Ionicons name="refresh" size={17} color={colors.primary} />
              </TouchableOpacity>
              <TouchableOpacity accessibilityLabel={`Withdraw the invitation to ${inv.name ?? inv.ref ?? "VaultChat user"}`} onPress={() => doWithdraw(inv)} style={st.rowBtn}>
                <Ionicons name="close-circle" size={17} color={colors.danger} />
              </TouchableOpacity>
            </View>
          );
        })}

        <View style={[st.footer, { borderColor: colors.glassStroke }]}>
          <Ionicons name="lock-closed-outline" size={15} color={colors.textDim} />
          <Text style={{ color: colors.textDim, fontSize: 11.5, flex: 1, lineHeight: 16 }}>
            Invitations stay inside VaultChat. There is no link or code to share, so an
            invitation cannot be forwarded to somebody it was not meant for.
          </Text>
        </View>
      </ScrollView>
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
  pillTxt: { color: '#fff', fontSize: 12.5, fontWeight: '800' },
  footer: { flexDirection: 'row', gap: 9, alignItems: 'flex-start', marginTop: 28, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth },
});
