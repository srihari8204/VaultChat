// app/invite-link.tsx — Generate & manage invite links for groups
// Creates shareable links: vaultchat.app/join/CODE
// Supports expiry, max uses, revoke

import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList,
  Alert, Share, StatusBar, ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import { copyAndAutoClear } from '../lib/clipboardSafe';

const C = { bg: '#FFFFFF', accent: '#4A9FFF', green: '#10B981', card: '#F9FAFB', danger: '#FF3C6E' };
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
const genLinkCode = () => { let s = ''; for (let i = 0; i < 12; i++) s += CHARS[Math.floor(Math.random() * CHARS.length)]; return s; };

export default function InviteLinkScreen() {
  const { chatId, groupName } = useLocalSearchParams();
  const myUid = auth().currentUser?.uid || '';
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const loadLinks = async () => {
    setLoading(true);
    try {
      const snap = await firestore().collection('inviteLinks')
        .where('chatId', '==', chatId)
        .where('createdBy', '==', myUid)
        .orderBy('createdAt', 'desc')
        .get();
      setLinks(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch {}
    setLoading(false);
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadLinks(); }, [chatId, myUid]);

  const createLink = async (expiry) => {
    setCreating(true);
    try {
      const code = genLinkCode();
      const expiresAt = expiry > 0 ? new Date(Date.now() + expiry * 3600000) : null;
      await firestore().collection('inviteLinks').add({
        code,
        chatId,
        groupName: groupName || 'Group',
        createdBy: myUid,
        createdAt: firestore.FieldValue.serverTimestamp(),
        expiresAt: expiresAt ? firestore.Timestamp.fromDate(expiresAt) : null,
        maxUses: 0,
        uses: 0,
        revoked: false,
      });
      await loadLinks();
      Alert.alert('Link Created!', 'https://vaultchat.app/join/' + code);
    } catch { Alert.alert('Error', 'Could not create link'); }
    setCreating(false);
  };

  const shareLink = (code) => {
    const url = 'https://vaultchat.app/join/' + code;
    Share.share({ message: 'Join ' + (groupName || 'our group') + ' on VaultChat!\n' + url });
  };

  const copyLink = async (code) => {
    await copyAndAutoClear('https://vaultchat.app/join/' + code);
    Alert.alert('Copied!', 'Invite link copied to clipboard');
  };

  const revokeLink = (link) => {
    Alert.alert('Revoke Link?', 'This link will no longer work.', [
      { text: 'Cancel' },
      { text: 'Revoke', style: 'destructive', onPress: async () => {
        await firestore().collection('inviteLinks').doc(link.id).update({ revoked: true });
        setLinks(prev => prev.map(l => l.id === link.id ? { ...l, revoked: true } : l));
      }},
    ]);
  };

  const formatExpiry = (ts) => {
    if (!ts?.toDate) return 'Never expires';
    const d = ts.toDate();
    if (d < new Date()) return 'Expired';
    const hrs = Math.round((d.getTime() - Date.now()) / 3600000);
    if (hrs < 24) return hrs + 'h remaining';
    return Math.round(hrs / 24) + 'd remaining';
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Invite Links', headerStyle: { backgroundColor: '#FFFFFF' }, headerTintColor: '#1F2937' }} />
      <View style={s.container}>
        <StatusBar barStyle="light-content" />

        <View style={s.infoCard}>
          <Text style={{ fontSize: 24 }}>{"\uD83D\uDD17"}</Text>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={s.infoTitle}>{groupName || 'Group'} Invite Links</Text>
            <Text style={s.infoDesc}>Anyone with this link can join. You can set expiry or revoke anytime.</Text>
          </View>
        </View>

        <Text style={s.sectionTitle}>CREATE NEW LINK</Text>
        <View style={s.createRow}>
          {[
            { label: 'Permanent', hours: 0 },
            { label: '24 hours', hours: 24 },
            { label: '7 days', hours: 168 },
            { label: '1 hour', hours: 1 },
          ].map(opt => (
            <TouchableOpacity key={opt.label} style={s.createOpt} onPress={() => createLink(opt.hours)} disabled={creating}>
              <Text style={s.createOptTxt}>{opt.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={[s.sectionTitle, { marginTop: 16 }]}>ACTIVE LINKS ({links.filter(l => !l.revoked).length})</Text>
        {loading ? <ActivityIndicator color={C.accent} style={{ marginTop: 20 }} /> : (
          <FlatList
            data={links}
            keyExtractor={l => l.id}
            renderItem={({ item }) => (
              <View style={[s.linkRow, item.revoked && { opacity: 0.4 }]}>
                <View style={{ flex: 1 }}>
                  <Text style={s.linkCode}>vaultchat.app/join/{item.code}</Text>
                  <View style={{ flexDirection: 'row', gap: 12, marginTop: 4 }}>
                    <Text style={s.linkMeta}>{item.uses || 0} joins</Text>
                    <Text style={s.linkMeta}>{formatExpiry(item.expiresAt)}</Text>
                    {item.revoked && <Text style={[s.linkMeta, { color: C.danger }]}>Revoked</Text>}
                  </View>
                </View>
                {!item.revoked && (
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <TouchableOpacity style={s.linkBtn} onPress={() => copyLink(item.code)}>
                      <Text style={s.linkBtnTxt}>Copy</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={s.linkBtn} onPress={() => shareLink(item.code)}>
                      <Text style={s.linkBtnTxt}>Share</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[s.linkBtn, { borderColor: '#FF3C6E33' }]} onPress={() => revokeLink(item)}>
                      <Text style={[s.linkBtnTxt, { color: C.danger }]}>Revoke</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            )}
            ListEmptyComponent={<View style={{ alignItems: 'center', padding: 30 }}><Text style={{ color: '#6B7280' }}>No invite links yet</Text></View>}
          />
        )}
      </View>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, padding: 16 },
  infoCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 14, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#E5E7EB' },
  infoTitle: { color: '#fff', fontSize: 16, fontWeight: '800' },
  infoDesc: { color: '#9CA3AF', fontSize: 12, marginTop: 2 },
  sectionTitle: { color: '#6B7280', fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 8 },
  createRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  createOpt: { backgroundColor: '#4A9FFF22', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 16, borderWidth: 1, borderColor: '#4A9FFF44' },
  createOptTxt: { color: C.accent, fontSize: 12, fontWeight: '700' },
  linkRow: { backgroundColor: C.card, borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: '#E5E7EB' },
  linkCode: { color: '#1F2937', fontSize: 13, fontWeight: '600', fontFamily: 'monospace' },
  linkMeta: { color: '#6B7280', fontSize: 11 },
  linkBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: '#4A9FFF44' },
  linkBtnTxt: { color: C.accent, fontSize: 11, fontWeight: '700' },
});
