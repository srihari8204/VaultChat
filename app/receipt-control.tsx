// app/receipt-control.tsx — Per-Contact Privacy (read receipts / typing / last seen).
//
// Postgres-backed via the Ghost Mode API (/user/ghost-mode). Each per-contact
// rule maps to a ghost_mode row:
//   show read receipts ↔ !hideRead
//   show typing         ↔ !hideTyping
//   show last seen      ↔ !hideLastSeen
// Contacts are the people you already have a direct chat with (GET /chats).
// Defaults to "everything visible" when no rule exists for a contact.

import { HEADER_TOP } from '../constants/layout';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View, TouchableOpacity, StyleSheet, FlatList, ActivityIndicator, TextInput, RefreshControl,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { type Palette, brandAlpha } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { listChats, listGhostMode, setGhostMode, type GhostMode } from '../lib/chatService';
import { AppText as Text, AuroraBackground } from '../components/ui';
import { initialOf } from '../lib/format';
import { tint } from '../lib/tintColor';
import { userErrorText } from '../lib/userErrorText';

interface Contact { userId: string; name: string }
type Field = 'read' | 'typing' | 'lastSeen';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

// role=switch, not button: this is a two-state control, and a screen reader
// should be able to say whether it is on without the user toggling it to
// find out. The label names the setting; accessibilityState carries state.
// Styles and colours come from the screen: one StyleSheet per screen, not
// one per toggle (three per row).
// "Shown" state for a contact (defaults to all visible when no rule exists).
const shownFor = (g: GhostMode | undefined) => ({
  read: !(g?.hideRead),
  typing: !(g?.hideTyping),
  lastSeen: !(g?.hideLastSeen),
});

function Toggle({ on, icon, onPress, label, s, colors }: {
  on: boolean; icon: React.ComponentProps<typeof Ionicons>['name']; onPress: () => void; label: string;
  s: ReturnType<typeof makeStyles>; colors: Palette;
}) {
  return (
    <TouchableOpacity
      style={[s.toggleBtn, on && s.toggleBtnOn]}
      onPress={onPress}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: on }}
    >
      <Ionicons name={icon} size={18} color={on ? colors.primary : colors.textFaint} />
    </TouchableOpacity>
  );
}

