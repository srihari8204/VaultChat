// app/invite-link.tsx — Generate & manage group invite links (Postgres-backed).
//
// Backed by /chats/:id/invite-links (create/list/revoke) and POST /chats/join/:code.
// Links look like https://vaultchat.app/join/CODE. Admins set an optional
// expiry and revoke anytime. No Firestore.

import { HEADER_TOP } from '../constants/layout';
import { brandAlpha, type Palette } from '../constants/theme';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList, Alert, Share, StatusBar, ActivityIndicator, Modal,
} from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import QRCode from 'react-native-qrcode-svg';
import { useTheme } from '../lib/theme';
import { copyAndAutoClear } from '../lib/clipboardSafe';
import { listInviteLinks, createInviteLink, revokeInviteLink, type InviteLink } from '../lib/chatService';
import { AuroraBackground } from '../components/ui';

const JOIN_BASE = 'https://vaultchat.app/join/';
const EXPIRY_OPTS = [
  { label: 'Permanent', hours: 0 },
  { label: '1 hour', hours: 1 },
  { label: '24 hours', hours: 24 },
  { label: '7 days', hours: 168 },
];

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function InviteLinkScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const { chatId, groupName } = useLocalSearchParams<{ chatId: string; groupName: string }>();
  const [links, setLinks] = useState<InviteLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!chatId) { setLoading(false); return; }
    try { setLinks(await listInviteLinks(chatId)); setError(null); }
    catch (e: any) { setError(e?.message ?? 'Failed to load links'); }
    finally { setLoading(false); }
  }, [chatId]);

  useEffect(() => { load(); }, [load]);

  const createLink = async (hours: number) => {
    if (!chatId) return;
    setCreating(true);
    try {
      const link = await createInviteLink(chatId, { expiresInHours: hours });
      setLinks(prev => [link, ...prev]);
      Alert.alert('Link created', JOIN_BASE + link.code);
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Could not create link');
    } finally {
      setCreating(false);
    }
  };

  const shareLink = (code: string) =>
    Share.share({ message: `Join ${groupName || 'our group'} on VaultChat!\n${JOIN_BASE}${code}` });

  const copyLink = async (code: string) => {
    await copyAndAutoClear(JOIN_BASE + code);
    Alert.alert('Copied', 'Invite link copied to clipboard');
  };

  const revoke = (link: InviteLink) => {
    Alert.alert('Revoke link?', 'This link will no longer work.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Revoke', style: 'destructive', onPress: async () => {
        const prev = links;
        setLinks(list => list.map(l => l.id === link.id ? { ...l, revoked: true } : l));
        try { await revokeInviteLink(chatId!, link.id); }
        catch (e: any) { setLinks(prev); Alert.alert('Error', e?.message ?? 'Revoke failed'); }
      } },
    ]);
  };

  const formatExpiry = (iso: string | null) => {
    if (!iso) return 'Never expires';
    const d = new Date(iso);
    if (d.getTime() < Date.now()) return 'Expired';
    const hrs = Math.round((d.getTime() - Date.now()) / 3600000);
    return hrs < 24 ? `${hrs}h remaining` : `${Math.round(hrs / 24)}d remaining`;
  };

  const activeCount = useMemo(() => links.filter(l => !l.revoked).length, [links]);

  return (
    <View style={s.container}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="light-content" />

      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.title}>Invite Links</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={s.body}>
        <View style={s.infoCard}>
          <Ionicons name="link-outline" size={22} color={colors.text} />
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={s.infoTitle}>{groupName || 'Group'} Invite Links</Text>
            <Text style={s.infoDesc}>Anyone with this link can join. Set an expiry or revoke anytime.</Text>
          </View>
        </View>

        {error && <View style={s.errorBar}><Text style={s.errorTxt}>{error}</Text></View>}

        <Text style={s.sectionTitle}>CREATE NEW LINK</Text>
        <View style={s.createRow}>
          {EXPIRY_OPTS.map(opt => (
            <TouchableOpacity key={opt.label} style={s.createOpt} onPress={() => createLink(opt.hours)} disabled={creating}>
              <Text style={s.createOptTxt}>{opt.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        {creating && <ActivityIndicator color={colors.primary} style={{ marginTop: 12 }} />}

        <Text style={[s.sectionTitle, { marginTop: 16 }]}>ACTIVE LINKS ({activeCount})</Text>
        {loading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 20 }} />
        ) : (
          <FlatList
            data={links}
            keyExtractor={l => String(l.id)}
            renderItem={({ item }) => (
              <View style={[s.linkRow, item.revoked && { opacity: 0.45 }]}>
                <Text style={s.linkCode} numberOfLines={1}>vaultchat.app/join/{item.code}</Text>
                <View style={{ flexDirection: 'row', gap: 12, marginTop: 4 }}>
                  <Text style={s.linkMeta}>{item.uses} joins</Text>
                  <Text style={s.linkMeta}>{formatExpiry(item.expiresAt)}</Text>
                  {item.revoked && <Text style={[s.linkMeta, { color: colors.danger }]}>Revoked</Text>}
                </View>
                {!item.revoked && (
                  <View style={s.linkBtns}>
                    <TouchableOpacity style={s.linkBtn} onPress={() => copyLink(item.code)}>
                      <Ionicons name="copy-outline" size={15} color={colors.text} />
                      <Text style={s.linkBtnTxt}>Copy</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={s.linkBtn} onPress={() => shareLink(item.code)}>
                      <Ionicons name="share-social-outline" size={15} color={colors.text} />
                      <Text style={s.linkBtnTxt}>Share</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={s.linkBtn} onPress={() => setQrCode(item.code)}>
                      <Ionicons name="qr-code-outline" size={15} color={colors.text} />
                      <Text style={s.linkBtnTxt}>QR</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={s.linkBtn} onPress={() => revoke(item)}>
                      <Ionicons name="trash-outline" size={15} color={colors.danger} />
                      <Text style={[s.linkBtnTxt, { color: colors.danger }]}>Revoke</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            )}
            ListEmptyComponent={<View style={{ alignItems: 'center', padding: 30 }}><Text style={s.empty}>No invite links yet</Text></View>}
          />
        )}
      </View>

      {/* QR for an invite link — scannable from the other device's camera */}
      <Modal visible={qrCode != null} transparent animationType="fade" onRequestClose={() => setQrCode(null)}>
        <View style={s.qrBackdrop}>
          <View style={s.qrCard}>
            <Text style={s.qrTitle}>Scan to join {groupName || 'group'}</Text>
            <View style={s.qrBox}>
              {qrCode && <QRCode value={JOIN_BASE + qrCode} size={220} backgroundColor="#FFFFFF" color="#0A0A0F" />}
            </View>
            <Text style={s.qrCode} numberOfLines={1}>vaultchat.app/join/{qrCode}</Text>
            <TouchableOpacity style={s.qrClose} onPress={() => setQrCode(null)}>
              <Text style={s.qrCloseTxt}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: HEADER_TOP, paddingHorizontal: 16, paddingBottom: 12 },
  backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  title: { color: c.text, fontSize: 18, fontWeight: '800' },
  body: { flex: 1, padding: 16 },
  infoCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.glassSoft, borderRadius: 14, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: c.glassStroke },
  infoTitle: { color: c.text, fontSize: 16, fontWeight: '800' },
  infoDesc: { color: c.textDim, fontSize: 12, marginTop: 2 },
  errorBar: { backgroundColor: 'rgba(239,68,68,0.12)', borderColor: 'rgba(239,68,68,0.4)', borderWidth: 1, padding: 10, borderRadius: 10, marginBottom: 12 },
  errorTxt: { color: c.danger, fontSize: 12 },
  sectionTitle: { color: c.textDim, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 8 },
  createRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  createOpt: { backgroundColor: brandAlpha(0.13), borderRadius: 10, paddingVertical: 10, paddingHorizontal: 16, borderWidth: 1, borderColor: brandAlpha(0.3) },
  createOptTxt: { color: c.primary, fontSize: 12, fontWeight: '700' },
  linkRow: { backgroundColor: c.glassSoft, borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: c.glassStroke },
  linkCode: { color: c.text, fontSize: 13, fontWeight: '600', fontFamily: 'monospace' },
  linkMeta: { color: c.textDim, fontSize: 11 },
  linkBtns: { flexDirection: 'row', gap: 8, marginTop: 10 },
  linkBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: c.glassStroke, backgroundColor: c.glassSoft },
  linkBtnTxt: { color: c.text, fontSize: 11, fontWeight: '700' },
  empty: { color: c.textDim, fontSize: 13 },
  qrBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  qrCard: { backgroundColor: c.glassSoft, borderRadius: 24, padding: 24, alignItems: 'center', width: '100%', maxWidth: 320, borderWidth: 1, borderColor: c.glassStroke },
  qrTitle: { color: c.text, fontSize: 16, fontWeight: '800', marginBottom: 16, textAlign: 'center' },
  qrBox: { backgroundColor: c.glassSoft, padding: 16, borderRadius: 16 },
  qrCode: { color: c.textDim, fontSize: 12, fontFamily: 'monospace', marginTop: 16 },
  qrClose: { marginTop: 20, paddingVertical: 12, paddingHorizontal: 40, borderRadius: 14, backgroundColor: c.primary },
  qrCloseTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },
});
