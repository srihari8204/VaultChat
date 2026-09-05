// app/trusted-contacts.tsx — Trusted (emergency) Contacts (Postgres-backed).
//
// Up to 3 contacts alerted on duress-PIN / new-device / panic events.
// Backed by /contacts/trusted (list/add-by-VaultID/remove). No Firestore.

import { HEADER_TOP } from '../constants/layout';
import { brandAlpha } from '../constants/theme';
import React, { useState, useEffect, useCallback , useMemo} from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList, Alert, StatusBar, ActivityIndicator, TextInput,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { readCache, writeCache } from '../lib/localCache';
import { listTrustedContacts, addTrustedContact, removeTrustedContact, type TrustedContact } from '../lib/chatService';
import { AuroraBackground } from '../components/ui';

const MAX_TRUSTED = 3;
const CACHE_KEY = 'trusted-contacts';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function TrustedContactsScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const [trusted, setTrusted] = useState<TrustedContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [searchId, setSearchId] = useState('');
  const [searching, setSearching] = useState(false);

  const load = useCallback(async (hasCache: boolean) => {
    try {
      const list = await listTrustedContacts();
      setTrusted(list);
      writeCache(CACHE_KEY, list);
    }
    // Keep cached contacts if we have them; only alert on a cold load.
    catch (e: any) { if (!hasCache) Alert.alert('Error', e?.message ?? 'Failed to load'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    (async () => {
      const cached = await readCache<TrustedContact[]>(CACHE_KEY);
      if (cached) { setTrusted(cached); setLoading(false); }
      await load(!!cached);
    })();
  }, [load]);

  const addByVaultId = async () => {
    const id = searchId.trim().toLowerCase().replace('@', '');
    if (!id) return;
    if (trusted.length >= MAX_TRUSTED) { Alert.alert('Maximum reached', `You can have up to ${MAX_TRUSTED} trusted contacts.`); return; }
    setSearching(true);
    try {
      const added = await addTrustedContact(id);
      setTrusted(prev => [...prev, added]);
      setSearchId(''); setAdding(false);
      Alert.alert('Added', `${added.name || id} is now a trusted contact.`);
    } catch (e: any) {
      Alert.alert('Could not add', e?.message ?? 'Try again');
    } finally {
      setSearching(false);
    }
  };

  const removeTrusted = (c: TrustedContact) => {
    Alert.alert('Remove trusted contact?', `Remove ${c.name || 'this contact'} from your emergency contacts?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => {
        const prev = trusted;
        setTrusted(list => list.filter(t => t.userId !== c.userId));
        try { await removeTrustedContact(c.userId); }
        catch (e: any) { setTrusted(prev); Alert.alert('Error', e?.message ?? 'Failed'); }
      } },
    ]);
  };

  return (
    <View style={s.container}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="light-content" />

      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Trusted Contacts</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={s.body}>
        <View style={s.infoCard}>
          <Ionicons name="shield-checkmark" size={26} color={colors.primary} />
          <Text style={s.infoTitle}>Emergency Contacts</Text>
          <Text style={s.infoDesc}>
            These contacts are silently notified with your location if you activate the duress PIN, and when your account is accessed from a new device.
          </Text>
          <Text style={s.infoStat}>{trusted.length}/{MAX_TRUSTED} contacts set</Text>
        </View>

        {loading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 30 }} />
        ) : (
          <FlatList
            data={trusted}
            keyExtractor={t => t.userId}
            renderItem={({ item }) => (
              <View style={s.contactRow}>
                <View style={s.contactAvatar}>
                  <Text style={s.contactAvatarTxt}>{(item.name || '?')[0].toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.contactName}>{item.name || 'Contact'}</Text>
                  <Text style={s.contactId}>@{item.vaultId || '—'}</Text>
                </View>
                <View style={[s.statusDot, { backgroundColor: item.online ? colors.online : colors.textFaint }]} />
                <TouchableOpacity onPress={() => removeTrusted(item)} style={s.removeBtn}>
                  <Text style={s.removeTxt}>Remove</Text>
                </TouchableOpacity>
              </View>
            )}
            ListEmptyComponent={
              <View style={{ alignItems: 'center', paddingVertical: 30 }}>
                <Text style={s.emptyTxt}>No trusted contacts yet</Text>
                <Text style={s.emptySub}>Add up to {MAX_TRUSTED} emergency contacts</Text>
              </View>
            }
          />
        )}

        {!adding && trusted.length < MAX_TRUSTED && (
          <TouchableOpacity style={[s.addBtn, { flexDirection: 'row', justifyContent: 'center', gap: 8 }]} onPress={() => setAdding(true)}>
            <Ionicons name="add" size={18} color={colors.primary} />
            <Text style={s.addBtnTxt}>Add Trusted Contact</Text>
          </TouchableOpacity>
        )}

        {adding && (
          <View style={s.addForm}>
            <Text style={s.addLabel}>Enter their VaultID</Text>
            <View style={s.addRow}>
              <Text style={{ color: colors.textDim, fontSize: 18 }}>@</Text>
              <TextInput
                style={s.addInput}
                value={searchId}
                onChangeText={setSearchId}
                placeholder="vaultid"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoFocus
              />
              <TouchableOpacity style={s.addConfirm} onPress={addByVaultId} disabled={searching}>
                {searching ? <ActivityIndicator color="#FFFFFF" size="small" /> : <Text style={s.addConfirmTxt}>Add</Text>}
              </TouchableOpacity>
            </View>
            <TouchableOpacity onPress={() => { setAdding(false); setSearchId(''); }}>
              <Text style={s.cancelTxt}>Cancel</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={s.alertInfo}>
          <Text style={s.alertTitle}>What trusted contacts receive:</Text>
          <Text style={s.alertItem}>🚨 Duress PIN activation — location + emergency alert</Text>
          <Text style={s.alertItem}>📱 New device login — device info + location</Text>
          <Text style={s.alertItem}>🆘 Panic button — instant location share</Text>
        </View>
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: HEADER_TOP, paddingHorizontal: 16, paddingBottom: 8 },
  backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { color: c.text, fontSize: 18, fontWeight: '700' },
  body: { flex: 1, padding: 16 },
  infoCard: { backgroundColor: c.card, borderRadius: 16, padding: 20, marginBottom: 16, borderWidth: 1, borderColor: c.border, alignItems: 'flex-start' },
  infoTitle: { color: c.text, fontSize: 18, fontWeight: '900', marginTop: 8, marginBottom: 6 },
  infoDesc: { color: c.textDim, fontSize: 13, lineHeight: 20 },
  infoStat: { color: c.primary, fontSize: 13, fontWeight: '700', marginTop: 12 },
  contactRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.card, borderRadius: 14, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: c.border },
  contactAvatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: c.primary, justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  contactAvatarTxt: { color: '#FFFFFF', fontWeight: '900', fontSize: 18 },
  contactName: { color: c.text, fontSize: 15, fontWeight: '700' },
  contactId: { color: c.textDim, fontSize: 12, marginTop: 2 },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 12 },
  removeBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: 'rgba(239,68,68,0.1)', borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)' },
  removeTxt: { color: c.danger, fontSize: 12, fontWeight: '700' },
  addBtn: { backgroundColor: brandAlpha(0.13), borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 12, borderWidth: 1, borderColor: brandAlpha(0.3) },
  addBtnTxt: { color: c.primary, fontSize: 14, fontWeight: '700' },
  addForm: { backgroundColor: c.card, borderRadius: 14, padding: 16, marginTop: 12, borderWidth: 1, borderColor: c.border },
  addLabel: { color: c.textDim, fontSize: 13, marginBottom: 10 },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  addInput: { flex: 1, backgroundColor: c.surface, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, color: c.text, fontSize: 15, borderWidth: 1, borderColor: c.border },
  addConfirm: { backgroundColor: c.primary, borderRadius: 10, paddingHorizontal: 20, paddingVertical: 11 },
  addConfirmTxt: { color: '#FFFFFF', fontWeight: '800' },
  cancelTxt: { color: c.textDim, textAlign: 'center', marginTop: 12 },
  emptyTxt: { color: c.textDim, fontSize: 14 },
  emptySub: { color: c.textFaint, fontSize: 12, marginTop: 4 },
  alertInfo: { marginTop: 20, backgroundColor: c.card, borderRadius: 14, padding: 16, borderWidth: 1, borderColor: c.border },
  alertTitle: { color: c.textDim, fontSize: 12, fontWeight: '700', marginBottom: 10 },
  alertItem: { color: c.textDim, fontSize: 12, lineHeight: 22 },
});
