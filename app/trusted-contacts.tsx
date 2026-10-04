// app/trusted-contacts.tsx — Trusted (emergency) Contacts (Postgres-backed).
//
// Up to 3 contacts alerted when the user sends an Emergency SOS. (No backend
// sends new-device login alerts — only POST /user/sos reads trusted_contacts —
// so the screen must not promise them.)
// Backed by /contacts/trusted (list/add-by-VaultID/remove). No Firestore.

import { HEADER_TOP } from '../constants/layout';
import { brandAlpha, type Palette } from '../constants/theme';
import React, { useState, useEffect, useCallback , useMemo} from 'react';
import { View, Text, TouchableOpacity, StyleSheet, FlatList, Alert, ActivityIndicator, TextInput } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { readCache, writeCache } from '../lib/localCache';
import { listTrustedContacts, addTrustedContact, removeTrustedContact, type TrustedContact } from '../lib/chatService';
import { AuroraBackground } from '../components/ui';
import { initialOf } from '../lib/format';
import { isVaultId } from '../lib/vaultIdLink';

const MAX_TRUSTED = 3;
const CACHE_KEY = 'trusted-contacts';
const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message) || fallback;

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
  /** Inline feedback for a malformed VaultID, before any network call. */
  const [idError, setIdError] = useState<string | null>(null);
  /** A cold load failed: render that, not "No trusted contacts yet". */
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async (hasCache: boolean) => {
    try {
      const list = await listTrustedContacts();
      setTrusted(list);
      setLoadFailed(false);
      writeCache(CACHE_KEY, list);
    }
    // Keep cached contacts if we have them; only flag a cold load.
    catch { if (!hasCache) setLoadFailed(true); }
    finally { setLoading(false); }
  }, []);
  const retry = () => { setLoading(true); load(false); };

  useEffect(() => {
    (async () => {
      const cached = await readCache<TrustedContact[]>(CACHE_KEY);
      if (cached) { setTrusted(cached); setLoading(false); }
      await load(!!cached);
    })();
  }, [load]);

  const addByVaultId = async () => {
    const id = searchId.trim().toLowerCase().replace(/@/g, '');
    if (!id) return;
    if (!isVaultId(id)) { setIdError('A VaultID is 3–64 letters, digits, dots, dashes or underscores.'); return; }
    if (trusted.length >= MAX_TRUSTED) { Alert.alert('Maximum reached', `You can have up to ${MAX_TRUSTED} trusted contacts.`); return; }
    setSearching(true);
    try {
      const added = await addTrustedContact(id);
      // The cache is what a cold reopen paints first; keep it in step.
      setTrusted(prev => { const next = [...prev, added]; writeCache(CACHE_KEY, next); return next; });
      setSearchId(''); setAdding(false);
      Alert.alert('Added', `${added.name || id} is now a trusted contact.`);
    } catch (e: unknown) {
      Alert.alert('Could not add', errText(e, 'Try again'));
    } finally {
      setSearching(false);
    }
  };

  const removeTrusted = (c: TrustedContact) => {
    Alert.alert('Remove trusted contact?', `Remove ${c.name || 'this contact'} from your emergency contacts?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => {
        const prev = trusted;
        const next = trusted.filter(t => t.userId !== c.userId);
        setTrusted(next);
        try { await removeTrustedContact(c.userId); writeCache(CACHE_KEY, next); }
        catch (e: unknown) { setTrusted(prev); Alert.alert('Could not remove', errText(e, 'Try again')); }
      } },
    ]);
  };

  return (
    <View style={s.container}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />

      <View style={s.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={s.backBtn} hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle} accessibilityRole="header">Trusted Contacts</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={s.body}>
        <View style={s.infoCard}>
          <Ionicons name="shield-checkmark" size={26} color={colors.primary} />
          <Text style={s.infoTitle}>Emergency Contacts</Text>
          <Text style={s.infoDesc}>
            When you send an Emergency SOS, these contacts get a push alert with a link to your location (when your phone can get one).
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
                  <Text style={s.contactAvatarTxt}>{initialOf(item.name)}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={s.contactName}>{item.name || 'Contact'}</Text>
                  <Text style={s.contactId}>@{item.vaultId || '—'}</Text>
                </View>
                <View
                  style={[s.statusDot, { backgroundColor: item.online ? colors.online : colors.textFaint }]}
                  accessible accessibilityLabel={item.online ? 'Online' : 'Offline'}
                />
                <TouchableOpacity onPress={() => removeTrusted(item)} style={s.removeBtn} hitSlop={10}
                  accessibilityRole="button" accessibilityLabel={`Remove ${item.name || 'contact'}`}>
                  <Text style={s.removeTxt}>Remove</Text>
                </TouchableOpacity>
              </View>
            )}
            ListEmptyComponent={loadFailed ? (
              <View style={{ alignItems: 'center', paddingVertical: 30, gap: 10 }}>
                <Text style={s.emptyTxt}>Couldn&apos;t load your trusted contacts.</Text>
                <TouchableOpacity onPress={retry} accessibilityRole="button" accessibilityLabel="Retry loading trusted contacts" hitSlop={12}>
                  <Text style={s.addBtnTxt}>Retry</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={{ alignItems: 'center', paddingVertical: 30 }}>
                <Text style={s.emptyTxt}>No trusted contacts yet</Text>
                <Text style={s.emptySub}>Add up to {MAX_TRUSTED} emergency contacts</Text>
              </View>
            )}
          />
        )}

        {!adding && !loading && !loadFailed && trusted.length < MAX_TRUSTED && (
          <TouchableOpacity style={[s.addBtn, { flexDirection: 'row', justifyContent: 'center', gap: 8 }]} onPress={() => setAdding(true)} accessibilityRole="button">
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
                onChangeText={(t) => { setSearchId(t); setIdError(null); }}
                onSubmitEditing={addByVaultId}
                accessibilityLabel="Their VaultID"
                placeholder="vaultid"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoFocus
              />
              <TouchableOpacity style={s.addConfirm} onPress={addByVaultId} disabled={searching}
                accessibilityRole="button" accessibilityLabel="Add trusted contact" accessibilityState={{ busy: searching }}>
                {searching ? <ActivityIndicator color="#FFFFFF" size="small" /> : <Text style={s.addConfirmTxt}>Add</Text>}
              </TouchableOpacity>
            </View>
            {idError && <Text style={s.idError} accessibilityLiveRegion="polite">{idError}</Text>}
            <TouchableOpacity onPress={() => { setAdding(false); setSearchId(''); setIdError(null); }}
              accessibilityRole="button" hitSlop={12}>
              <Text style={s.cancelTxt}>Cancel</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={s.alertInfo}>
          <Text style={s.alertTitle}>What trusted contacts receive:</Text>
          <Text style={s.alertItem}>🆘 Emergency SOS — a push alert with a map link to where you are</Text>
          <Text style={s.alertItem}>🧪 Test SOS — the same alert, clearly marked as a test</Text>
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
  infoCard: { backgroundColor: c.glassSoft, borderRadius: 16, padding: 20, marginBottom: 16, borderWidth: 1, borderColor: c.glassStroke, alignItems: 'flex-start' },
  infoTitle: { color: c.text, fontSize: 18, fontWeight: '900', marginTop: 8, marginBottom: 6 },
  infoDesc: { color: c.textDim, fontSize: 13, lineHeight: 20 },
  infoStat: { color: c.primary, fontSize: 13, fontWeight: '700', marginTop: 12 },
  contactRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.glassSoft, borderRadius: 14, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: c.glassStroke },
  contactAvatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: c.primary, justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  contactAvatarTxt: { color: '#FFFFFF', fontWeight: '900', fontSize: 18 },
  contactName: { color: c.text, fontSize: 15, fontWeight: '700' },
  contactId: { color: c.textDim, fontSize: 12, marginTop: 2 },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 12 },
  removeBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: c.danger + '1A', borderWidth: 1, borderColor: c.danger + '4D' },
  removeTxt: { color: c.danger, fontSize: 12, fontWeight: '700' },
  addBtn: { backgroundColor: brandAlpha(0.13), borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 12, borderWidth: 1, borderColor: brandAlpha(0.3) },
  addBtnTxt: { color: c.primary, fontSize: 14, fontWeight: '700' },
  addForm: { backgroundColor: c.glassSoft, borderRadius: 14, padding: 16, marginTop: 12, borderWidth: 1, borderColor: c.glassStroke },
  addLabel: { color: c.textDim, fontSize: 13, marginBottom: 10 },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  addInput: { flex: 1, backgroundColor: c.glassSoft, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, color: c.text, fontSize: 15, borderWidth: 1, borderColor: c.glassStroke },
  addConfirm: { backgroundColor: c.primary, borderRadius: 10, paddingHorizontal: 20, paddingVertical: 11 },
  addConfirmTxt: { color: '#FFFFFF', fontWeight: '800' },
  cancelTxt: { color: c.textDim, textAlign: 'center', marginTop: 12 },
  idError: { color: c.danger, fontSize: 12.5, marginTop: 8 },
  emptyTxt: { color: c.textDim, fontSize: 14 },
  emptySub: { color: c.textFaint, fontSize: 12, marginTop: 4 },
  alertInfo: { marginTop: 20, backgroundColor: c.glassSoft, borderRadius: 14, padding: 16, borderWidth: 1, borderColor: c.glassStroke },
  alertTitle: { color: c.textDim, fontSize: 12, fontWeight: '700', marginBottom: 10 },
  alertItem: { color: c.textDim, fontSize: 12, lineHeight: 22 },
});
