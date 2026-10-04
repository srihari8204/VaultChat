// components/family/HubManageSheet.tsx — the Family hub's ⋯ "space options"
// sheet, moved out of app/family.tsx. Every row, gate and destination is
// unchanged; navigation rows close the sheet first, exactly as before. The
// hub keeps the actions that change its own state (rename, invite, announce,
// leave, delete, the speed alert) and passes them in.

import React from 'react';
import { View, Modal, Pressable, ScrollView, TouchableOpacity, TextInput, ActivityIndicator, Switch, type TextStyle } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { AppText as Text } from '../ui/Text';
import { KeyboardSafe } from '../ui';
import { useTheme } from '../../lib/theme';
import { useSpaceGlass } from '../spaces/SpaceGround';
import { can as hasPerm, type Permission } from '../../lib/groups/permissions';
import { type GroupRef } from '../../lib/groups/store';
import { sheetSt } from './sheetStyles';
import { st } from './hubStyles';

type IconName = keyof typeof Ionicons.glyphMap;

/** One option row. Hoisted (not defined in render) so React keeps it mounted. */
function Row({ icon, label, onPress, iconColor, iconSize = 19, textStyle, disabled }: {
  icon: IconName; label: string; onPress: () => void; iconColor?: string; iconSize?: number;
  textStyle?: TextStyle; disabled?: boolean;
}) {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  return (
    <TouchableOpacity onPress={onPress} disabled={disabled} accessibilityRole="button"
      accessibilityState={disabled ? { disabled } : undefined}
      style={[st.mRow, { borderColor: G.line }]}>
      <Ionicons name={icon} size={iconSize} color={iconColor ?? colors.primary} />
      <Text style={[st.mTxt, { color: colors.text }, textStyle]}>{label}</Text>
    </TouchableOpacity>
  );
}

