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
import { api } from '../lib/api';
import { parseAudienceBase, pickerPeople, type AudiencePerson } from '../lib/statusAudienceBase';
import { userErrorText } from '../lib/userErrorText';

type Contact = AudiencePerson;
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
  // The contact list is only for picking people. If it fails, the saved mode
  // still loads and stays editable; the list says it could not load.
  const [contactsError, setContactsError] = useState<string | null>(null);
  const [contactsTick, setContactsTick] = useState(0);
  // True once the server listed everyone the status reaches, groups included
  // (lib/statusAudienceBase); false on today's server, which lists only what
  // the direct chats give.
  const [fullList, setFullList] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  // What the server last accepted, and the newest state waiting to be saved.
  const saved = useRef<{ mode: StatusPrivacyMode; ids: Set<string> }>({ mode: 'contacts', ids: new Set() });
  const wanted = useRef<{ mode: StatusPrivacyMode; ids: Set<string> } | null>(null);
  const flushing = useRef(false);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setLoadError(null);
    getStatusPrivacy()
      .then((priv) => {
        if (cancel) return;
        setMode(priv.mode); setSelected(new Set(priv.userIds));
        saved.current = { mode: priv.mode, ids: new Set(priv.userIds) };
      })
      .catch((e: unknown) => { if (!cancel) setLoadError(userErrorText(e, 'Try again.')); })
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [loadTick]);

  useEffect(() => {
    let cancel = false;
    setContactsError(null);
    // The server's own list (?base=1) is optional: any failure, or today's
    // server that does not send it, keeps the direct-chat list.
    const base = api<unknown>('/stories/audience?base=1').then(parseAudienceBase, () => null);
    Promise.all([listChats(), base])
      .then(([chats, people]) => {
        if (cancel) return;
        const c: Contact[] = [];
        for (const ch of chats) {
          if (ch.type === 'direct' && ch.peerUserId) {
            c.push({ id: ch.peerUserId, name: ch.peerName || 'crazzychat user', photoURL: ch.peerPhotoURL ?? null });
          }
        }
        setContacts(pickerPeople(people, c));
        setFullList(people !== null);
      })
      .catch((e: unknown) => { if (!cancel) setContactsError(userErrorText(e, 'Try again.')); });
    return () => { cancel = true; };
  }, [loadTick, contactsTick]);

  // Saves run one at a time and the latest wanted state wins: ticking several
  // people while a save is in flight queues ONE more save with all of them,
  // instead of a PUT per tap or locking every row. A failure puts the screen
  // back to what the server last accepted.
  const flush = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    setSaving(true);
    try {
      while (wanted.current) {
        const w = wanted.current;
        wanted.current = null;
        try {
          await setStatusPrivacy(w.mode, privacyUserIds(w.mode, w.ids));
          saved.current = w;
        } catch (e: unknown) {
          wanted.current = null;
          if (mounted.current) {
            setMode(saved.current.mode); setSelected(new Set(saved.current.ids));
            Alert.alert('Could not save', userErrorText(e, 'Try again.'));
          }
        }
      }
    } finally {
      flushing.current = false;
      if (mounted.current) setSaving(false);
    }
  }, []);
  const commit = useCallback((m: StatusPrivacyMode, ids: Set<string>) => {
    setMode(m); setSelected(ids);
    wanted.current = { mode: m, ids };
    flush();
  }, [flush]);

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
    // Builds on the newest wanted list, so a tap before the last one rendered
    // is not lost.
    const n = new Set(wanted.current?.ids ?? selected);
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
              {/* The server's "contacts" is everyone sharing an active chat, groups
                  included (backend stories.go audienceIDs). Until the server sends
                  that list (?base=1), this one only has direct-chat peers, so say
                  what that means for the rest. */}
              {mode !== 'contacts' && !fullList && (
                <Text style={S.listNote}>
                  Only people you have a direct chat with are listed. People you share only a group with
                  {mode === 'except' ? ' cannot be excluded here and still see your status.' : ' cannot be picked here, so they do not see it.'}
                </Text>
              )}
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
          ListEmptyComponent={mode === 'contacts' ? null : contactsError ? (
            <View style={{ marginHorizontal: 16, marginTop: 8, gap: 8 }} accessibilityRole="alert">
              <Text style={S.modeSub}>Your contacts could not be loaded, so nobody can be picked right now. {contactsError}</Text>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Try loading contacts again" onPress={() => setContactsTick(t => t + 1)} style={[S.retryBtn, { alignSelf: 'flex-start' }]} activeOpacity={0.7}>
                <Text style={S.retryTxt}>Try again</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <Text style={[S.modeSub, { marginHorizontal: 16, marginTop: 8 }]}>
              {fullList ? 'No contacts yet. People you share a chat with appear here.' : 'No contacts yet. People you have a direct chat with appear here.'}
            </Text>
          )}
          renderItem={({ item }) => {
            const on = selected.has(item.id);
            return (
              <TouchableOpacity
                style={S.contactRow}
                activeOpacity={0.7}
                onPress={() => toggle(item.id)}
                accessibilityRole="checkbox"
                accessibilityLabel={item.name}
                accessibilityState={{ checked: on }}
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
  hBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  hTitle: { color: c.text, fontSize: 18, fontWeight: '700' },
  savingTag: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 6 },
  modeRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 14, paddingVertical: 14, borderRadius: 16, backgroundColor: c.glass, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  modeLabel: { color: c.text, fontSize: 16, fontWeight: '600' },
  modeSub: { color: c.textDim, fontSize: 13, marginTop: 2 },
  listNote: { color: c.textDim, fontSize: 13, marginHorizontal: 16, marginTop: 4 },
  sectionLabel: { color: c.textDim, fontSize: 12, fontWeight: '700', letterSpacing: 1, marginHorizontal: 16, marginTop: 12, marginBottom: 4 },
  contactRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 16, backgroundColor: c.glass, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  contactName: { flex: 1, color: c.text, fontSize: 16, fontWeight: '500' },
  retryBtn: { marginTop: 4, minHeight: 44, paddingHorizontal: 18, justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: c.glassStroke, backgroundColor: c.glassSoft },
  retryTxt: { color: c.primary, fontWeight: '700' },
});
