// components/family/useHubCircleActions.ts — the hub's guardian and circle
// actions, moved out of app/family.tsx unchanged: ask a member to check in,
// a member's manage menu (role, remove), and rename / leave / delete. Every
// destructive step is confirmed; every server refusal is said.

import { type Dispatch, type SetStateAction } from 'react';
import { Alert } from 'react-native';
import { requestCheckin } from '../../lib/family/escalationService';
import { MISSES_BEFORE_EMERGENCY } from '../../lib/family/escalation';
import { renameCircle, leaveCircle, deleteCircle, removeCircleMember, setGuardian } from '../../lib/family/circle';
import { listGroups, type GroupRef } from '../../lib/groups/store';
import { type CircleMember } from '../../lib/family/types';

export function useHubCircleActions({
  active, me, canRemove, busy, setBusy, renameTxt, setRenameTxt,
  refreshMembers, afterCircleGone, setActive, setCircles, onSent,
}: {
  active: GroupRef | null;
  me: { id: string; name: string } | null;
  canRemove: boolean;
  busy: boolean;
  setBusy: (b: boolean) => void;
  renameTxt: string;
  setRenameTxt: (t: string) => void;
  refreshMembers: () => void;
  afterCircleGone: () => Promise<void>;
  setActive: Dispatch<SetStateAction<GroupRef | null>>;
  setCircles: Dispatch<SetStateAction<GroupRef[]>>;
  /** Something was sent: re-pull the highlights. */
  onSent: () => void;
}) {
  // ── Escalation ladder (F6) ───────────────────────────────────────────
  /** Guardian asks a member to check in; the ladder escalates if they don't. */
  const askCheckin = (m: CircleMember) => {
    if (!active || !me) return;
    Alert.alert(
      `Ask ${m.name} to check in?`,
      `They'll be asked now, reminded twice if there's no reply, and after ${MISSES_BEFORE_EMERGENCY} missed reminders the circle gets an emergency alert.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Ask', onPress: async () => {
          try {
            await requestCheckin({
              circleId: active.id, subjectId: m.id, subjectName: m.name,
              meId: me.id, meName: me.name,
            });
            onSent();
          } catch (e: any) { Alert.alert('Check-in', e?.message ?? 'Could not send the request.'); }
        } },
      ],
    );
  };

  // ── Member management (guardians) ────────────────────────────────────
  const memberActions = (m: CircleMember) => {
    if (!active || !me || m.id === me.id || !canRemove) return;
    Alert.alert(m.name, 'Manage this member', [
      { text: 'Ask to check in', onPress: () => askCheckin(m) },
      { text: m.role === 'guardian' ? 'Make member' : 'Make guardian', onPress: async () => {
        try { await setGuardian(active.id, m.id, m.role !== 'guardian'); refreshMembers(); }
        catch (e: any) { Alert.alert('Role', e?.message ?? 'Could not change role.'); }
      } },
      { text: 'Remove from circle', style: 'destructive', onPress: () => {
        Alert.alert('Remove member?', `${m.name} will no longer see or share locations in "${active.name}".`, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Remove', style: 'destructive', onPress: async () => {
            try { await removeCircleMember(active.id, m.id); refreshMembers(); }
            catch (e: any) { Alert.alert('Remove', e?.message ?? 'Could not remove.'); }
          } },
        ]);
      } },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const doRename = async () => {
    if (!active || !renameTxt.trim() || busy) return;
    setBusy(true);
    try {
      await renameCircle(active.id, renameTxt);
      const name = renameTxt.trim();
      setActive({ ...active, name });
      setCircles(await listGroups());
      setRenameTxt('');
    } catch (e: any) { Alert.alert('Rename', e?.message ?? 'Could not rename.'); }
    finally { setBusy(false); }
  };
  const doLeave = () => {
    if (!active || !me) return;
    Alert.alert('Leave circle?', `You will stop sharing and seeing locations in "${active.name}".`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Leave', style: 'destructive', onPress: async () => {
        // leaveCircle throws when the server refused; the circle then stays
        // listed (the user is still in it) and they are told why.
        try { await leaveCircle(active.id, me.id); await afterCircleGone(); }
        catch (e: any) { Alert.alert('Leave', e?.message ?? 'Could not leave the circle. Try again.'); }
      } },
    ]);
  };
  const doDelete = () => {
    if (!active || !me) return;
    Alert.alert('Delete circle?', `"${active.name}" will be disbanded for everyone. This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete circle', style: 'destructive', onPress: async () => {
        setBusy(true);
        try { await deleteCircle(active.id, me.id); await afterCircleGone(); }
        catch (e: any) { Alert.alert('Delete', e?.message ?? 'Could not delete the circle.'); }
        finally { setBusy(false); }
      } },
    ]);
  };

  return { memberActions, doRename, doLeave, doDelete };
}
