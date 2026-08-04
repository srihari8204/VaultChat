// app/group-invites.tsx — invite people to a group, and manage who you invited
// (Groups & Circles, G1).
//
// Two halves:
//   Invite — address someone by VaultChat username, phone or email, or produce
//            a QR / link to share over SMS, WhatsApp or email.
//   Sent   — the per-invitee list with real status (Pending / Accepted /
//            Rejected / Expired / Revoked), resend and revoke.
//
// The token comes back from the server exactly ONCE, at create or resend time —
// only its hash is stored server-side. So the QR is rendered from the response
// in hand; there is no "show me that invite again" fetch, by design.

import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput, Alert,
  ActivityIndicator, Share, Modal, Linking, Platform, KeyboardAvoidingView,
} from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import QRCode from 'react-native-qrcode-svg';
import * as Clipboard from 'expo-clipboard';
import { useTheme } from '../lib/theme';
import { brandAlpha } from '../constants/theme';
import {
  createInvitation, listInvitations, resendInvitation, revokeInvitation,
  type Invitation, type InvitationStatus, type NewInvitation,
} from '../lib/chatService';

/** Deep link the QR encodes. Mirrors the vaultchat:// scheme in app.json. */
const inviteURL = (token: string) => `https://vaultchat.app/i/${token}`;

type Mode = 'username' | 'phone' | 'email' | 'link';

const MODES: { key: Mode; label: string; icon: keyof typeof Ionicons.glyphMap; placeholder: string }[] = [
  { key: 'username', label: 'Username', icon: 'at',      placeholder: 'VaultChat username or ID' },
  { key: 'phone',    label: 'Phone',    icon: 'call',    placeholder: 'Phone number' },
  { key: 'email',    label: 'Email',    icon: 'mail',    placeholder: 'Email address' },
  { key: 'link',     label: 'Link/QR',  icon: 'qr-code', placeholder: '' },
];

const STATUS_TONE: Record<InvitationStatus, 'good' | 'warn' | 'bad' | 'mute'> = {
  accepted: 'good', pending: 'warn', rejected: 'bad', revoked: 'bad', expired: 'mute',
};

const STATUS_LABEL: Record<InvitationStatus, string> = {
  pending: 'Pending', accepted: 'Accepted', rejected: 'Declined',
  expired: 'Expired', revoked: 'Revoked',
};