export default function HubManageSheet({
  visible, onClose, active, perms, can, renameTxt, onRenameTxt, onRename, busy,
  speedAlert, onToggleSpeedAlert, onCycleSpeed, onInvite, onAnnounce, onLeave, onDelete,
}: {
  visible: boolean;
  onClose: () => void;
  active: GroupRef | null;
  perms: Set<Permission>;
  can: { manage: boolean; invite: boolean; announce: boolean; ops: boolean; navigate: boolean };
  renameTxt: string;
  onRenameTxt: (t: string) => void;
  onRename: () => void;
  busy: boolean;
  speedAlert: { enabled: boolean; thresholdKmh: number };
  onToggleSpeedAlert: (on: boolean) => void;
  onCycleSpeed: () => void;
  onInvite: () => void;
  onAnnounce: () => void;
  onLeave: () => void;
  onDelete: () => void;
}) {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  const router = useRouter();
  /** Close the sheet, then act — the order every navigation row used. */
  const go = (fn: () => void) => () => { onClose(); fn(); };
  /** Push a group screen with the active space's id and name. */
  const open = (pathname: string, extra: Record<string, string> = {}) =>
    go(() => { if (active) router.push({ pathname, params: extra }); });
  const idName = active ? { groupId: active.id, name: active.name } : {};
  const spaceParams = active ? { spaceId: active.id, name: active.name, groupType: active.groupType ?? '' } : {};

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {/* KeyboardSafe, not KeyboardAvoidingView (2026-09-17): a React Native
          <Modal> is its own Android window and never receives the activity's
          adjustResize, and KAV's 'padding' math mixes Modal-relative layout
          coords with absolute screen coords, so the lift came up short.
          keyboardOnly: this sheet already sets its own bottom padding. */}
      <KeyboardSafe keyboardOnly style={sheetSt.modalWrap}>
        <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close options" />
        {/* maxHeight + an inner scroll: this sheet holds 20+ actions, and on
            a short phone the top rows were pushed clean off the screen.
            Every action is unchanged — now they are all reachable. */}
        <View style={[sheetSt.modal, { backgroundColor: G.sheet, borderColor: G.edge, maxHeight: '86%' }]}>
          <View style={[sheetSt.grab, { backgroundColor: colors.border }]} />
          <Text numberOfLines={1} accessibilityRole="header" style={[sheetSt.modalTitle, { color: colors.text }]}>{active?.name}</Text>
          {/* Indicator stays visible: 20+ rows, and without it nothing says
              the sheet scrolls at all. */}
          <ScrollView bounces={false} keyboardShouldPersistTaps="handled">

          {can.manage && (
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 4 }}>
              <TextInput value={renameTxt} onChangeText={onRenameTxt} placeholder="Rename circle" placeholderTextColor={colors.textFaint}
                accessibilityLabel="New name for this space" maxLength={100}
                style={[sheetSt.noteInput, { flex: 1, marginTop: 0, color: colors.text, borderColor: colors.glassStroke, backgroundColor: colors.glassSoft }]}
                returnKeyType="done" onSubmitEditing={onRename} />
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Save name" onPress={onRename} disabled={!renameTxt.trim() || busy}
                accessibilityState={{ disabled: !renameTxt.trim() || busy, busy }}
                style={[st.saveBtn, { backgroundColor: renameTxt.trim() ? colors.primary : colors.border }]}>
                {busy ? <ActivityIndicator color={colors.onPrimary} size="small" /> : <Ionicons name="checkmark" size={20} color={colors.onPrimary} />}
              </TouchableOpacity>
            </View>
          )}

          {can.invite && <Row icon="person-add" label="Invite from contacts" onPress={go(onInvite)} />}
          {can.invite && <Row icon="mail-open-outline" label="Sent invitations & requests"
            onPress={open('/group-invites', active ? { chatId: active.id, name: active.name } : {})} />}
          <Row icon="people-outline" label="Members & roles" onPress={open('/group-members', idName)} />
          <Row icon="mail-outline" label="My invitations" onPress={go(() => router.push('/group-invitations'))} />
          {/* ONE create/join row (there used to be two near-identical ones).
              family-setup offers a family circle, every other kind of group
              (group-create) and join-with-a-code — group-create alone has no
              way to join. It names the space type it was opened from. */}
          <Row icon="add-circle-outline" label="Create or join another space"
            onPress={go(() => router.push({ pathname: '/family-setup', params: { from: 'family', groupType: active?.groupType ?? '' } }))} />
          {can.announce && <Row icon="megaphone-outline" label="Post an announcement" onPress={go(onAnnounce)} />}
          <Row icon="calendar-outline" label="Shared calendar" onPress={open('/group-calendar', idName)} />
          {/* The admin console. Offered only to someone who actually runs this
              space, and it carries their RESOLVED permissions across so the
              console draws only what they can use — a tile that fails on tap
              teaches people to distrust the whole screen. The permission list
              is presentation; every endpoint behind it re-checks server-side. */}
          {can.ops && <Row icon="shield-checkmark-outline" iconSize={18} label="Admin console"
            textStyle={{ color: G.accentText, fontWeight: '700' }}
            onPress={open('/space-admin', { ...spaceParams, perms: Array.from(perms).join(',') })} />}
          {/* Attendance is only meaningful where someone oversees others, so
              it is offered on the same permission that shows the runs card
              rather than to every member of every household. */}
          {can.ops && <Row icon="calendar-number-outline" iconSize={18} iconColor={colors.text} label="Attendance"
            onPress={open('/space-attendance', spaceParams)} />}
          {/* The roster is offered to EVERYONE in an ops space, not just ops:
              a parent's "roster" is their own child, and that is the screen
              that tells them so. The server decides what is in it. */}
          {(can.ops || hasPerm(perms, 'manage_roster') || !!active?.groupType?.includes('school') || !!active?.groupType?.includes('transport')) &&
            <Row icon="people-outline" iconSize={18} iconColor={colors.text} label="Roster"
              onPress={open('/space-roster', { ...spaceParams, canManage: hasPerm(perms, 'manage_roster') ? '1' : '0' })} />}
          <Row icon="stats-chart-outline" label="Insights" onPress={open('/group-insights', idName)} />
          {can.navigate && <Row icon="navigate-outline" label="Start a group trip" onPress={open('/group-trip', idName)} />}
          <Row icon="images-outline" label="Shared album"
            onPress={open('/media-gallery', active ? { chatId: active.id, peerName: active.name } : {})} />
          <Row icon="document-text-outline" label="Shared notes" onPress={open('/group-notes', idName)} />
          <Row icon="checkbox-outline" label="Shared tasks" onPress={open('/group-tasks', idName)} />
          <Row icon="eye-off-outline" label="What this group can see" onPress={open('/group-privacy', idName)} />
          {/* High-speed alert for MY OWN device (spec: speed alerts). Tap the
              threshold to cycle it. Off by default; detected on this phone —
              the alert is never computed server-side. */}
          <View style={[st.mRow, { borderColor: G.line }]}>
            <Ionicons name="speedometer-outline" size={19} color={colors.primary} />
            <Text style={[st.mTxt, { color: colors.text, flex: 1 }]}>High-speed alert</Text>
            {speedAlert.enabled && (
              <TouchableOpacity onPress={onCycleSpeed} style={{ paddingHorizontal: 8 }} hitSlop={{ top: 12, bottom: 12 }} accessibilityRole="button" accessibilityLabel={`High-speed alert threshold ${speedAlert.thresholdKmh} kilometres per hour, tap to change`}>
                <Text style={{ color: G.accentText, fontWeight: '800', fontSize: 13 }}>{speedAlert.thresholdKmh} km/h</Text>
              </TouchableOpacity>
            )}
            <Switch value={speedAlert.enabled} onValueChange={onToggleSpeedAlert} accessibilityLabel="Speed alerts" trackColor={{ true: colors.primary }} />
          </View>
          <Row icon="chatbubbles" label="Open circle chat"
            onPress={go(() => { if (active) router.push({ pathname: '/chat', params: { id: active.id } }); })} />
          <Row icon="medkit" iconColor={colors.danger} label="Emergency SOS (trusted contacts)" onPress={go(() => router.push('/emergency-sos'))} />
          <Text style={{ color: colors.textDim, fontSize: 12, paddingVertical: 8 }}>
            Tap a member for their details and history. Use ⋯ on their row to change their role or remove them.
          </Text>
          <Row icon="exit-outline" iconColor={G.dangerText} label="Leave circle" textStyle={{ color: G.dangerText }} onPress={onLeave} />
          {can.manage && (
            <Row icon="trash" iconColor={G.dangerText} label="Delete circle" textStyle={{ color: G.dangerText, fontWeight: '800' }}
              onPress={onDelete} disabled={busy} />
          )}
          </ScrollView>
        </View>
      </KeyboardSafe>
    </Modal>
  );
}
