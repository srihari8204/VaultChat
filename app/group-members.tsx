// app/group-members.tsx — who is in this group, and who may do what
// (Groups & Circles, membership v2).
//
// One screen for the three things that were previously either impossible or
// buried in a modal: changing somebody's role, removing them, and handing over
// the group.
//
// EVERY CONTROL HERE IS GATED TWICE, and the two gates are different questions:
//
//   the PERMISSION — may I manage members at all?
//   the RANK       — may I act on THIS person?
//
// Permission alone is not enough, and that is not a theoretical distinction:
// moderators hold remove_members by default, so a screen that checked only the
// permission would offer a Remove button against the owner. The server refuses
// it (groups.CanRemoveMember), and a button that always fails is worse than no
// button, because it reads as a broken app rather than a rule.
//
// The gating functions are the client mirror of the Go ones, and
// scripts/check-permission-mirror.ts proves the two still agree.

import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert,
  ActivityIndicator, Modal, Image, Pressable,
} from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { brandAlpha } from '../constants/theme';
import {
  getChat, setMemberRole, removeChatMember, transferOwnership, setApprovalMode,
  type ChatMember, type ApprovalMode,
} from '../lib/chatService';
import {
  canManageRole, canRemoveMember, canTransferOwnership,
  can as hasPerm, seatsRemaining,
  ROLES, ROLE_LABELS, ROLE_BLURBS,
  type GroupRole, type Permission,
} from '../lib/groups/permissions';
import { getCurrentUserAsync } from './(constants)/authService';

/** Roles that can be ASSIGNED. Owner is absent on purpose — see transfer. */
const ASSIGNABLE: GroupRole[] = ['admin', 'moderator', 'member', 'guest'];

const ROLE_TONE: Record<GroupRole, string> = {
  owner: '#F59E0B', admin: '#9D6FD0', moderator: '#4A9FFF', member: '#22C55E', guest: '#6B7280',
};

const MODES: { key: ApprovalMode; label: string; blurb: string }[] = [
  { key: 'strict', label: 'Strict', blurb: 'They accept, then an admin approves. Two yeses.' },
  { key: 'user_approval', label: 'They decide', blurb: 'Accepting the invitation adds them straight away.' },
  { key: 'admin_approval', label: 'By request', blurb: 'People ask to join and an admin decides.' },
];

