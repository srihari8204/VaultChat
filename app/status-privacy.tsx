// app/status-privacy.tsx — WhatsApp "Status privacy" (who can see my status).

import { useAuthHeader } from '../hooks/useAuthHeader';
import { HEADER_TOP } from '../constants/layout';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Alert,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';
import { AppText as Text, Avatar, AuroraBackground } from '../components/ui';
import {
  getStatusPrivacy, setStatusPrivacy, listChats, attachmentUrl,
  type StatusPrivacyMode,
} from '../lib/chatService';
import { modeSwitchClearsList, privacyUserIds, selectionAfterModeSwitch } from '../lib/statusPrivacySelection';

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
  const authHeader = useAuthHeader();
  const [loading, setLoading] = useState(true);
  // A failed load must not leave the default "My contacts" on screen as if it
  // were the user's choice: the next tap would PUT it over their real list and
  // could show their status to people they excluded. Nothing is editable until
  // the real setting has loaded.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadTick, setLoadTick] = useState(0);
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const [priv, chats] = await Promise.all([getStatusPrivacy(), listChats()]);
        if (cancel) return;
        setMode(priv.mode); setSelected(new Set(priv.userIds));
        const seen = new Set<string>();
        const c: Contact[] = [];
        for (const ch of chats) {
          if (ch.type === 'direct' && ch.peerUserId && !seen.has(ch.peerUserId)) {
            seen.add(ch.peerUserId);
            c.push({ id: ch.peerUserId, name: ch.peerName || 'crazzychat user', photoURL: ch.peerPhotoURL ?? null });
          }
        }
        setContacts(c);
      } catch (e: any) {
        if (!cancel) setLoadError(e?.message ?? 'Could not load status privacy');
      } finally { if (!cancel) setLoading(false); }
    })();
    return () => { cancel = true; };
  }, [loadTick]);

  // One save at a time, applied optimistically and rolled back on failure, so
  // two quick taps cannot race and leave the server on the older choice.
  const commit = useCallback(async (m: StatusPrivacyMode, ids: Set<string>) => {
    if (saving) return;
    const prevMode = mode, prevSelected = selected;
    setMode(m); setSelected(ids); setSaving(true);
    try { await setStatusPrivacy(m, privacyUserIds(m, ids)); }
    catch (e: any) {
      if (mounted.current) { setMode(prevMode); setSelected(prevSelected); }
      Alert.alert('Could not save', e?.message ?? 'Try again');
    } finally { if (mounted.current) setSaving(false); }
  }, [saving, mode, selected]);

  // Each mode starts from an empty list: the excluded people must never become
  // the only people who can see the status (lib/statusPrivacySelection). The
  // server keeps one list, so leaving a mode that holds people is confirmed.
  const pickMode = (m: StatusPrivacyMode) => {
    if (m === mode) return;
    const go = () => commit(m, selectionAfterModeSwitch(mode, m, selected));
    if (!modeSwitchClearsList(mode, m, selected)) { go(); return; }
    const n = selected.size;
    Alert.alert(
      'Clear your list?',
      `Switching mode clears the ${n} ${n === 1 ? 'person' : 'people'} you ${mode === 'except' ? 'hid your status from' : 'share your status with'}. You will pick again for the new mode.`,
      [{ text: 'Cancel', style: 'cancel' }, { text: 'Switch', style: 'destructive', onPress: go }],
    );
  };
  const toggle = (id: string) => {
    const n = new Set(selected);
    if (n.has(id)) n.delete(id); else n.add(id);
    commit(mode, n);
  };

  return (
    <View style={S.screen}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />
      <View style={S.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} hitSlop={8} style={S.hBtn}><Ionicons name="arrow-back" size={24} color={colors.text} /></TouchableOpacity>
        <Text style={S.hTitle} accessibilityRole="header">Status privacy</Text>
        {saving && (
          <View style={S.savingTag} accessibilityLiveRegion="polite" accessible accessibilityLabel="Saving">
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={S.modeSub}>Saving…</Text>
          </View>
        )}
      </View>

      {loading ? (
        <View style={S.center}><ActivityIndicator color={colors.primary} size="large" /></View>
      ) : loadError ? (
        <View style={[S.center, { paddingHorizontal: 32, gap: 8 }]} accessibilityRole="alert">
          <Text style={S.modeLabel}>Could not load status privacy</Text>
          <Text style={[S.modeSub, { textAlign: 'center' }]}>{loadError}</Text>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Try again" onPress={() => setLoadTick(t => t + 1)} style={S.retryBtn} activeOpacity={0.7}>
            <Text style={S.retryTxt}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={mode === 'contacts' ? [] : contacts}
          keyExtractor={c => c.id}
          ListHeaderComponent={
            <View>
              {MODES.map(m => (
                <TouchableOpacity
                  key={m.key}
                  style={S.modeRow}
                  activeOpacity={0.7}
                  onPress={() => pickMode(m.key)}
                  disabled={saving}
                  accessibilityRole="radio"
                  accessibilityLabel={`${m.label}. ${m.sub}`}
                  accessibilityState={{ selected: mode === m.key, checked: mode === m.key, disabled: saving, busy: saving }}
                >
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
              {mode === 'only' && selected.size === 0 && (
                <Text style={[S.modeSub, { marginHorizontal: 16, marginBottom: 4 }]} accessibilityLiveRegion="polite">
                  Nobody can see your status until you pick people below.
                </Text>
              )}
            </View>
          }
          ListEmptyComponent={mode === 'contacts' ? null : (
            <Text style={[S.modeSub, { marginHorizontal: 16, marginTop: 8 }]}>
              No contacts yet. People you have a direct chat with appear here.
            </Text>
          )}
          renderItem={({ item }) => {
            const on = selected.has(item.id);
            return (
              <TouchableOpacity
                style={S.contactRow}
                activeOpacity={0.7}
                onPress={() => toggle(item.id)}
                disabled={saving}
                accessibilityRole="checkbox"
                accessibilityLabel={item.name}
                accessibilityState={{ checked: on, disabled: saving, busy: saving }}
              >
                <Avatar uri={item.photoURL && authHeader ? attachmentUrl(item.photoURL) : null} headers={authHeader ? { Authorization: authHeader } : undefined} name={item.name} size={44} ring />
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
  screen: { flex: 1, backgroundColor: 'transparent' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingTop: HEADER_TOP, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  hBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  hTitle: { color: c.text, fontSize: 18, fontWeight: '700' },
  savingTag: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 6 },
  modeRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 14, paddingVertical: 14, borderRadius: 16, backgroundColor: c.glass, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  modeLabel: { color: c.text, fontSize: 16, fontWeight: '600' },
  modeSub: { color: c.textDim, fontSize: 13, marginTop: 2 },
  sectionLabel: { color: c.textDim, fontSize: 12, fontWeight: '700', letterSpacing: 1, marginHorizontal: 16, marginTop: 12, marginBottom: 4 },
  contactRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 16, backgroundColor: c.glass, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  contactName: { flex: 1, color: c.text, fontSize: 16, fontWeight: '500' },
  retryBtn: { marginTop: 4, minHeight: 44, paddingHorizontal: 18, justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: c.glassStroke, backgroundColor: c.glassSoft },
  retryTxt: { color: c.primary, fontWeight: '700' },
});
