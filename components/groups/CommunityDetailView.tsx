// components/groups/CommunityDetailView.tsx — one community's page in
// app/communities.tsx: its groups, adding a group, and (R4 backend C9) edit,
// delete, leave and attach-an-existing-group. The screen owns the state and the
// requests; this only draws them.

import React from 'react';
import { ActivityIndicator, FlatList, TouchableOpacity, View } from 'react-native';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../lib/theme';
import { AuroraBackground } from '../ui/AuroraBackground';
import { AppText as Text } from '../ui/Text';
import type { CommunityDetail } from '../../lib/chatService';
import type { CommunityStyles } from './communityStyles';

export type CommunityAction = 'edit' | 'delete' | 'leave' | 'attach';

/**
 * Whether this server has the C9 management routes: 'probing' (asking once),
 * 'yes', 'no' (not deployed: the actions are replaced by a note, so nothing
 * fails after a confirm), or 'unknown' (the probe could not tell; the actions
 * stay and still say "Not available yet" if the route is missing).
 */
export type ManageSupport = 'probing' | 'yes' | 'no' | 'unknown';

export function CommunityDetailView({
  S, detail, stale, retrying, acting, manage, onBack, onRetry, onOpenGroup, onNewGroup, onAction,
}: {
  S: CommunityStyles;
  detail: CommunityDetail;
  /** The refresh failed and this is the saved copy. */
  stale: boolean;
  retrying: boolean;
  /** A management request in flight. */
  acting: CommunityAction | null;
  manage: ManageSupport;
  onBack: () => void;
  onRetry: () => void;
  onOpenGroup: (chatId: string) => void;
  onNewGroup: () => void;
  onAction: (a: CommunityAction) => void;
}) {
  const { colors } = useTheme();
  const busy = acting != null;
  const canManage = manage === 'yes' || manage === 'unknown';
  const actionRow = (a: CommunityAction, icon: keyof typeof Ionicons.glyphMap, label: string, danger = false) => (
    <TouchableOpacity style={danger ? S.dangerRow : S.addRow} activeOpacity={0.7} disabled={busy}
      accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: busy, busy: acting === a }}
      onPress={() => onAction(a)}>
      <View style={[S.addIcon, danger && { borderColor: colors.danger }]}>
        {acting === a
          ? <ActivityIndicator size="small" color={danger ? colors.danger : colors.primary} />
          : <Ionicons name={icon} size={20} color={danger ? colors.danger : colors.primary} />}
      </View>
      <Text style={danger ? S.dangerTxt : S.addTxt}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <View style={S.screen}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />
      <View style={S.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back to communities" onPress={onBack} style={S.hBtn} hitSlop={8}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.hTitle} numberOfLines={1} accessibilityRole="header">{detail.name}</Text>
        {detail.isOwner && canManage && (
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Edit community name and description" disabled={busy}
            accessibilityState={{ disabled: busy }} onPress={() => onAction('edit')} style={S.hBtn} hitSlop={8}>
            <Ionicons name="create-outline" size={22} color={colors.text} />
          </TouchableOpacity>
        )}
      </View>

      {stale && (
        <TouchableOpacity style={S.errBar} accessibilityRole="button" accessibilityLabel="Couldn't refresh this community. Showing the saved copy. Retry"
          accessibilityState={{ busy: retrying, disabled: retrying }} disabled={retrying} onPress={onRetry}>
          {retrying
            ? <ActivityIndicator color={colors.danger} size="small" accessibilityLabel="Retrying" />
            : <Text style={S.errTxt}>Couldn’t refresh — showing the saved copy. Tap to retry.</Text>}
        </TouchableOpacity>
      )}

      <FlatList
        data={detail.groups}
        contentContainerStyle={S.listContent}
        keyExtractor={g => g.id}
        ListHeaderComponent={
          <View>
            <View style={S.commHero}>
              <View style={S.commIcon}><Ionicons name="people" size={32} color={colors.onPrimary} /></View>
              <Text numberOfLines={1} style={S.commName}>{detail.name}</Text>
              {!!detail.description && <Text style={S.commDesc}>{detail.description}</Text>}
            </View>
            <Text style={S.sectionLabel} accessibilityRole="header">GROUPS</Text>
          </View>
        }
        renderItem={({ item: g }) => {
          const sub = g.isAnnouncement ? 'Announcements' : `${g.members} member${g.members === 1 ? '' : 's'}`;
          return (
            <TouchableOpacity style={S.row} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={`${g.name}, ${sub}`} onPress={() => onOpenGroup(g.id)}>
              <View style={[S.groupIcon, g.isAnnouncement && { backgroundColor: colors.primary }]}>
                <Ionicons name={g.isAnnouncement ? 'megaphone' : 'people-outline'} size={20} color={g.isAnnouncement ? colors.onPrimary : colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={S.rowName} numberOfLines={1}>{g.name}</Text>
                <Text style={S.rowSub}>{sub}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
            </TouchableOpacity>
          );
        }}
        ListFooterComponent={
          <View>
            {/* Any community member may add a group: the server only checks
                membership (POST /communities/:id/groups — communities.go), and
                everyone who can open this screen is one. */}
            <TouchableOpacity style={S.addRow} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="New group in this community" onPress={onNewGroup}>
              <View style={S.addIcon}><Ionicons name="add" size={22} color={colors.primary} /></View>
              <Text style={S.addTxt}>New group</Text>
            </TouchableOpacity>
            {canManage && actionRow('attach', 'link-outline', 'Add a group you manage')}
            {canManage && (detail.isOwner
              ? actionRow('delete', 'trash-outline', 'Delete community', true)
              : actionRow('leave', 'exit-outline', 'Leave community', true))}
            {manage === 'probing' && (
              // The management rows wait for the one-per-session support check;
              // say so instead of leaving a silent gap that later fills in.
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 24, marginTop: 12 }}
                accessible accessibilityLabel="Checking which community actions are available">
                <ActivityIndicator size="small" color={colors.textDim} />
                <Text style={[S.emptySub, { textAlign: 'left', flex: 1 }]}>Checking what you can change here…</Text>
              </View>
            )}
            {manage === 'no' && (
              <Text style={[S.emptySub, { marginHorizontal: 24, marginTop: 12, textAlign: 'left' }]}>
                {detail.isOwner
                  ? 'Editing or deleting this community, and adding a group you already have, need a server update that has not been released yet.'
                  : 'Leaving this community, and adding a group you already have, need a server update that has not been released yet. You can still leave each group on its own.'}
              </Text>
            )}
          </View>
        }
      />
    </View>
  );
}