export default function GroupMembersScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ groupId?: string; name?: string }>();
  const groupId = String(params.groupId || '');
  const groupName = String(params.name || 'this group');

  const [me, setMe] = useState<string | null>(null);
  const [myRole, setMyRole] = useState<GroupRole>('member');
  const [perms, setPerms] = useState<Set<Permission>>(new Set());
  const [members, setMembers] = useState<ChatMember[]>([]);
  const [maxMembers, setMaxMembers] = useState<number | null>(null);
  const [mode, setMode] = useState<ApprovalMode>('strict');
  const [typed, setTyped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [sheet, setSheet] = useState<ChatMember | null>(null);

  const load = useCallback(async () => {
    if (!groupId) { setLoading(false); return; }
    try {
      const [u, chat] = await Promise.all([
        getCurrentUserAsync().catch(() => null),
        getChat(groupId),
      ]);
      setMe(u ? String(u.id) : null);
      setMyRole(chat.myRole);
      // Starts empty and is only ever widened by what the server says. A failed
      // load must never leave the screen showing more controls than the caller
      // actually holds.
      setPerms(new Set((chat.permissions ?? []) as Permission[]));
      setMembers((chat.members ?? []).filter((m) => !m.leftAt));
      setMaxMembers(chat.maxMembers ?? null);
      setMode(chat.approvalMode ?? 'strict');
      setTyped(!!chat.groupType);
    } catch (e: any) {
      Alert.alert('Could not load members', e?.message ?? 'Try again.');
    } finally { setLoading(false); }
  }, [groupId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const ordered = useMemo(() => {
    const rank = (r: string) => {
      const i = ROLES.indexOf(r as GroupRole);
      return i === -1 ? ROLES.length : i;
    };
    return [...members].sort((a, b) =>
      rank(a.role) - rank(b.role) || (a.name ?? '').localeCompare(b.name ?? ''));
  }, [members]);

  const seats = seatsRemaining(members.length, maxMembers ?? 0);
  const mayManageMembers = hasPerm(perms, 'remove_members');

  const act = async (label: string, fn: () => Promise<unknown>, target: string) => {
    setBusy(target);
    try { await fn(); await load(); }
    catch (e: any) { Alert.alert(`Could not ${label}`, e?.message ?? 'Try again.'); }
    finally { setBusy(null); setSheet(null); }
  };

  const changeRole = (m: ChatMember, next: GroupRole) => {
    if (next === m.role) { setSheet(null); return; }
    act('change the role', () => setMemberRole(groupId, m.userId, next as Exclude<GroupRole, 'owner'>), m.userId);
  };

  const remove = (m: ChatMember) => {
    Alert.alert(
      `Remove ${m.name ?? 'this member'}?`,
      'They lose access to the group immediately. Depending on the group they may not be able to rejoin straight away.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => act('remove them', async () => {
          await removeChatMember(groupId, m.userId);
        }, m.userId) },
      ],
    );
  };

  const handOver = (m: ChatMember) => {
    Alert.alert(
      `Make ${m.name ?? 'them'} the owner?`,
      `You become an admin and ${m.name ?? 'they'} take over ${groupName}. This cannot be undone by you — only the new owner can hand it back.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Hand over', style: 'destructive', onPress: () => act('transfer ownership', async () => {
          await transferOwnership(groupId, m.userId);
        }, m.userId) },
      ],
    );
  };

  const pickMode = (next: ApprovalMode) => {
    if (next === mode) return;
    const warn = next === 'user_approval'
      ? 'Anyone invited will be able to add themselves without a second look from an admin.'
      : next === 'admin_approval'
        ? 'People will be able to ask to join, and an admin decides.'
        : 'Both sides will have to agree: the person accepts, then an admin approves.';
    Alert.alert('Change how people join?', warn, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Change', onPress: () => act('change that', async () => {
        await setApprovalMode(groupId, next);
      }, 'mode') },
    ]);
  };

  const avatar = (m: ChatMember, size = 40) => (
    m.photoURL
      ? <Image source={{ uri: m.photoURL }} style={{ width: size, height: size, borderRadius: size / 2 }} />
      : (
        <View style={[st.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: brandAlpha(0.18) }]}>
          <Text style={{ color: colors.primary, fontWeight: '800', fontSize: size * 0.38 }}>
            {(m.name ?? '?').trim()[0]?.toUpperCase() ?? '?'}
          </Text>
        </View>
      )
  );

  const row = (m: ChatMember) => {
    const isMe = m.userId === me;
    const role = m.role as GroupRole;
    // Two questions, not one. Holding the permission says nothing about whether
    // this particular person is yours to touch.
    const canEdit = mayManageMembers && !isMe && typed &&
      ASSIGNABLE.some((r) => canManageRole(myRole, role, r));
    const canKick = mayManageMembers && !isMe && canRemoveMember(myRole, role);
    const canGive = !isMe && canTransferOwnership(myRole, role);
    const actionable = canEdit || canKick || canGive;

    return (
      <TouchableOpacity
        key={m.userId}
        disabled={!actionable || busy === m.userId}
        onPress={() => setSheet(m)}
        style={[st.row, { borderColor: colors.border }]}
      >
        {avatar(m)}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: colors.text, fontWeight: '600', fontSize: 14.5 }} numberOfLines={1}>
            {m.name ?? 'VaultChat user'}{isMe ? ' (you)' : ''}
          </Text>
          <View style={st.roleWrap}>
            <View style={[st.dot, { backgroundColor: ROLE_TONE[role] ?? colors.textDim }]} />
            <Text style={{ color: colors.textDim, fontSize: 12 }}>
              {ROLE_LABELS[role] ?? m.role}
            </Text>
          </View>
        </View>
        {busy === m.userId
          ? <ActivityIndicator size="small" color={colors.primary} />
          : actionable && <Ionicons name="chevron-forward" size={17} color={colors.textFaint} />}
      </TouchableOpacity>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: 'Members', headerTitleAlign: 'center' }} />

      {loading ? (
        <View style={st.center}><ActivityIndicator color={colors.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
          <View style={st.sechead}>
            <Text style={[st.h, { color: colors.text, marginBottom: 0 }]}>
              {members.length} {members.length === 1 ? 'member' : 'members'}
            </Text>
            {seats >= 0 && (
              <Text style={{ color: seats === 0 ? colors.danger : colors.textDim, fontSize: 12 }}>
                {seats === 0 ? 'Group is full' : `${seats} ${seats === 1 ? 'seat' : 'seats'} left`}
              </Text>
            )}
          </View>

          {ordered.map(row)}

          {hasPerm(perms, 'invite_members') && (
            <TouchableOpacity
              onPress={() => router.push({ pathname: '/group-invites' as any, params: { chatId: groupId, name: groupName } })}
              style={[st.addBtn, { borderColor: colors.border }]}
            >
              <Ionicons name="person-add-outline" size={18} color={colors.primary} />
              <Text style={{ color: colors.primary, fontWeight: '700', fontSize: 14 }}>Add people</Text>
            </TouchableOpacity>
          )}

          {/* ── how people get in ── */}
          {myRole === 'owner' && typed && (
            <>
              <Text style={[st.h, { color: colors.text, marginTop: 30 }]}>How people join</Text>
              {MODES.map((m) => {
                const on = m.key === mode;
                return (
                  <TouchableOpacity key={m.key} onPress={() => pickMode(m.key)} disabled={busy === 'mode'}
                    style={[st.mode, {
                      borderColor: on ? colors.primary : colors.border,
                      backgroundColor: on ? brandAlpha(0.08) : 'transparent',
                    }]}>
                    <Ionicons
                      name={on ? 'radio-button-on' : 'radio-button-off'}
                      size={19} color={on ? colors.primary : colors.textFaint}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: colors.text, fontWeight: '700', fontSize: 14 }}>{m.label}</Text>
                      <Text style={{ color: colors.textDim, fontSize: 12, marginTop: 2, lineHeight: 16 }}>{m.blurb}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
              <Text style={{ color: colors.textFaint, fontSize: 11.5, marginTop: 10, lineHeight: 16 }}>
                Only you can change this. Nobody is ever added to {groupName} without agreeing to
                join, whichever setting is on.
              </Text>
            </>
          )}
        </ScrollView>
      )}

      {/* ── per-member actions ── */}
      <Modal visible={!!sheet} transparent animationType="slide" onRequestClose={() => setSheet(null)}>
        <View style={st.backdrop}>
          <Pressable style={{ flex: 1 }} onPress={() => setSheet(null)} />
          <View style={[st.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {!!sheet && (() => {
              const role = sheet.role as GroupRole;
              const options = ASSIGNABLE.filter((r) => canManageRole(myRole, role, r));
              return (
                <>
                  <View style={st.sheetHead}>
                    {avatar(sheet, 46)}
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }} numberOfLines={1}>
                        {sheet.name ?? 'VaultChat user'}
                      </Text>
                      <Text style={{ color: colors.textDim, fontSize: 12.5 }}>
                        {ROLE_LABELS[role] ?? sheet.role} · {ROLE_BLURBS[role] ?? ''}
                      </Text>
                    </View>
                  </View>

                  {options.length > 0 && (
                    <>
                      <Text style={[st.h, { color: colors.textDim, marginTop: 20 }]}>Change role</Text>
                      {options.map((r) => (
                        <TouchableOpacity key={r} onPress={() => changeRole(sheet, r)}
                          style={[st.opt, { borderColor: colors.border }]}>
                          <View style={[st.dot, { backgroundColor: ROLE_TONE[r] }]} />
                          <View style={{ flex: 1 }}>
                            <Text style={{ color: colors.text, fontSize: 14, fontWeight: r === role ? '800' : '600' }}>
                              {ROLE_LABELS[r]}
                            </Text>
                            <Text style={{ color: colors.textDim, fontSize: 11.5 }}>{ROLE_BLURBS[r]}</Text>
                          </View>
                          {r === role && <Ionicons name="checkmark" size={18} color={colors.primary} />}
                        </TouchableOpacity>
                      ))}
                    </>
                  )}

                  {canTransferOwnership(myRole, role) && (
                    <TouchableOpacity onPress={() => handOver(sheet)}
                      style={[st.opt, { borderColor: colors.border, marginTop: 14 }]}>
                      <Ionicons name="key-outline" size={18} color="#F59E0B" />
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700' }}>Make owner</Text>
                        <Text style={{ color: colors.textDim, fontSize: 11.5 }}>
                          You become an admin. Only they can hand it back.
                        </Text>
                      </View>
                    </TouchableOpacity>
                  )}

                  {mayManageMembers && canRemoveMember(myRole, role) && (
                    <TouchableOpacity onPress={() => remove(sheet)}
                      style={[st.opt, { borderColor: colors.danger + '55', marginTop: 8 }]}>
                      <Ionicons name="person-remove-outline" size={18} color={colors.danger} />
                      <Text style={{ color: colors.danger, fontSize: 14, fontWeight: '700', flex: 1 }}>
                        Remove from group
                      </Text>
                    </TouchableOpacity>
                  )}

                  <TouchableOpacity onPress={() => setSheet(null)}
                    style={[st.close, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                    <Text style={{ color: colors.text, fontWeight: '700', fontSize: 14.5 }}>Close</Text>
                  </TouchableOpacity>
                </>
              );
            })()}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const st = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  h: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 10 },
  sechead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth },
  roleWrap: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  addBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 48, borderWidth: 1, borderRadius: 13, marginTop: 16 },
  mode: { flexDirection: 'row', alignItems: 'flex-start', gap: 11, padding: 13, borderWidth: 1, borderRadius: 13, marginBottom: 9 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: { borderTopLeftRadius: 22, borderTopRightRadius: 22, borderTopWidth: 1, padding: 20, paddingBottom: 34 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  opt: { flexDirection: 'row', alignItems: 'center', gap: 11, padding: 13, borderWidth: 1, borderRadius: 12, marginBottom: 8 },
  close: { alignItems: 'center', justifyContent: 'center', height: 48, borderWidth: 1, borderRadius: 13, marginTop: 14 },
});