export default function ReceiptControlScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [rules, setRules] = useState<Record<string, GhostMode>>({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Pull-to-refresh reloads under the list instead of swapping it for a spinner.
  const [refreshing, setRefreshing] = useState(false);
  const pulling = useRef(false);

  // The latest rules, updated synchronously on every patch, so a second tap
  // before the re-render toggles from the value the first tap set, not a stale one.
  const rulesRef = useRef(rules);
  // One request at a time per contact+flag, so responses cannot land out of
  // order and leave the server on a different value than the screen.
  const chains = useRef<Record<string, Promise<void>>>({});
  // Toggles whose request has not settled. A reload must not replace rulesRef
  // under them: their rollback would then apply to the reloaded rules.
  const inFlight = useRef(0);

  const onRefresh = useCallback(async () => {
    pulling.current = true;
    setRefreshing(true);
    await Promise.all(Object.values(chains.current));   // chains never reject
    setReloadKey(k => k + 1);
  }, []);

  useEffect(() => {
    let active = true;
    if (!pulling.current) setLoading(true);
    (async () => {
      try {
        const [chats, ghost] = await Promise.all([listChats(), listGhostMode()]);
        const seen = new Map<string, Contact>();
        for (const c of chats) {
          if (c.type === 'direct' && c.peerUserId && !seen.has(c.peerUserId)) {
            seen.set(c.peerUserId, { userId: c.peerUserId, name: c.peerName || c.name || 'User' });
          }
        }
        const rmap: Record<string, GhostMode> = {};
        for (const g of ghost) rmap[g.targetId] = g;
        if (active) {
          setContacts(Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name)));
          // A toggle tapped while this load was out keeps the screen's rules.
          if (inFlight.current === 0) { setRules(rmap); rulesRef.current = rmap; }
          setLoadFailed(false);
          setError(null);
        }
      } catch (e: any) {
        if (active) { setError(userErrorText(e, 'Your contacts could not be loaded.')); setLoadFailed(true); }
      } finally {
        pulling.current = false;
        if (active) { setLoading(false); setRefreshing(false); }
      }
    })();
    return () => { active = false; };
  }, [reloadKey]);

  const toggleRule = useCallback((userId: string, field: Field) => {
    const nextShown = !shownFor(rulesRef.current[userId])[field];   // user is toggling visibility
    const hideKey = field === 'read' ? 'hideRead' : field === 'typing' ? 'hideTyping' : 'hideLastSeen';
    // Optimistic patch of this ONE flag. The rollback below restores only this
    // flag too: restoring a whole snapshot also reverted any other toggle the
    // user changed while this request was in flight.
    const patchFlag = (hidden: boolean) => {
      const r = rulesRef.current;
      const base = r[userId] ?? {
        targetId: userId, hideOnline: false, hideTyping: false, hideRead: false, hideLastSeen: false,
      };
      rulesRef.current = { ...r, [userId]: { ...base, [hideKey]: hidden } };
      setRules(rulesRef.current);
    };
    patchFlag(!nextShown);
    const k = `${userId}:${hideKey}`;
    inFlight.current++;
    chains.current[k] = (chains.current[k] ?? Promise.resolve()).then(async () => {
      try {
        await setGhostMode(userId, { [hideKey]: !nextShown } as Partial<Record<typeof hideKey, boolean>>);
        setError(null);
      } catch (e: any) {
        // Roll back only if no later tap has changed this flag since.
        if (!!rulesRef.current[userId]?.[hideKey] === !nextShown) patchFlag(nextShown);
        setError(userErrorText(e, 'That setting could not be changed. Try again.'));
      } finally {
        inFlight.current--;
      }
    });
  }, []);

  const renderItem = useCallback(({ item }: { item: Contact }) => {
    const r = shownFor(rules[item.userId]);
    return (
      <View style={s.contactRow}>
        <View style={s.avatar}><Text style={s.avatarTxt}>{initialOf(item.name, '#')}</Text></View>
        <Text style={s.contactName} numberOfLines={1}>{item.name}</Text>
        <View style={s.toggleGroup}>
          <Toggle s={s} colors={colors} label={`Read receipts for ${item.name}`} on={r.read} icon="checkmark-done" onPress={() => toggleRule(item.userId, 'read')} />
          <Toggle s={s} colors={colors} label={`Typing indicator for ${item.name}`} on={r.typing} icon="create-outline" onPress={() => toggleRule(item.userId, 'typing')} />
          <Toggle s={s} colors={colors} label={`Last seen for ${item.name}`} on={r.lastSeen} icon="time-outline" onPress={() => toggleRule(item.userId, 'lastSeen')} />
        </View>
      </View>
    );
  }, [s, colors, rules, toggleRule]);

  const filtered = useMemo(
    () => contacts.filter(c => !search || c.name.toLowerCase().includes(search.toLowerCase())),
    [contacts, search],
  );

  return (
    <View style={s.container}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />

      <View style={s.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={s.backBtn} hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle} accessibilityRole="header">Privacy per Contact</Text>
        <View style={{ width: 44 }} />
      </View>

      <View style={s.body}>
        <View style={s.infoCard}>
          <Ionicons name="lock-closed" size={22} color={colors.primary} />
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={s.infoTitle}>Per-Contact Privacy</Text>
            <Text style={s.infoDesc}>Control who sees your read receipts, typing indicator, and last seen — individually per contact.</Text>
          </View>
        </View>

        <TextInput
          style={s.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Search contacts…"
          placeholderTextColor={colors.textFaint}
          accessibilityLabel="Search contacts"
        />

        <View style={s.legendRow}>
          <View style={s.legendItem}><Ionicons name="checkmark-done" size={14} color={colors.textDim} /><Text style={s.legendTxt}>Read</Text></View>
          <View style={s.legendItem}><Ionicons name="create-outline" size={14} color={colors.textDim} /><Text style={s.legendTxt}>Typing</Text></View>
          <View style={s.legendItem}><Ionicons name="time-outline" size={14} color={colors.textDim} /><Text style={s.legendTxt}>Last Seen</Text></View>
        </View>

        {error && (
          <View style={s.errorBar}>
            <Text style={s.errorTxt} accessibilityRole="alert">{error}</Text>
            {loadFailed && (
              <TouchableOpacity accessibilityRole="button" onPress={() => setReloadKey(k => k + 1)} style={s.retryBtn}>
                <Text style={s.retryTxt}>Try again</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {loading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 30 }} />
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={c => c.userId}
            refreshControl={<RefreshControl tintColor={colors.primary} refreshing={refreshing} onRefresh={onRefresh} />}
            renderItem={renderItem}
            ListEmptyComponent={loadFailed ? null : (
              <View style={{ alignItems: 'center', padding: 40 }}>
                <Text style={s.emptyTxt}>{contacts.length === 0 ? 'No contacts yet — start a direct chat first.' : 'No contacts found'}</Text>
              </View>
            )}
          />
        )}
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: HEADER_TOP, paddingHorizontal: 16, paddingBottom: 8 },
  backBtn: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { color: c.text, fontSize: 18, fontWeight: '700' },
  body: { flex: 1, padding: 16 },
  infoCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.glass, borderRadius: 14, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: c.glassStroke },
  infoTitle: { color: c.text, fontSize: 16, fontWeight: '800' },
  infoDesc: { color: c.textDim, fontSize: 12, marginTop: 2, lineHeight: 18 },
  searchInput: { backgroundColor: c.glass, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, color: c.text, fontSize: 14, marginBottom: 8, borderWidth: 1, borderColor: c.glassStroke },
  legendRow: { flexDirection: 'row', gap: 16, marginBottom: 10, paddingLeft: 4 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendTxt: { color: c.textDim, fontSize: 10 },
  errorBar: { backgroundColor: tint(c.danger, 0.12), borderColor: tint(c.danger, 0.4), borderWidth: 1, padding: 10, borderRadius: 10, marginBottom: 8 },
  errorTxt: { color: c.danger, fontSize: 12 },
  retryBtn: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingHorizontal: 4, marginTop: 4 },
  retryTxt: { color: c.primary, fontSize: 14, fontWeight: '700' },
  contactRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.glass, borderRadius: 14, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: c.glassStroke, gap: 12 },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: c.surfaceSolid, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: c.glassStroke },
  avatarTxt: { color: c.textDim, fontSize: 16, fontWeight: '800' },
  contactName: { flex: 1, color: c.text, fontSize: 14, fontWeight: '700' },
  toggleGroup: { flexDirection: 'row', gap: 4 },
  toggleBtn: { width: 44, height: 44, borderRadius: 8, backgroundColor: c.glassSoft, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: c.glassStroke },
  toggleBtnOn: { backgroundColor: brandAlpha(0.2), borderColor: c.primary },
  emptyTxt: { color: c.textDim, fontSize: 13, textAlign: 'center' },
});
