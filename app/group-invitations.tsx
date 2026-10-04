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
  View, StyleSheet, TouchableOpacity, FlatList, Alert,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { Stack, useFocusEffect, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { AuroraBackground } from '../components/ui/AuroraBackground';
import { AppText as Text } from '../components/ui/Text';
import { brandAlpha } from '../constants/theme';
import { myInvitations, acceptInvitation, rejectInvitation, type MyInvitation } from '../lib/chatService';
import { groupTypeInfo, hexColorOr, inkOn } from '../lib/groups/catalog';

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
  // Last load failed: an error with Retry when nothing is listed (never
  // "No invitations"), a banner over the list otherwise.
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try { setItems(await myInvitations()); setFailed(false); }
    catch { setFailed(true); /* keep whatever is on screen */ }
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
        // joined something they have to go and find. The privacy sheet rides on
        // top so the FIRST thing a new member decides is what this group may
        // see of them — joining must never silently start location sharing
        // (sharing is off until they flip it themselves; this makes that
        // choice visible instead of buried in settings).
        //
        // Only a typed group (a Space) lives in /family and shares location; a
        // plain chat group (New group in Chats) opens as a chat.
        if (inv.groupType) {
          router.push({ pathname: '/family' as any, params: { groupId: res.chatId } });
          router.push({ pathname: '/group-privacy' as any, params: { groupId: res.chatId, name: inv.name ?? '' } });
        } else {
          router.push({ pathname: '/chat', params: { id: String(res.chatId) } });
        }
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
          if (acting) return;
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
    // Server data, but drawn as-is: only a known glyph and a #RRGGBB colour.
    const accent = hexColorOr(inv.color, type.color);
    const icon = (inv.icon && inv.icon in Ionicons.glyphMap ? inv.icon : type.icon) as keyof typeof Ionicons.glyphMap;
    const waiting = inv.status === 'accepted';
    const busy = acting === inv.id;
    const ink = inkOn(accent);
    const status = inv.requested
      ? 'You asked to join. An admin will decide.'
      : waiting && inv.canAccept
        // Stranded: they already said yes, but the group now joins on
        // accept. Telling them to wait would be false — the server will
        // admit them the moment they tap, and nothing else ever will.
        ? `You accepted this earlier but were never added. Tap Join to finish.`
        : waiting
          ? `You accepted. ${inv.inviterName ?? 'The group'} is waiting on an admin to approve you.`
          : `${inv.inviterName ?? 'Someone'} invited you.${
              inv.joinsOnAccept ? ' Accepting adds you straight away.' : ' An admin approves after you accept.'}`;
    const members = `${inv.memberCount} ${inv.memberCount === 1 ? 'member' : 'members'}`;

    return (
      <View style={[st.card, { backgroundColor: colors.glassSoft, borderColor: waiting ? accent : colors.border }]}>
        {/* One element for the screen reader: the facts, then the buttons. */}
        <View accessible accessibilityLabel={`${inv.name ?? 'A group'}, ${type.label}, ${members}. ${status} ${expiresIn(inv.expiresAt)}.`}>
        <View style={st.cardTop}>
          <View style={[st.icon, { backgroundColor: accent + '22' }]}>
            <Ionicons name={icon} size={22} color={accent} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15.5 }} numberOfLines={1}>
              {inv.name ?? 'A group'}
            </Text>
            <Text style={{ color: colors.textDim, fontSize: 12.5 }} numberOfLines={1}>
              {type.label} · {members}
            </Text>
          </View>
        </View>

        <Text style={{ color: colors.textDim, fontSize: 13, marginTop: 10, lineHeight: 18 }}>{status}</Text>

        <Text style={{ color: colors.textFaint, fontSize: 11.5, marginTop: 6 }}>
          {expiresIn(inv.expiresAt)}
        </Text>
        </View>

        <View style={st.actions}>
          {busy ? (
            <View style={[st.btn, { backgroundColor: colors.border }]}><ActivityIndicator color={colors.text} accessibilityLabel="Working" /></View>
          ) : (
            <>
              {inv.canAccept && (
                <TouchableOpacity onPress={() => accept(inv)} style={[st.btn, { backgroundColor: accent }]}
                  accessibilityRole="button" accessibilityLabel={`${inv.joinsOnAccept ? 'Join' : 'Accept'} ${inv.name ?? 'this group'}`}>
                  <Ionicons name="checkmark" size={17} color={ink} />
                  <Text style={[st.btnTxt, { color: ink }]}>{inv.joinsOnAccept ? 'Join' : 'Accept'}</Text>
                </TouchableOpacity>
              )}
              {/* Only a genuine wait shows "Waiting". A stranded invitation is
                  NOT waiting on anyone — it is waiting on this button — and
                  showing both at once told people to sit still next to the
                  control that would have finished the job. */}
              {waiting && !inv.canAccept && (
                <View style={[st.btn, { backgroundColor: 'transparent', borderWidth: 1, borderColor: accent }]}
                  accessible accessibilityRole="text" accessibilityLabel="Waiting for an admin">
                  <Ionicons name="hourglass-outline" size={16} color={accent} />
                  <Text style={[st.btnTxt, { color: accent }]}>Waiting</Text>
                </View>
              )}
              {inv.canDecline && (
                <TouchableOpacity onPress={() => decline(inv)}
                  accessibilityRole="button" accessibilityLabel={`${inv.requested ? 'Withdraw your request to' : 'Decline'} ${inv.name ?? 'this group'}`}
                  style={[st.btn, { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.glassStroke, flex: 0.7 }]}>
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
      <AuroraBackground variant="chat" />
      <Stack.Screen options={{
        headerShown: true, title: 'Invitations', headerTitleAlign: 'center',
        headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text, headerShadowVisible: false,
      }} />

      {loading ? (
        <View style={st.center}><ActivityIndicator color={colors.primary} accessibilityLabel="Loading invitations" /></View>
      ) : failed && items.length === 0 ? (
        <View style={[st.center, { padding: 32 }]}>
          <Ionicons name="cloud-offline-outline" size={30} color={colors.textFaint} />
          <Text style={{ color: colors.text, fontWeight: '700', marginTop: 10 }}>Couldn’t load invitations</Text>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Retry loading invitations"
            onPress={() => { setLoading(true); load(); }}
            style={[st.btn, { flex: 0, paddingHorizontal: 24, marginTop: 14, borderWidth: 1, borderColor: colors.glassStroke }]}>
            <Text style={[st.btnTxt, { color: colors.primary }]}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(inv) => String(inv.id)}
          renderItem={({ item }) => card(item)}
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} tintColor={colors.primary}
              onRefresh={() => { setRefreshing(true); load(); }} />
          }
          ListHeaderComponent={failed ? (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Couldn't refresh invitations. Retry"
              onPress={() => { setRefreshing(true); load(); }}
              style={[st.banner, { borderColor: colors.danger }]}>
              <Ionicons name="cloud-offline-outline" size={15} color={colors.danger} />
              <Text style={{ color: colors.danger, fontSize: 12.5, flex: 1 }}>Couldn’t refresh — this list may be out of date. Tap to retry.</Text>
            </TouchableOpacity>
          ) : null}
          ListEmptyComponent={
            <View style={[st.emptyWrap, { borderColor: colors.glassStroke, backgroundColor: brandAlpha(0.06) }]}>
              <Ionicons name="mail-open-outline" size={30} color={colors.primary} />
              <Text style={{ color: colors.text, fontWeight: '700', fontSize: 15, marginTop: 10 }}>
                No invitations
              </Text>
              <Text style={{ color: colors.textDim, fontSize: 13, textAlign: 'center', marginTop: 6, lineHeight: 18 }}>
                When somebody adds you to a group, it appears here for you to accept or decline.
              </Text>
            </View>
          }
          ListFooterComponent={items.length > 0 ? (
            <View style={[st.footer, { borderColor: colors.glassStroke }]}>
              <Ionicons name="lock-closed-outline" size={15} color={colors.textDim} />
              <Text style={{ color: colors.textDim, fontSize: 11.5, flex: 1, lineHeight: 16 }}>
                Invitations are addressed to your account and cannot be opened by anyone else.
                Nobody is added to a group without accepting first.
              </Text>
            </View>
          ) : null}
        />
      )}
    </View>
  );
}

const st = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderWidth: 1, borderRadius: 12, marginBottom: 12 },
  card: { borderWidth: 1, borderRadius: 16, padding: 15, marginBottom: 12 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', gap: 9, marginTop: 14 },
  btn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, minHeight: 44, borderRadius: 12 },
  btnTxt: { fontSize: 14, fontWeight: '800' },
  emptyWrap: { alignItems: 'center', padding: 26, borderWidth: 1, borderRadius: 18, marginTop: 30 },
  footer: { flexDirection: 'row', gap: 9, alignItems: 'flex-start', marginTop: 20, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth },
});
