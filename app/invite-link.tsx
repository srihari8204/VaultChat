// app/invite-link.tsx — Generate & manage group invite links (Postgres-backed).
//
// Backed by /chats/:id/invite-links (create/list/revoke) and POST /chats/join/:code.
// Links look like https://vaultchat.app/join/CODE. Admins set an optional
// expiry and revoke anytime. No Firestore.

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList, Alert, Share, StatusBar, ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { Aurora } from '../constants/theme';
import { copyAndAutoClear } from '../lib/clipboardSafe';
import { listInviteLinks, createInviteLink, revokeInviteLink, type InviteLink } from '../lib/chatService';

const JOIN_BASE = 'https://vaultchat.app/join/';
const EXPIRY_OPTS = [
  { label: 'Permanent', hours: 0 },
  { label: '1 hour', hours: 1 },
  { label: '24 hours', hours: 24 },
  { label: '7 days', hours: 168 },
];

export default function InviteLinkScreen() {
  const router = useRouter();
  const { chatId, groupName } = useLocalSearchParams<{ chatId: string; groupName: string }>();
  const [links, setLinks] = useState<InviteLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="light-content" />

      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={10}>
          <Text style={{ color: Aurora.text, fontSize: 24 }}>←</Text>
        </TouchableOpacity>
        <Text style={s.title}>Invite Links</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={s.body}>
        <View style={s.infoCard}>
          <Text style={{ fontSize: 22 }}>🔗</Text>
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
        {creating && <ActivityIndicator color={Aurora.primary} style={{ marginTop: 12 }} />}

        <Text style={[s.sectionTitle, { marginTop: 16 }]}>ACTIVE LINKS ({activeCount})</Text>
        {loading ? (
          <ActivityIndicator color={Aurora.primary} style={{ marginTop: 20 }} />
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
                  {item.revoked && <Text style={[s.linkMeta, { color: Aurora.danger }]}>Revoked</Text>}
                </View>
                {!item.revoked && (
                  <View style={s.linkBtns}>
                    <TouchableOpacity style={s.linkBtn} onPress={() => copyLink(item.code)}><Text style={s.linkBtnTxt}>Copy</Text></TouchableOpacity>
                    <TouchableOpacity style={s.linkBtn} onPress={() => shareLink(item.code)}><Text style={s.linkBtnTxt}>Share</Text></TouchableOpacity>
                    <TouchableOpacity style={[s.linkBtn, { borderColor: 'rgba(239,68,68,0.4)' }]} onPress={() => revoke(item)}>
                      <Text style={[s.linkBtnTxt, { color: Aurora.danger }]}>Revoke</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            )}
            ListEmptyComponent={<View style={{ alignItems: 'center', padding: 30 }}><Text style={s.empty}>No invite links yet</Text></View>}
          />
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: Aurora.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 54, paddingHorizontal: 16, paddingBottom: 12 },
  backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  title: { color: Aurora.text, fontSize: 18, fontWeight: '800' },
  body: { flex: 1, padding: 16 },
  infoCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: Aurora.card, borderRadius: 14, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: Aurora.border },
  infoTitle: { color: Aurora.text, fontSize: 16, fontWeight: '800' },
  infoDesc: { color: Aurora.textDim, fontSize: 12, marginTop: 2 },
  errorBar: { backgroundColor: 'rgba(239,68,68,0.12)', borderColor: 'rgba(239,68,68,0.4)', borderWidth: 1, padding: 10, borderRadius: 10, marginBottom: 12 },
  errorTxt: { color: Aurora.danger, fontSize: 12 },
  sectionTitle: { color: Aurora.textDim, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 8 },
  createRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  createOpt: { backgroundColor: 'rgba(16,185,129,0.13)', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 16, borderWidth: 1, borderColor: 'rgba(16,185,129,0.3)' },
  createOptTxt: { color: Aurora.primary, fontSize: 12, fontWeight: '700' },
  linkRow: { backgroundColor: Aurora.card, borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: Aurora.border },
  linkCode: { color: Aurora.text, fontSize: 13, fontWeight: '600', fontFamily: 'monospace' },
  linkMeta: { color: Aurora.textDim, fontSize: 11 },
  linkBtns: { flexDirection: 'row', gap: 8, marginTop: 10 },
  linkBtn: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(6,182,212,0.4)' },
  linkBtnTxt: { color: Aurora.accent, fontSize: 11, fontWeight: '700' },
  empty: { color: Aurora.textDim, fontSize: 13 },
});
