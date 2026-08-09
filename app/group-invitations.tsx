// app/group-invitations.tsx — the invitee's side: groups that have asked for me
// (Groups & Circles, membership v2).
//
// This screen is where an invitation actually gets answered. Before membership
// v2 there was nowhere to answer one: an invitation arrived as a link, and
// "accepting" meant opening that link. Removing links removed the only way in,
// so this is not a nicety — it is the door.
//
// TWO KINDS OF ROW, and the difference matters enough to say out loud on each
// card rather than in a legend:
//
//   Pending   they asked, I have not answered.
//   Accepted  I said yes and an owner has not admitted me yet. Under the
//             default strict mode that wait is normal and can last days.
//
// Without the second kind, someone who accepts on Monday sees their invitation
// disappear with no group to show for it, concludes it failed, and never tries
// again. So an accepted invitation stays here, visibly waiting, until it turns
// into membership or somebody ends it.

import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { Stack, useFocusEffect, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { brandAlpha } from '../constants/theme';
import { myInvitations, acceptInvitation, rejectInvitation, type MyInvitation } from '../lib/chatService';
import { groupTypeInfo } from '../lib/groups/catalog';

/** How long until it lapses, in words. Precision here would be false comfort. */
const expiresIn = (iso: string) => {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'expired';
  const days = Math.floor(ms / 86_400_000);
  if (days >= 2) return `${days} days left`;
  const hours = Math.round(ms / 3_600_000);
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'} left`;
  return 'less than an hour left';
};

export default function GroupInvitationsScreen() {
  const { colors } = useTheme();
  const [items, setItems] = useState<MyInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [acting, setActing] = useState<number | null>(null);

  const load = useCallback(async () => {
    try { setItems(await myInvitations()); }
    catch { /* offline or unauthorised: keep whatever is on screen */ }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const accept = async (inv: MyInvitation) => {
    if (acting) return;
    setActing(inv.id);
    try {
      const res = await acceptInvitation(inv.id);
      await load();
      if (res.joined) {
        // Straight in: take them there. Anything less makes the group they just
        // joined something they have to go and find.
        router.push({ pathname: '/family' as any, params: { groupId: res.chatId } });
      } else {
        Alert.alert(
          'Waiting for approval',
          `You have accepted. ${inv.name ?? 'The group'} admits new members only once an admin approves, so you will be added when they do.`,
        );
      }
    } catch (e: any) {
      Alert.alert('Could not accept', e?.message ?? 'Try again.');
      load();
    } finally { setActing(null); }
  };

  const decline = (inv: MyInvitation) => {
    Alert.alert(
      inv.status === 'accepted' ? 'Change your mind?' : 'Decline this invitation?',
      inv.status === 'accepted'
        ? `You accepted ${inv.name ?? 'this group'} but have not been added yet. Declining now withdraws that.`
        : `${inv.name ?? 'This group'} will be told you declined.`,
      [
        { text: 'Keep it', style: 'cancel' },
        { text: 'Decline', style: 'destructive', onPress: async () => {
          setActing(inv.id);
          try { await rejectInvitation(inv.id); await load(); }
          catch (e: any) { Alert.alert('Could not decline', e?.message ?? 'Try again.'); }
          finally { setActing(null); }
        } },
      ],
    );
  };

  const card = (inv: MyInvitation) => {
    const type = groupTypeInfo(inv.groupType);
    const accent = inv.color || type.color;
    const icon = (inv.icon || type.icon) as keyof typeof Ionicons.glyphMap;
    const waiting = inv.status === 'accepted';
    const busy = acting === inv.id;

    return (
      <View key={inv.id} style={[st.card, { backgroundColor: colors.card, borderColor: waiting ? accent : colors.border }]}>
        <View style={st.cardTop}>
          <View style={[st.icon, { backgroundColor: accent + '22' }]}>
            <Ionicons name={icon} size={22} color={accent} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15.5 }} numberOfLines={1}>
              {inv.name ?? 'A group'}
            </Text>
            <Text style={{ color: colors.textDim, fontSize: 12.5 }} numberOfLines={1}>
              {type.label} · {inv.memberCount} {inv.memberCount === 1 ? 'member' : 'members'}
            </Text>
          </View>
        </View>

        <Text style={{ color: colors.textDim, fontSize: 13, marginTop: 10, lineHeight: 18 }}>
          {inv.requested
            ? 'You asked to join. An admin will decide.'
            : waiting
              ? `You accepted. ${inv.inviterName ?? 'The group'} is waiting on an admin to approve you.`
              : `${inv.inviterName ?? 'Someone'} invited you.${
                  inv.joinsOnAccept ? ' Accepting adds you straight away.' : ' An admin approves after you accept.'}`}
        </Text>

        <Text style={{ color: colors.textFaint, fontSize: 11.5, marginTop: 6 }}>
          {expiresIn(inv.expiresAt)}
        </Text>

        <View style={st.actions}>
          {busy ? (
            <View style={[st.btn, { backgroundColor: colors.border }]}><ActivityIndicator color={colors.text} /></View>
          ) : (
            <>
              {inv.canAccept && (
                <TouchableOpacity onPress={() => accept(inv)} style={[st.btn, { backgroundColor: accent }]}>
                  <Ionicons name="checkmark" size={17} color="#fff" />
                  <Text style={st.btnTxt}>{inv.joinsOnAccept ? 'Join' : 'Accept'}</Text>
                </TouchableOpacity>
              )}
              {waiting && (
                <View style={[st.btn, { backgroundColor: 'transparent', borderWidth: 1, borderColor: accent }]}>
                  <Ionicons name="hourglass-outline" size={16} color={accent} />
                  <Text style={[st.btnTxt, { color: accent }]}>Waiting</Text>
                </View>
              )}
              {inv.canDecline && (
                <TouchableOpacity onPress={() => decline(inv)}
                  style={[st.btn, { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border, flex: 0.7 }]}>
                  <Text style={[st.btnTxt, { color: colors.textDim }]}>
                    {inv.requested ? 'Withdraw' : 'Decline'}
                  </Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </View>
      </View>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: 'Invitations', headerTitleAlign: 'center' }} />

      {loading ? (
        <View style={st.center}><ActivityIndicator color={colors.primary} /></View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} tintColor={colors.primary}
              onRefresh={() => { setRefreshing(true); load(); }} />
          }
        >
          {items.length === 0 && (
            <View style={[st.emptyWrap, { borderColor: colors.border, backgroundColor: brandAlpha(0.06) }]}>
              <Ionicons name="mail-open-outline" size={30} color={colors.primary} />
              <Text style={{ color: colors.text, fontWeight: '700', fontSize: 15, marginTop: 10 }}>
                No invitations
              </Text>
              <Text style={{ color: colors.textDim, fontSize: 13, textAlign: 'center', marginTop: 6, lineHeight: 18 }}>
                When somebody adds you to a group, it appears here for you to accept or decline.
              </Text>
            </View>
          )}

          {items.map(card)}

          {items.length > 0 && (
            <View style={[st.footer, { borderColor: colors.border }]}>
              <Ionicons name="lock-closed-outline" size={15} color={colors.textDim} />
              <Text style={{ color: colors.textDim, fontSize: 11.5, flex: 1, lineHeight: 16 }}>
                Invitations are addressed to your account and cannot be opened by anyone else.
                Nobody is added to a group without accepting first.
              </Text>
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: { borderWidth: 1, borderRadius: 16, padding: 15, marginBottom: 12 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', gap: 9, marginTop: 14 },
  btn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, height: 44, borderRadius: 12 },
  btnTxt: { color: '#fff', fontSize: 14, fontWeight: '800' },
  emptyWrap: { alignItems: 'center', padding: 26, borderWidth: 1, borderRadius: 18, marginTop: 30 },
  footer: { flexDirection: 'row', gap: 9, alignItems: 'flex-start', marginTop: 20, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth },
});
