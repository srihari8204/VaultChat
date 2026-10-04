// components/finance/chitti/MembersTab.tsx — a group's members, with one
// add/edit form card keyed by editingId. Members carry name, mobile
// (validated) and address. The form's draft is held by the group screen, so
// it survives a switch to another tab while only the open tab is rendered.

import React from 'react';
import { View, Text, TouchableOpacity, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFinanceTheme } from '../useFinanceTheme';
import { Field, Btn, Label, Card } from '../ui';
import { nextMemberNumber } from '../chittiNumber';
import {
  insertMember, updateMember, deleteMember, normalizeMobile, type ChittiGroup, type ChittiMember,
} from '../../../db/chitti';
import { makeChittiStyles } from './chittiStyles';

export interface MemberDraft { show: boolean; editingId: string | null; name: string; phone: string; address: string }
export const EMPTY_MEMBER_DRAFT: MemberDraft = { show: false, editingId: null, name: '', phone: '', address: '' };

export function MembersTab({ group: g, members, onChanged, draft, setDraft }: {
  group: ChittiGroup; members: ChittiMember[];
  /** Resolves once the group's rows are re-read, so Save stays latched until then. */
  onChanged: () => Promise<void>;
  draft: MemberDraft; setDraft: React.Dispatch<React.SetStateAction<MemberDraft>>;
}) {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeChittiStyles(FIN), [FIN]);

  const { show: showMemberForm, editingId, name: mName, phone: mPhone, address: mAddress } = draft;
  const set = (p: Partial<MemberDraft>) => setDraft(d => ({ ...d, ...p }));
  const setMName = (name: string) => set({ name });
  const setMPhone = (phone: string) => set({ phone });
  const setMAddress = (address: string) => set({ address });

  const openAddMember = () => setDraft({ ...EMPTY_MEMBER_DRAFT, show: true });
  const openEditMember = (m: ChittiMember) =>
    setDraft({ show: true, editingId: m.id, name: m.name, phone: m.phone ?? '', address: m.address ?? '' });
  const closeMemberForm = () => set({ show: false });

  const saveMember = async () => {
    const name = mName.trim();
    if (!name) return Alert.alert('Name', 'Enter the member’s name.');
    let phone: string | null = null;
    if (mPhone.trim()) {
      const norm = normalizeMobile(mPhone);
      if (!norm) return Alert.alert('Mobile number', 'Enter a valid 10-digit mobile number.');
      phone = norm;
    }
    const address = mAddress.trim() || null;
    if (!editingId && g.members > 0 && members.length >= g.members) {
      return Alert.alert('Group is full', `${g.name} is set up for ${g.members} members.`);
    }
    try {
      if (editingId) {
        await updateMember(editingId, { name, phone, address });
      } else {
        await insertMember({ group_id: g.id, name, phone, address, number: nextMemberNumber(members) });
      }
    } catch (e: any) { return Alert.alert('Could not save the member', e?.message ?? 'Try again.'); }
    set({ show: false });
    await onChanged();
  };

  const removeMember = (m: ChittiMember) => Alert.alert(
    'Remove member?',
    `Remove ${m.name} from ${g.name}? Their collection history stays in the group totals but is no longer attributed. This cannot be undone.`,
    [{ text: 'Cancel', style: 'cancel' },
     { text: 'Remove', style: 'destructive', onPress: () => {
       deleteMember(m.id).then(onChanged).catch((e: any) => Alert.alert('Could not remove the member', e?.message ?? 'Try again.'));
     } }],
  );

  return (
    <>
      {showMemberForm ? (
        <Card style={{ marginTop: 16 }}>
          <Label>Name</Label>
          <Field label="Member name" value={mName} onChangeText={setMName} placeholder="Member's full name" />
          <Label hint="(optional)">Mobile Number</Label>
          <Field label="Mobile number, optional" value={mPhone} onChangeText={setMPhone} placeholder="e.g. 98765 43210" keyboardType="phone-pad" />
          <Label hint="(optional)">Address</Label>
          <Field label="Address, optional" value={mAddress} onChangeText={setMAddress} placeholder="Door no., street, area, city" multiline />
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
            <Btn label="Cancel" kind="ghost" onPress={closeMemberForm} wide />
            <Btn label={editingId ? 'Save Changes' : 'Add Member'} icon="checkmark" onPress={saveMember} wide />
          </View>
        </Card>
      ) : (
        <TouchableOpacity style={s.addRow} onPress={openAddMember} activeOpacity={0.85}
          accessibilityRole="button" accessibilityLabel="Add member">
          <View style={s.addBtn}><Ionicons name="add" size={20} color={FIN.onBrand} /></View>
          <Text style={s.addRowTxt}>Add member</Text>
        </TouchableOpacity>
      )}
      {members.length === 0 ? <Text style={s.empty}>No members yet — add them above.</Text> : members.map(m => (
        <TouchableOpacity key={m.id} style={s.memRow} activeOpacity={0.85} onPress={() => openEditMember(m)}
          accessibilityRole="button"
          accessibilityLabel={`Member ${m.number}, ${m.name}${m.phone ? `, ${m.phone}` : ''}. Edit`}
          accessibilityActions={[{ name: 'remove', label: `Remove ${m.name}` }]}
          onAccessibilityAction={(ev) => { if (ev.nativeEvent.actionName === 'remove') removeMember(m); }}>
          <View style={s.memNum}><Text style={s.memNumTxt}>{m.number}</Text></View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.memName} numberOfLines={1}>{m.name}</Text>
            {(m.phone || m.address) && (
              <Text style={s.memSub} numberOfLines={1}>
                {[m.phone, m.address].filter(Boolean).join(' · ')}
              </Text>
            )}
          </View>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Remove ${m.name}`} onPress={() => removeMember(m)} hitSlop={14}>
            <Ionicons name="close" size={16} color={FIN.faint} />
          </TouchableOpacity>
        </TouchableOpacity>
      ))}
    </>
  );
}

export default MembersTab;
