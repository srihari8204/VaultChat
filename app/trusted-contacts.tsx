// app/trusted-contacts.tsx — Trusted (emergency) Contacts (Postgres-backed).
//
// Up to 3 contacts alerted when the user sends an Emergency SOS. (No backend
// sends new-device login alerts — only POST /user/sos reads trusted_contacts —
// so the screen must not promise them.)
// Backed by /contacts/trusted (list/add-by-VaultID/remove). No Firestore.

import { HEADER_TOP } from '../constants/layout';
import { brandAlpha, type Palette } from '../constants/theme';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, FlatList, Alert, ActivityIndicator, TextInput } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { userErrorText } from '../lib/userErrorText';
import { tint } from '../lib/tintColor';
import { readCache, writeCache } from '../lib/localCache';
import { listTrustedContacts, addTrustedContact, removeTrustedContact, type TrustedContact } from '../lib/chatService';
import { AuroraBackground, KeyboardSafe } from '../components/ui';
import { initialOf } from '../lib/format';
import { isVaultId } from '../lib/vaultIdLink';

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
  const trustedRef = useRef(trusted);
  trustedRef.current = trusted;
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [searchId, setSearchId] = useState('');
  const [searching, setSearching] = useState(false);
  /** Inline feedback for a malformed VaultID, before any network call. */
  const [idError, setIdError] = useState<string | null>(null);
  /** A cold load failed: render that, not "No trusted contacts yet". */
  const [loadFailed, setLoadFailed] = useState(false);
  /** The cached list painted, but the refresh failed: it may be out of date. */
  const [stale, setStale] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const load = useCallback(async (hasCache: boolean) => {
    try {
      const list = await listTrustedContacts();
      writeCache(CACHE_KEY, list);
      if (!mounted.current) return;
      setTrusted(list);
      setLoadFailed(false);
      setStale(false);
    }
    // Keep cached contacts if we have them (and say they may be stale); a cold
    // load failure gets the error face.
    catch { if (mounted.current) { if (hasCache) setStale(true); else setLoadFailed(true); } }
    finally { if (mounted.current) setLoading(false); }
  }, []);
  const retry = () => { setLoading(true); load(false); };
  const [refreshing, setRefreshing] = useState(false);
  const retryStale = () => { setRefreshing(true); load(true).finally(() => { if (mounted.current) setRefreshing(false); }); };

  useEffect(() => {
    (async () => {
      const cached = await readCache<TrustedContact[]>(CACHE_KEY);
      if (cached && mounted.current) { setTrusted(cached); setLoading(false); }
      await load(!!cached);
    })();
  }, [load]);

  /** An add is in flight. A ref, not `searching`: the keyboard's submit can
   *  fire again before the disabled Add button re-renders. */
  const addInFlight = useRef(false);
  const addByVaultId = async () => {
    if (addInFlight.current) return;
    const id = searchId.trim().toLowerCase().replace(/@/g, '');
    if (!id) return;
    if (!isVaultId(id)) { setIdError('A VaultID is 3–64 letters, digits, dots, dashes or underscores.'); return; }
    if (trusted.length >= MAX_TRUSTED) { Alert.alert('Maximum reached', `You can have up to ${MAX_TRUSTED} trusted contacts.`); return; }
    addInFlight.current = true;
    setSearching(true);
    try {
      const added = await addTrustedContact(id);
      if (!mounted.current) return;
      // The cache is what a cold reopen paints first; keep it in step.
      setTrusted(prev => { const next = [...prev, added]; writeCache(CACHE_KEY, next); return next; });
      setSearchId(''); setAdding(false);
      Alert.alert('Added', `${added.name || id} is now a trusted contact.`);
    } catch (e: unknown) {
      if (mounted.current) Alert.alert('Could not add', userErrorText(e, 'Try again'));
    } finally {
      addInFlight.current = false;
      if (mounted.current) setSearching(false);
    }
  };

  const removeTrusted = (c: TrustedContact) => {
    Alert.alert('Remove trusted contact?', `Remove ${c.name || 'this contact'} from your emergency contacts?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => {
        // Functional updates on the CURRENT list: two overlapping removals
        // used to roll back to a stale copy and resurrect the other contact.
        const at = trusted.findIndex(t => t.userId === c.userId);
        setTrusted(cur => cur.filter(t => t.userId !== c.userId));
        try { await removeTrustedContact(c.userId); writeCache(CACHE_KEY, trustedRef.current.filter(t => t.userId !== c.userId)); }
        catch (e: unknown) {
          const restore = (cur: TrustedContact[]) => (cur.some(t => t.userId === c.userId) ? cur
            : [...cur.slice(0, Math.max(0, at)), c, ...cur.slice(Math.max(0, at))]);
          // An overlapping removal that succeeded wrote the cache without this
          // contact; put it back there too, even if the screen has closed.
          writeCache(CACHE_KEY, restore(trustedRef.current));
          if (!mounted.current) return;
          setTrusted(restore);
          Alert.alert('Could not remove', userErrorText(e, 'Try again'));
        }
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

      {/* KeyboardSafe: the autoFocus VaultID field sits low on a non-scrolling
          screen, and edge-to-edge Android never resizes the window for the
          keyboard; the list shrinks so the form stays above it. Its computed
          paddingBottom would replace a padding set on it, so the 16pt body
          padding sits on an inner View and the inset adds below it. */}
      <KeyboardSafe>
        <View style={s.body}>
          {/* While adding, the two fixed cards step aside: on a small phone they
              could push the form under the keyboard (only the list shrinks). */}
          {!adding && (
            <View style={s.infoCard}>
              <Ionicons name="shield-checkmark" size={26} color={colors.primary} />
              <Text style={s.infoTitle}>Emergency Contacts</Text>
              <Text style={s.infoDesc}>
                When you send an Emergency SOS, these contacts get a push alert with a link to your location (when your phone can get one).
              </Text>
              <Text style={s.infoStat}>{trusted.length}/{MAX_TRUSTED} contacts set</Text>
            </View>
          )}

          {stale && !loading && (
            <View style={s.staleRow} accessibilityLiveRegion="polite">
              <Text style={[s.emptySub, { flex: 1, marginTop: 0 }]}>
                Couldn&apos;t refresh. Showing the list saved on this phone, which may be out of date.
              </Text>
              {refreshing
                ? <ActivityIndicator size="small" color={colors.primary} accessibilityLabel="Refreshing trusted contacts" />
                : (
                  <TouchableOpacity onPress={retryStale} accessibilityRole="button" accessibilityLabel="Retry refreshing trusted contacts" hitSlop={12}>
                    <Text style={s.addBtnTxt}>Retry</Text>
                  </TouchableOpacity>
                )}
            </View>
          )}

          {loading ? (
            <ActivityIndicator color={colors.primary} style={{ marginTop: 30 }} />
          ) : (
            <FlatList
              data={trusted}
              keyExtractor={t => t.userId}
              renderItem={({ item }) => (
                <View style={s.contactRow}>
                  {/* One element: the status dot used to read "Online" on its own. */}
                  <View style={s.contactInfo} accessible
                    accessibilityLabel={`${item.name || 'Contact'}, ${item.vaultId ? `@${item.vaultId}` : 'no VaultID'}, ${item.online ? 'online' : 'offline'}`}>
                    <View style={s.contactAvatar}>
                      <Text style={s.contactAvatarTxt}>{initialOf(item.name)}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text numberOfLines={1} style={s.contactName}>{item.name || 'Contact'}</Text>
                      <Text style={s.contactId}>@{item.vaultId || '—'}</Text>
                    </View>
                    <View style={[s.statusDot, { backgroundColor: item.online ? colors.online : colors.textFaint }]} />
                  </View>
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
                  {searching ? <ActivityIndicator color={colors.onPrimary} size="small" /> : <Text style={s.addConfirmTxt}>Add</Text>}
                </TouchableOpacity>
              </View>
              {idError && <Text style={s.idError} accessibilityLiveRegion="polite">{idError}</Text>}
              <TouchableOpacity onPress={() => { setAdding(false); setSearchId(''); setIdError(null); }}
                accessibilityRole="button" hitSlop={12}>
                <Text style={s.cancelTxt}>Cancel</Text>
              </TouchableOpacity>
            </View>
          )}

          {!adding && (
            <View style={s.alertInfo}>
              <Text style={s.alertTitle}>What trusted contacts receive:</Text>
              <View style={s.alertRow}>
                <Ionicons name="alert-circle" size={14} color={colors.danger} accessibilityElementsHidden importantForAccessibility="no" />
                <Text style={s.alertItem}>Emergency SOS — a push alert with a map link to where you are</Text>
              </View>
              <View style={s.alertRow}>
                <Ionicons name="flask-outline" size={14} color={colors.textDim} accessibilityElementsHidden importantForAccessibility="no" />
                <Text style={s.alertItem}>Test SOS — the same alert, clearly marked as a test</Text>
              </View>
            </View>
          )}
        </View>
      </KeyboardSafe>
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
  contactInfo: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  contactRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.glassSoft, borderRadius: 14, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: c.glassStroke },
  contactAvatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: c.primary, justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  contactAvatarTxt: { color: c.onPrimary, fontWeight: '900', fontSize: 18 },
  contactName: { color: c.text, fontSize: 15, fontWeight: '700' },
  contactId: { color: c.textDim, fontSize: 12, marginTop: 2 },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 12 },
  removeBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: tint(c.danger, 0.1), borderWidth: 1, borderColor: tint(c.danger, 0.3) },
  removeTxt: { color: c.danger, fontSize: 12, fontWeight: '700' },
  addBtn: { backgroundColor: brandAlpha(0.13), borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 12, borderWidth: 1, borderColor: brandAlpha(0.3) },
  addBtnTxt: { color: c.primary, fontSize: 14, fontWeight: '700' },
  addForm: { backgroundColor: c.glassSoft, borderRadius: 14, padding: 16, marginTop: 12, borderWidth: 1, borderColor: c.glassStroke },
  addLabel: { color: c.textDim, fontSize: 13, marginBottom: 10 },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  addInput: { flex: 1, minHeight: 44, backgroundColor: c.glassSoft, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, color: c.text, fontSize: 15, borderWidth: 1, borderColor: c.glassStroke },
  addConfirm: { minHeight: 44, justifyContent: 'center', backgroundColor: c.primary, borderRadius: 10, paddingHorizontal: 20, paddingVertical: 11 },
  addConfirmTxt: { color: c.onPrimary, fontWeight: '800' },
  cancelTxt: { color: c.textDim, textAlign: 'center', marginTop: 12 },
  idError: { color: c.danger, fontSize: 12.5, marginTop: 8 },
  emptyTxt: { color: c.textDim, fontSize: 14 },
  emptySub: { color: c.textFaint, fontSize: 12, marginTop: 4 },
  alertInfo: { marginTop: 20, backgroundColor: c.glassSoft, borderRadius: 14, padding: 16, borderWidth: 1, borderColor: c.glassStroke },
  alertTitle: { color: c.textDim, fontSize: 12, fontWeight: '700', marginBottom: 10 },
  alertRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  alertItem: { color: c.textDim, fontSize: 12, lineHeight: 22, flex: 1 },
  staleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
});
