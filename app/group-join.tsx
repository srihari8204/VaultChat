// app/group-join.tsx — ask to join a group (Groups & Circles, membership v2).
//
// Reached by tapping a group card someone shared into a chat. It is the ONLY
// way into a group you were not personally invited to, and it is deliberately a
// weak door: arriving here admits nothing. It sends a request, and an admin
// decides.
//
// That distinction is the whole reason this screen exists rather than a link.
// A link is a credential — whoever holds it gets in, including whoever it was
// forwarded to. A card is a pointer: it says a group exists and will hear you
// out. The strongest thing anyone can do with a forwarded one is ask.
//
// So the copy here never says "join". It says "ask", because that is what the
// button does, and a button that overstates what it did is how someone ends up
// believing they are in a group they are not.

import React, { useCallback, useState } from 'react';
import {
  View, StyleSheet, TouchableOpacity, ActivityIndicator, Alert, ScrollView,
} from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { AuroraBackground } from '../components/ui/AuroraBackground';
import { AppText as Text } from '../components/ui/Text';
import { brandAlpha } from '../constants/theme';
import { requestToJoin, myInvitations } from '../lib/chatService';
import { groupTypeInfo, hexColorOr } from '../lib/groups/catalog';

// 'invited': they already hold an invitation for this group; answering it is
// what lets them in, so this screen sends them to it rather than asking again.
type State = 'idle' | 'sending' | 'asked' | 'invited' | 'member';

