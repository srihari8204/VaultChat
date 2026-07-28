// app/new-chat.tsx — WhatsApp-style "New chat": a search bar, action rows
// (New group / New community / New contact), then your contacts list inline
// (tap to open). Phone-number add + invite-link join live under "New contact"
// and a footer row. Full address-book discovery stays on /contacts.

import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Platform,
  StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { Avatar } from '../components/ui';
import { PhoneField, toE164 } from '../components/auth/PhoneField';
import { createDirectChat, listChats, attachmentUrl, type ChatSummary } from '../lib/chatService';
import { getAccessToken } from '../lib/api';

type Contact = { chatId: string; userId: string; name: string; photoURL: string | null; online: boolean };

export default function NewChatScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();

  const [query, setQuery] = useState('');
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [authHeader, setAuthHeader] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);

  // "New contact" inline add
  const [addOpen, setAddOpen] = useState(false);
  const [dialCode, setDialCode] = useState('+91');
  const [national, setNational] = useState('');
  const [adding, setAdding] = useState(false);
  const e164 = toE164(dialCode, national);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const [list, tok] = await Promise.all([listChats(), getAccessToken()]);
        if (cancel) return;
        setAuthHeader(tok ? `Bearer ${tok}` : null);
        const seen = new Set<string>();
        const out: Contact[] = [];
        for (const c of list as ChatSummary[]) {
          if (c.type === 'direct' && c.peerUserId && !seen.has(c.peerUserId)) {
            seen.add(c.peerUserId);
            out.push({ chatId: c.id, userId: c.peerUserId, name: c.peerName || 'VaultChat user', photoURL: c.peerPhotoURL ?? null, online: !!c.peerOnline });
          }
        }
        out.sort((a, b) => a.name.localeCompare(b.name));
        setContacts(out);
      } catch {} finally { if (!cancel) setLoadingList(false); }
    })();
    return () => { cancel = true; };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? contacts.filter(c => c.name.toLowerCase().includes(q)) : contacts;
  }, [query, contacts]);

  const startByPhone = async () => {
    if (!e164 || adding) return;
    setAdding(true);
    try {
      const res = await createDirectChat({ phone: e164 });
      router.replace({ pathname: '/chat', params: { id: res.id } } as any);
    } catch (e: any) {
      Alert.alert('Could not start chat', e?.message ?? 'The number may not be on VaultChat yet.');
    } finally { setAdding(false); }
  };

  const ActionRow = ({ icon, title, onPress }: { icon: any; title: string; onPress: () => void }) => (
    <TouchableOpacity style={S.action} onPress={onPress} activeOpacity={0.7}>
      <View style={S.actionIcon}><Ionicons name={icon} size={22} color="#fff" /></View>
      <Text style={S.actionTitle}>{title}</Text>
    </TouchableOpacity>
  );

  const searching = query.trim().length > 0;

  return (
    <KeyboardAvoidingView style={S.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} style={S.backBtn} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.title}>New chat</Text>
      </View>

      <View style={S.searchWrap}>
        <Ionicons name="search" size={18} color={colors.textDim} />
        <TextInput
          style={S.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="Search name or number"
          placeholderTextColor={colors.textDim}
          autoCorrect={false}
        />
        {searching && <TouchableOpacity onPress={() => setQuery('')} hitSlop={8}><Ionicons name="close-circle" size={18} color={colors.textDim} /></TouchableOpacity>}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={c => c.userId}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 32 }}
        ListHeaderComponent={
          searching ? null : (
            <View>
              <ActionRow icon="people" title="New group" onPress={() => router.push('/create-group' as any)} />
              <ActionRow icon="people-circle" title="New community" onPress={() => router.push('/communities' as any)} />
              <ActionRow icon="person-add" title="New contact" onPress={() => setAddOpen(v => !v)} />

              {addOpen && (
                <View style={S.addBox}>
                  <PhoneField dialCode={dialCode} national={national} onChange={(d, n) => { setDialCode(d); setNational(n); }} />
                  <TouchableOpacity style={[S.cta, !e164 && S.ctaOff]} onPress={startByPhone} disabled={!e164 || adding} activeOpacity={0.85}>
                    {adding ? <ActivityIndicator color="#fff" /> : <Text style={S.ctaTxt}>Start chat</Text>}
                  </TouchableOpacity>
                  <Text style={S.hint}>The number must belong to someone on VaultChat.</Text>
                </View>
              )}

              <ActionRow icon="book" title="Find from address book" onPress={() => router.push('/contacts' as any)} />

              <Text style={S.sectionLabel}>CONTACTS ON VAULTCHAT</Text>
            </View>
          )
        }
        renderItem={({ item }) => (
          <TouchableOpacity style={S.row} activeOpacity={0.7} onPress={() => router.push({ pathname: '/chat', params: { id: item.chatId } } as any)}>
            <Avatar uri={item.photoURL && authHeader ? attachmentUrl(item.photoURL) : null} headers={authHeader ? { Authorization: authHeader } : undefined} name={item.name} size={46} presence={item.online ? 'online' : null} />
            <View style={{ flex: 1 }}>
              <Text style={S.rowName} numberOfLines={1}>{item.name}</Text>
              {item.online && <Text style={S.rowSub}>online</Text>}
            </View>
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          loadingList ? <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} />
          : <Text style={S.empty}>{searching ? 'No contacts found' : 'No contacts yet — add one above or find from your address book.'}</Text>
        }
      />
    </KeyboardAvoidingView>
  );
}

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 56, paddingBottom: 12, gap: 8 },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { color: c.text, fontSize: 20, fontWeight: '800' },
  searchWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 14, marginBottom: 8, paddingHorizontal: 14, height: 42, borderRadius: 21, backgroundColor: c.card },
  searchInput: { flex: 1, color: c.text, fontSize: 15 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 12, paddingHorizontal: 18 },
  actionIcon: { width: 46, height: 46, borderRadius: 23, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  actionTitle: { color: c.text, fontSize: 16, fontWeight: '600' },
  addBox: { paddingHorizontal: 18, paddingVertical: 8, gap: 4 },
  cta: { marginTop: 12, height: 50, borderRadius: 14, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  ctaOff: { opacity: 0.4 },
  ctaTxt: { color: '#fff', fontSize: 16, fontWeight: '800' },
  hint: { color: c.textFaint, fontSize: 12, marginTop: 8, lineHeight: 17 },
  sectionLabel: { color: c.textDim, fontSize: 12, fontWeight: '700', letterSpacing: 1, paddingHorizontal: 18, paddingTop: 14, paddingBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 9, paddingHorizontal: 18 },
  rowName: { color: c.text, fontSize: 16, fontWeight: '500' },
  rowSub: { color: c.online ?? c.textDim, fontSize: 12, marginTop: 1 },
  empty: { color: c.textDim, fontSize: 14, textAlign: 'center', marginTop: 40, paddingHorizontal: 40, lineHeight: 20 },
});
