// app/family-add.tsx — invite people to a Family Space or a group chat.
//
// Contacts first, invite code second. A Circle IS a group chat, so the people
// you can add are the people you already have a direct chat with — the same
// source app/create-group.tsx uses (GET /chats → direct peers). That resolves
// straight to user IDs, needs no contact-permission round-trip, and needs no
// code to be typed by anyone.
//
// CONSENT: picking someone here sends them an INVITATION (chat_invitations,
// migration 071) — it does not drop them into the group. They see it in
// /group-invitations and choose Accept or Decline; only an accept joins them.
// This screen used to call addChatMembers, which added people to a family
// circle (a live-location group) without ever asking them. Being added to a
// group that shares your location is not something anyone should discover
// after the fact.
//
// Shared by BOTH entry points — Family Space "add" and group-info "Add member"
// — so the consent path is identical wherever you invite from. Params accept
// circleId/circleName (family) or chatId/name (group).
//
// The invite code stays as the fallback for someone who is NOT yet a crazzychat
// contact. It was previously the ONLY way in, which is why adding family was
// hard: the person you most want in your circle is almost always already in
// your chat list.

import { useAuthHeader } from '../hooks/useAuthHeader';
import { AppText as Text } from '../components/ui/Text';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, TextInput, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, Alert, Share,
} from 'react-native';
import { useRouter, Stack, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { Avatar, AuroraBackground } from '../components/ui';
import { listChats, createInvitation, attachmentUrl } from '../lib/chatService';
import { circleInviteCode, circleMembers } from '../lib/family/circle';

interface Pick { userId: string; name: string; photoURL: string | null }

export default function FamilyAddScreen() {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  // Family Space passes circleId/circleName; group-info passes chatId/name.
  const params = useLocalSearchParams<{ circleId?: string; circleName?: string; chatId?: string; name?: string }>();
  const circleId = params.circleId || params.chatId;
  const circleName = params.circleName || params.name;
  const isFamily = !!params.circleId;   // wording only — the invite path is identical

  const [people, setPeople] = useState<Pick[]>([]);
  const [already, setAlready] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const authHeader = useAuthHeader();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [chats, members] = await Promise.all([
          listChats(),
          circleId ? circleMembers(String(circleId)).catch(() => []) : Promise.resolve([]),
        ]);
        if (!live) return;
        // Members already in the circle are shown but not selectable — clearer
        // than hiding them, which reads as "this contact is missing".
        setAlready(new Set(members.map((m: any) => String(m.id))));

        const seen = new Map<string, Pick>();
        for (const c of chats) {
          if (c.type === 'direct' && c.peerUserId && !seen.has(c.peerUserId)) {
            seen.set(c.peerUserId, {
              userId: c.peerUserId,
              name: c.peerName || c.name || 'Direct chat',
              photoURL: c.peerPhotoURL ?? null,
            });
          }
        }
        setPeople(Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name)));
      } catch (e: any) {
        if (live) setError(e?.message ?? 'Failed to load contacts');
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [circleId]);

  const toggle = useCallback((id: string) => {
    if (already.has(id)) return;
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, [already]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? people.filter(p => p.name.toLowerCase().includes(q)) : people;
  }, [people, query]);

  // Invite (never add). One invitation per person so a single failure doesn't
  // lose the rest — the server refuses duplicates, so re-inviting someone who
  // already has a pending invite is a no-op we report as "already invited"
  // rather than an error.
  const add = async () => {
    if (!circleId || !selected.size || busy) return;
    setBusy(true);
    const ids = Array.from(selected);
    let sent = 0;
    const failed: string[] = [];
    for (const userId of ids) {
      try {
        await createInvitation(String(circleId), { userId });
        sent++;
      } catch (e: any) {
        const who = people.find((p) => p.userId === userId)?.name ?? 'Someone';
        failed.push(`${who}: ${e?.message ?? 'failed'}`);
      }
    }
    setBusy(false);
    if (sent && !failed.length) {
      Alert.alert(
        sent === 1 ? 'Invitation sent' : `${sent} invitations sent`,
        `They'll join ${circleName || (isFamily ? 'this space' : 'this group')} once they accept.`,
        [{ text: 'OK', onPress: () => router.back() }],
      );
    } else if (sent) {
      Alert.alert('Partly sent', `${sent} invited.\n\nCouldn't invite:\n${failed.join('\n')}`,
        [{ text: 'OK', onPress: () => router.back() }]);
    } else {
      Alert.alert('Could not invite', failed.join('\n') || 'Try again.');
    }
  };

  const shareCode = async () => {
    if (!circleId) return;
    try {
      const code = await circleInviteCode(String(circleId));
      await Share.share({
        message: `Join "${circleName || 'my space'}" on crazzychat.\nCode: ${code}`,
      });
    } catch (e: any) {
      Alert.alert('Invite', e?.message ?? 'Could not create an invite.');
    }
  };

  const renderItem = ({ item }: { item: Pick }) => {
    const isMember = already.has(item.userId);
    const sel = selected.has(item.userId);
    return (
      <TouchableOpacity
        style={[s.row, isMember && { opacity: 0.5 }]}
        onPress={() => toggle(item.userId)}
        activeOpacity={isMember ? 1 : 0.7}
        accessibilityRole="checkbox"
        accessibilityLabel={isMember ? `${item.name}, already a member` : item.name}
        accessibilityState={{ checked: sel, disabled: isMember }}
      >
        <Avatar
          ring
          uri={item.photoURL && authHeader ? attachmentUrl(item.photoURL) : null}
          headers={authHeader ? { Authorization: authHeader } : undefined}
          name={item.name}
          size={46}
        />
        <View style={{ flex: 1 }}>
          <Text style={s.name} numberOfLines={1}>{item.name}</Text>
          {isMember && <Text style={s.already}>{isFamily ? 'Already in this space' : 'Already in this group'}</Text>}
        </View>
        {!isMember && (
          <View style={[s.check, sel && s.checkSel]}>
            {sel && <Ionicons name="checkmark" size={15} color="#FFFFFF" />}
          </View>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <View style={s.screen}>
      <AuroraBackground />
      <Stack.Screen options={{
        headerShown: true, title: isFamily ? 'Invite to space' : 'Invite to group', headerTitleAlign: 'center',
        headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text, headerShadowVisible: false,
      }} />

      <View style={s.search}>
        <Ionicons name="search" size={17} color={colors.textDim} />
        <TextInput
          style={s.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="Search your contacts"
          placeholderTextColor={colors.textDim}
          autoCorrect={false}
        />
      </View>

      {/* The list below only shows people you already have a DM with (same
          source as new-chat). Address-book discovery lives on /contacts —
          without this row a fresh user sees an empty list and a dead end. */}
      <TouchableOpacity onPress={() => router.push('/contacts' as any)} style={s.abRow} accessibilityRole="button">
        <Ionicons name="book-outline" size={18} color={colors.primary} />
        <Text style={[s.abTxt, { color: colors.primary }]}>Find contacts from address book</Text>
        <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
      </TouchableOpacity>

      {!!error && <View style={s.errorBar}><Text style={s.errorTxt}>{error}</Text></View>}

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
      ) : people.length === 0 ? (
        <View style={s.empty}>
          <Ionicons name="people-outline" size={40} color={colors.textDim} />
          <Text style={s.emptyTxt}>
            No contacts yet. Start a chat with someone first, or send them an invite code below.
          </Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(i) => i.userId}
          renderItem={renderItem}
          contentContainerStyle={{ paddingBottom: 12 }}
          ListEmptyComponent={<Text style={s.emptyTxt}>No contacts match that search</Text>}
        />
      )}

      {/* Fallback for people who aren't on crazzychat / not yet a contact. */}
      <TouchableOpacity onPress={shareCode} style={s.codeRow} activeOpacity={0.7} accessibilityRole="button">
        <Ionicons name="key-outline" size={18} color={colors.primary} />
        <Text style={s.codeTxt}>Not in your contacts? Share an invite code</Text>
      </TouchableOpacity>

      <TouchableOpacity
        onPress={add}
        disabled={!selected.size || busy}
        accessibilityRole="button"
        accessibilityState={{ disabled: !selected.size || busy, busy }}
        style={[s.cta, { backgroundColor: selected.size && !busy ? colors.brandOnLight : colors.border }]}
      >
        {busy
          ? <ActivityIndicator color="#fff" />
          : <Text style={s.ctaTxt}>
              {selected.size
                ? `Invite ${selected.size} ${selected.size === 1 ? 'person' : 'people'}`
                : 'Select contacts to invite'}
            </Text>}
      </TouchableOpacity>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  abRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  abTxt: { flex: 1, fontSize: 14.5, fontWeight: '600' },
  // 2026-09-18: the 15sp input is ~30dp of line box at font scale 1.5, so a
  // pinned 44 cut the descenders off what you were typing. minHeight leaves the
  // pill at 44 on a normal device and lets it grow when the font does.
  search: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    margin: 14, paddingHorizontal: 12, minHeight: 44, paddingVertical: 8,
    borderRadius: 12, borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.glassStroke, backgroundColor: c.glassSoft,
  },
  searchInput: { flex: 1, fontSize: 15, color: c.text },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingVertical: 9,
  },
  name: { fontSize: 15.5, color: c.text, fontWeight: '600' },
  already: { fontSize: 12, color: c.textDim, marginTop: 1 },
  check: {
    width: 24, height: 24, borderRadius: 12,
    borderWidth: 2, borderColor: c.glassStroke,
    alignItems: 'center', justifyContent: 'center',
  },
  checkSel: { backgroundColor: c.brandOnLight, borderColor: c.primary },
  empty: { alignItems: 'center', padding: 32, gap: 10 },
  emptyTxt: { color: c.textDim, fontSize: 13.5, textAlign: 'center', lineHeight: 19 },
  errorBar: { backgroundColor: c.danger + '22', padding: 10, marginHorizontal: 14, borderRadius: 10 },
  errorTxt: { color: c.danger, fontSize: 12.5 },
  codeRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.glassStroke,
  },
  codeTxt: { color: c.primary, fontSize: 13.5, fontWeight: '600' },
  // Same fix for the CTA label (2026-09-18): 15sp bold in a pinned 50.
  cta: {
    margin: 14, marginTop: 0, minHeight: 50, paddingVertical: 10, borderRadius: 13,
    alignItems: 'center', justifyContent: 'center',
  },
  ctaTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },
});