export default function GroupJoinScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{
    groupId?: string; name?: string; groupType?: string; icon?: string; color?: string;
  }>();
  const groupId = String(params.groupId || '');
  const name = String(params.name || 'this group');

  const [state, setState] = useState<State>('idle');
  const [checking, setChecking] = useState(true);

  const type = groupTypeInfo(params.groupType ? String(params.groupType) : null);
  // The card's route params are whatever the sender's message carried: draw only
  // a known glyph and a #RRGGBB colour, else the type's own.
  const accent = hexColorOr(params.color ? String(params.color) : null, type.color);
  const rawIcon = String(params.icon || '');
  const icon = (rawIcon && rawIcon in Ionicons.glyphMap ? rawIcon : type.icon) as keyof typeof Ionicons.glyphMap;

  // Do I already have a request in flight? Without this the screen offers to
  // ask again, the server refuses on the duplicate guard, and the refusal reads
  // as a failure rather than as "you already did this".
  useFocusEffect(useCallback(() => {
    let live = true;
    (async () => {
      if (!groupId) { setChecking(false); return; }
      try {
        const mine = await myInvitations();
        if (!live) return;
        const row = mine.find((i) => i.chatId === groupId);
        if (row) setState(row.requested ? 'asked' : 'invited');
      } catch {
        // Offline: leave the button available. The server is the real guard,
        // and refusing to let someone try because a list did not load is worse
        // than letting them find out.
      } finally {
        if (live) setChecking(false);
      }
    })();
    return () => { live = false; };
  }, [groupId]));

  const ask = async () => {
    if (state !== 'idle' || !groupId) return;
    setState('sending');
    try {
      await requestToJoin(groupId);
      setState('asked');
    } catch (e: any) {
      const msg: string = e?.message ?? 'Try again.';
      // ponytail: the server sends these as 409 with prose only (no error code),
      // so the text is matched, and only on a 409. Replace with the code once
      // POST /chats/:id/membership/request returns one (backend handoff).
      if (e?.status === 409 && /already in this group/i.test(msg)) { setState('member'); return; }
      if (e?.status === 409 && /already have a request|already have an invitation/i.test(msg)) { setState('asked'); return; }
      setState('idle');
      Alert.alert('Could not ask to join', msg);
    }
  };

  if (!groupId) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
        <AuroraBackground variant="chat" />
        <Stack.Screen options={{ headerShown: true, headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text, headerShadowVisible: false, title: 'Join a group', headerTitleAlign: 'center' }} />
        <Text style={{ color: colors.text, fontWeight: '700', fontSize: 15 }}>Group not found</Text>
        <Text style={{ color: colors.textDim, fontSize: 13, textAlign: 'center', marginTop: 6 }}>This card did not say which group it is for.</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <AuroraBackground variant="chat" />
      <Stack.Screen options={{ headerShown: true, headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text, headerShadowVisible: false,  title: 'Join a group', headerTitleAlign: 'center' }} />
      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 32 }}>

        <View style={st.hero}>
          <View style={[st.icon, { backgroundColor: accent + '22', borderColor: accent }]}>
            <Ionicons name={icon} size={34} color={accent} />
          </View>
          <Text numberOfLines={1} accessibilityRole="header" style={{ color: colors.text, fontWeight: '800', fontSize: 21, marginTop: 14, textAlign: 'center' }}>
            {name}
          </Text>
          <Text style={{ color: colors.textDim, fontSize: 13.5, marginTop: 4 }}>{type.label}</Text>
        </View>

        {checking ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 34 }} accessibilityLabel="Checking for an earlier request" />
        ) : state === 'member' ? (
          <View style={[st.note, { borderColor: colors.success, backgroundColor: colors.success + '12' }]}>
            <Ionicons name="checkmark-circle" size={19} color={colors.success} />
            <Text style={{ color: colors.text, fontSize: 13.5, flex: 1, lineHeight: 19 }}>
              You are already in {name}.
            </Text>
          </View>
        ) : state === 'invited' ? (
          <>
            <View style={[st.note, { borderColor: accent, backgroundColor: accent + '12' }]}>
              <Ionicons name="mail-unread-outline" size={19} color={accent} />
              <Text style={{ color: colors.text, fontSize: 13.5, flex: 1, lineHeight: 19 }}>
                You already have an invitation to {name}. Answer it in your invitations.
              </Text>
            </View>
            <TouchableOpacity onPress={() => router.replace('/group-invitations' as any)}
              accessibilityRole="button" style={[st.btn, { backgroundColor: accent }]}>
              <Ionicons name="mail-open-outline" size={18} color="#fff" />
              <Text style={st.btnTxt}>Open invitations</Text>
            </TouchableOpacity>
          </>
        ) : state === 'asked' ? (
          <View style={[st.note, { borderColor: accent, backgroundColor: accent + '12' }]}>
            <Ionicons name="hourglass-outline" size={19} color={accent} />
            <Text style={{ color: colors.text, fontSize: 13.5, flex: 1, lineHeight: 19 }}>
              Your request is with the admins. You will be added if they approve it — nothing
              else is needed from you.
            </Text>
          </View>
        ) : (
          <>
            <Text style={{ color: colors.textDim, fontSize: 14, lineHeight: 20, marginTop: 30, textAlign: 'center' }}>
              You have not been invited to {name}. You can ask to join, and an admin will
              decide.
            </Text>
            <TouchableOpacity onPress={ask} disabled={state !== 'idle'}
              accessibilityRole="button" accessibilityLabel={`Ask to join ${name}`}
              accessibilityState={{ disabled: state !== 'idle', busy: state === 'sending' }}
              style={[st.btn, { backgroundColor: accent }]}>
              {state === 'sending'
                ? <ActivityIndicator color="#fff" />
                : <><Ionicons name="hand-right-outline" size={18} color="#fff" />
                    <Text style={st.btnTxt}>Ask to join</Text></>}
            </TouchableOpacity>
          </>
        )}

        {(state === 'asked' || state === 'member') && (
          <TouchableOpacity onPress={() => router.back()} accessibilityRole="button"
            style={[st.btn, { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.glassStroke }]}>
            <Text style={[st.btnTxt, { color: colors.text }]}>Done</Text>
          </TouchableOpacity>
        )}

        <View style={[st.footer, { borderColor: colors.glassStroke, backgroundColor: brandAlpha(0.05) }]}>
          <Ionicons name="lock-closed-outline" size={15} color={colors.textDim} />
          <Text style={{ color: colors.textDim, fontSize: 11.5, flex: 1, lineHeight: 16 }}>
            This card is not an invitation and does not let anyone in — it only says the group
            exists. Whoever it reaches, an admin still decides who joins.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  hero: { alignItems: 'center' },
  icon: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  note: { flexDirection: 'row', alignItems: 'flex-start', gap: 11, padding: 15, borderWidth: 1, borderRadius: 14, marginTop: 30 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 52, borderRadius: 14, marginTop: 20 },
  btnTxt: { color: '#fff', fontSize: 15.5, fontWeight: '800' },
  footer: { flexDirection: 'row', gap: 9, alignItems: 'flex-start', marginTop: 30, padding: 13, borderWidth: 1, borderRadius: 12 },
});
