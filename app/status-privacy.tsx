// app/status-privacy.tsx — WhatsApp "Status privacy" (who can see my status).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Alert,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';
import { Avatar } from '../components/ui';
import {
  getStatusPrivacy, setStatusPrivacy, listChats, attachmentUrl,
  type StatusPrivacyMode,
} from '../lib/chatService';
import { getAccessToken } from '../lib/api';

type Contact = { id: string; name: string; photoURL: string | null };
const MODES: { key: StatusPrivacyMode; label: string; sub: string }[] = [
  { key: 'contacts', label: 'My contacts', sub: 'Everyone you share a chat with' },
  { key: 'except', label: 'My contacts except…', sub: 'Hide your status from some people' },
  { key: 'only', label: 'Only share with…', sub: 'Share only with selected people' },
];

export default function StatusPrivacyScreen() {
  const { colors } = useTheme();
  const S = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();

  const [mode, setMode] = useState<StatusPrivacyMode>('contacts');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [authHeader, setAuthHeader] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [priv, chats, tok] = await Promise.all([getStatusPrivacy(), listChats(), getAccessToken()]);
        setMode(priv.mode); setSelected(new Set(priv.userIds));
        setAuthHeader(tok ? `Bearer ${tok}` : null);
        const seen = new Set<string>();
        const c: Contact[] = [];
        for (const ch of chats) {
          if (ch.type === 'direct' && ch.peerUserId && !seen.has(ch.peerUserId)) {
            seen.add(ch.peerUserId);
            c.push({ id: ch.peerUserId, name: ch.peerName || 'VaultChat user', photoURL: ch.peerPhotoURL ?? null });
          }
        }
        setContacts(c);
      } catch {} finally { setLoading(false); }
    })();
  }, []);

  const save = useCallback(async (m: StatusPrivacyMode, ids: Set<string>) => {
    try { await setStatusPrivacy(m, m === 'contacts' ? [] : [...ids]); }
    catch (e: any) { Alert.alert('Could not save', e?.message ?? 'Try again'); }
  }, []);

  const pickMode = (m: StatusPrivacyMode) => { setMode(m); save(m, selected); };
  const toggle = (id: string) => setSelected(prev => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id);
    save(mode, n);
    return n;
  });

  return (
    <View style={S.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={8} style={S.hBtn}><Ionicons name="arrow-back" size={24} color={colors.text} /></TouchableOpacity>
        <Text style={S.hTitle}>Status privacy</Text>
      </View>

      {loading ? (
        <View style={S.center}><ActivityIndicator color={colors.primary} size="large" /></View>
      ) : (
        <FlatList
          data={mode === 'contacts' ? [] : contacts}
          keyExtractor={c => c.id}
          ListHeaderComponent={
            <View>
              {MODES.map(m => (
                <TouchableOpacity key={m.key} style={S.modeRow} activeOpacity={0.7} onPress={() => pickMode(m.key)}>
                  <Ionicons name={mode === m.key ? 'radio-button-on' : 'radio-button-off'} size={22} color={mode === m.key ? colors.primary : colors.textDim} />
                  <View style={{ flex: 1 }}>
                    <Text style={S.modeLabel}>{m.label}</Text>
                    <Text style={S.modeSub}>{m.sub}</Text>
                  </View>
                </TouchableOpacity>
              ))}
              {mode !== 'contacts' && (
                <Text style={S.sectionLabel}>
                  {mode === 'except' ? 'EXCLUDED' : 'SHARED WITH'} · {selected.size}
                </Text>
              )}
            </View>
          }
          renderItem={({ item }) => {
            const on = selected.has(item.id);
            return (
              <TouchableOpacity style={S.contactRow} activeOpacity={0.7} onPress={() => toggle(item.id)}>
                <Avatar uri={item.photoURL && authHeader ? attachmentUrl(item.photoURL) : null} headers={authHeader ? { Authorization: authHeader } : undefined} name={item.name} size={44} />
                <Text style={S.contactName} numberOfLines={1}>{item.name}</Text>
                <Ionicons name={on ? 'checkmark-circle' : 'ellipse-outline'} size={22} color={on ? colors.primary : colors.textDim} />
              </TouchableOpacity>
            );
          }}
        />
      )}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingTop: 54, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  hBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  hTitle: { color: c.text, fontSize: 18, fontWeight: '700' },
  modeRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 14 },
  modeLabel: { color: c.text, fontSize: 16, fontWeight: '600' },
  modeSub: { color: c.textDim, fontSize: 13, marginTop: 2 },
  sectionLabel: { color: c.textDim, fontSize: 12, fontWeight: '700', letterSpacing: 1, marginHorizontal: 16, marginTop: 12, marginBottom: 4 },
  contactRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 10 },
  contactName: { flex: 1, color: c.text, fontSize: 16, fontWeight: '500' },
});