export default function GroupInvitesScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ chatId?: string; name?: string }>();
  const chatId = String(params.chatId || '');
  const groupName = String(params.name || 'this group');

  const [mode, setMode] = useState<Mode>('username');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [fresh, setFresh] = useState<NewInvitation | null>(null);

  const refresh = useCallback(async () => {
    if (!chatId) { setLoading(false); return; }
    try { setSent(await listInvitations(chatId)); }
    catch { /* a permission error here just means an empty list for this user */ }
    finally { setLoading(false); }
  }, [chatId]);

  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));

  const tone = (t: 'good' | 'warn' | 'bad' | 'mute') =>
    t === 'good' ? colors.success : t === 'warn' ? colors.primary
      : t === 'bad' ? colors.danger : colors.textDim;

  const invite = async () => {
    if (busy || !chatId) return;
    const v = value.trim();
    if (mode !== 'link' && !v) { Alert.alert('Who?', 'Enter who you want to invite.'); return; }
    setBusy(true);
    try {
      const who = mode === 'username' ? { userId: v }
        : mode === 'phone' ? { phone: v }
        : mode === 'email' ? { email: v }
        : {};
      const channel = mode === 'link' ? 'link' as const : 'app' as const;
      const created = await createInvitation(chatId, who, { channel });
      setFresh(created);      // the token is in hand exactly once — show it now
      setValue('');
      refresh();
    } catch (e: any) {
      Alert.alert('Could not invite', e?.message ?? 'Try again.');
    } finally { setBusy(false); }
  };

  const shareVia = async (how: 'sms' | 'whatsapp' | 'email' | 'system') => {
    if (!fresh) return;
    const url = inviteURL(fresh.token);
    const msg = `Join "${groupName}" on VaultChat: ${url}`;
    try {
      if (how === 'system') { await Share.share({ message: msg }); return; }
      const target =
        how === 'sms' ? `sms:?body=${encodeURIComponent(msg)}`
        : how === 'whatsapp' ? `whatsapp://send?text=${encodeURIComponent(msg)}`
        : `mailto:?subject=${encodeURIComponent(`Join ${groupName}`)}&body=${encodeURIComponent(msg)}`;
      if (await Linking.canOpenURL(target)) await Linking.openURL(target);
      else await Share.share({ message: msg });   // app not installed → fall back
    } catch {
      Alert.alert('Could not share', 'Copy the link instead.');
    }
  };

  const copy = async (text: string, what: string) => {
    await Clipboard.setStringAsync(text);
    Alert.alert('Copied', `${what} copied to your clipboard.`);
  };

  const doResend = async (inv: Invitation) => {
    try {
      const again = await resendInvitation(chatId, inv.id);
      setFresh(again);   // new token, new QR — the old one is now dead
      refresh();
    } catch (e: any) { Alert.alert('Could not resend', e?.message ?? 'Try again.'); }
  };

  const doRevoke = (inv: Invitation) => {
    Alert.alert('Revoke invitation?', 'Their link and QR stop working immediately.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Revoke', style: 'destructive', onPress: async () => {
        try { await revokeInvitation(chatId, inv.id); refresh(); }
        catch (e: any) { Alert.alert('Could not revoke', e?.message ?? 'Try again.'); }
      } },
    ]);
  };

  const who = (inv: Invitation) =>
    inv.name || inv.ref || (inv.kind === 'link' ? 'Anyone with the link' : 'Invited contact');

  const active = MODES.find((m) => m.key === mode)!;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: 'Invite people', headerTitleAlign: 'center' }} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">

        <Text style={[st.h, { color: colors.text }]}>Invite to {groupName}</Text>

        <View style={st.modes}>
          {MODES.map((m) => {
            const on = m.key === mode;
            return (
              <TouchableOpacity key={m.key} onPress={() => { setMode(m.key); setValue(''); }}
                style={[st.modeChip, { borderColor: on ? colors.primary : colors.border, backgroundColor: on ? brandAlpha(0.1) : 'transparent' }]}>
                <Ionicons name={m.icon} size={14} color={on ? colors.primary : colors.textDim} />
                <Text style={{ color: on ? colors.primary : colors.text, fontSize: 12.5, fontWeight: on ? '700' : '500' }}>{m.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {mode !== 'link' && (
          <View style={[st.field, { borderColor: colors.border, backgroundColor: colors.surface }]}>
            <Ionicons name={active.icon} size={17} color={colors.textDim} />
            <TextInput
              value={value} onChangeText={setValue} placeholder={active.placeholder}
              placeholderTextColor={colors.textFaint} style={[st.input, { color: colors.text }]}
              autoCapitalize="none" autoCorrect={false}
              keyboardType={mode === 'phone' ? 'phone-pad' : mode === 'email' ? 'email-address' : 'default'}
              returnKeyType="send" onSubmitEditing={invite}
            />
          </View>
        )}

        <TouchableOpacity onPress={invite} disabled={busy}
          style={[st.btn, { backgroundColor: busy ? colors.border : colors.primary }]}>
          {busy ? <ActivityIndicator color="#fff" />
            : <><Ionicons name={mode === 'link' ? 'qr-code' : 'person-add'} size={17} color="#fff" />
                <Text style={st.btnTxt}>{mode === 'link' ? 'Create link & QR' : 'Send invitation'}</Text></>}
        </TouchableOpacity>

        <View style={st.sechead}>
          <Text style={[st.h, { color: colors.text, marginBottom: 0 }]}>Sent ({sent.length})</Text>
          {loading && <ActivityIndicator size="small" color={colors.primary} />}
        </View>

        {!loading && sent.length === 0 && (
          <Text style={{ color: colors.textDim, fontSize: 13.5 }}>
            Nobody invited yet. Invitations you send show up here with their status.
          </Text>
        )}

        {sent.map((inv) => {
          const t = tone(STATUS_TONE[inv.status]);
          const open = inv.status === 'pending' || inv.status === 'expired';
          return (
            <View key={inv.id} style={[st.row, { borderColor: colors.border }]}>
              <View style={[st.rowIcon, { backgroundColor: t + '22' }]}>
                <Ionicons
                  name={inv.kind === 'link' ? 'link' : inv.kind === 'phone' ? 'call' : inv.kind === 'email' ? 'mail' : 'person'}
                  size={16} color={t}
                />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: colors.text, fontWeight: '600', fontSize: 14 }} numberOfLines={1}>{who(inv)}</Text>
                <Text style={{ color: t, fontSize: 11.5 }}>{STATUS_LABEL[inv.status]}</Text>
              </View>
              {open && (
                <TouchableOpacity onPress={() => doResend(inv)} style={st.rowBtn}>
                  <Ionicons name="refresh" size={17} color={colors.primary} />
                </TouchableOpacity>
              )}
              {open && (
                <TouchableOpacity onPress={() => doRevoke(inv)} style={st.rowBtn}>
                  <Ionicons name="close-circle" size={17} color={colors.danger} />
                </TouchableOpacity>
              )}
            </View>
          );
        })}
      </ScrollView>

      {/* The token exists in memory only until this sheet closes. */}
      <Modal visible={!!fresh} transparent animationType="slide" onRequestClose={() => setFresh(null)}>
        <View style={st.backdrop}>
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setFresh(null)} />
          <View style={[st.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={{ color: colors.text, fontWeight: '800', fontSize: 17, textAlign: 'center' }}>
              Invitation ready
            </Text>
            <Text style={{ color: colors.textDim, fontSize: 12.5, textAlign: 'center', marginTop: 4 }}>
              Share it now — this code is shown only once.
            </Text>

            {!!fresh && (
              <View style={st.qrWrap}>
                <View style={st.qrPad}>
                  <QRCode value={inviteURL(fresh.token)} size={168} backgroundColor="#fff" color="#000" />
                </View>
                <TouchableOpacity onPress={() => copy(fresh.code, 'Invite code')} style={{ marginTop: 12 }}>
                  <Text style={{ color: colors.primary, fontWeight: '800', fontSize: 16, letterSpacing: 2 }}>{fresh.code}</Text>
                </TouchableOpacity>
                <Text style={{ color: colors.textFaint, fontSize: 11 }}>tap the code to copy</Text>
              </View>
            )}

            <View style={st.shareRow}>
              {([
                ['sms', 'chatbubble', 'SMS'],
                ['whatsapp', 'logo-whatsapp', 'WhatsApp'],
                ['email', 'mail', 'Email'],
                ['system', 'share-social', 'More'],
              ] as const).map(([how, icon, label]) => (
                <TouchableOpacity key={how} onPress={() => shareVia(how)}
                  style={[st.shareBtn, { borderColor: colors.border, backgroundColor: colors.surface }]}>
                  <Ionicons name={icon} size={19} color={colors.primary} />
                  <Text style={{ color: colors.text, fontSize: 11 }}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <TouchableOpacity onPress={() => fresh && copy(inviteURL(fresh.token), 'Invite link')}
              style={[st.btn, { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border }]}>
              <Ionicons name="copy" size={16} color={colors.text} />
              <Text style={[st.btnTxt, { color: colors.text }]}>Copy link</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setFresh(null)} style={[st.btn, { backgroundColor: colors.primary, marginTop: 8 }]}>
              <Text style={st.btnTxt}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const st = StyleSheet.create({
  h: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 10 },
  modes: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  modeChip: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  field: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, height: 50 },
  input: { flex: 1, fontSize: 15 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 50, borderRadius: 13, marginTop: 14 },
  btnTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },
  sechead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 30, marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth },
  rowIcon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  rowBtn: { padding: 6 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: { borderTopLeftRadius: 22, borderTopRightRadius: 22, borderTopWidth: 1, padding: 20, paddingBottom: 34 },
  qrWrap: { alignItems: 'center', marginTop: 18 },
  qrPad: { padding: 12, backgroundColor: '#fff', borderRadius: 14 },
  shareRow: { flexDirection: 'row', gap: 9, marginTop: 20 },
  shareBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4, height: 58, borderWidth: 1, borderRadius: 13 },
});
