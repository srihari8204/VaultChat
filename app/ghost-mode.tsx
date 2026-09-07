// app/ghost-mode.tsx — Per-contact privacy overrides (Postgres).
//
// Routes:
//   GET    /user/ghost-mode             — list active overrides
//   GET    /user/ghost-mode/:targetId   — single (or default)
//   PUT    /user/ghost-mode/:targetId   — set/upsert per-flag
//   DELETE /user/ghost-mode/:targetId   — clear all overrides
//
// Two modes:
//   * Without ?targetId param → list view, tap a row to drill into per-target toggles
//   * With  ?targetId param   → per-target editor with 4 switches
//
// Enforced server-side at the fan-out layer (presence, typing, read).
// Last-seen blanking happens in the GET /chats query.

import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState , useMemo} from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { readCache, writeCache } from '../lib/localCache';
import { getAccessToken } from '../lib/api';
import {
  attachmentUrl,
  clearGhostMode,
  getGhostMode,
  listGhostMode,
  setGhostMode,
  type GhostMode,
} from '../lib/chatService';
import { AuroraBackground } from '../components/ui';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function GhostModeScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const { targetId, targetName } = useLocalSearchParams<{ targetId?: string; targetName?: string }>();

  if (targetId) return <PerTargetEditor targetId={targetId} targetName={targetName ?? null} />;
  return <ListView />;
}

// ─── List view ────────────────────────────────────────────────
function ListView() {
  const S = useS();
  const { colors } = useTheme();
  const router = useRouter();
  const [rows,    setRows]    = useState<GhostMode[]>([]);
  const [loading, setLoading] = useState(true);
  const [authHeader, setAuthHeader] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      // Local-first: paint last-known overrides instantly, then refresh.
      const cached = await readCache<GhostMode[]>('ghost-mode');
      if (!cancel && cached) { setRows(cached); setLoading(false); }
      try {
        const [list, tok] = await Promise.all([listGhostMode(), getAccessToken()]);
        if (!cancel) {
          setRows(list);
          setAuthHeader(tok ? `Bearer ${tok}` : null);
        }
        writeCache('ghost-mode', list);
      } catch (e: any) {
        // Keep painted cache for offline read; only surface error when nothing shown.
        if (!cancel && !cached) Alert.alert('Could not load', e?.message ?? 'Try again');
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, []);

  if (loading) {
    return <View style={[S.screen, S.center]}>
      <AuroraBackground /><ActivityIndicator color={colors.primary} size="large" /></View>;
  }

  return (
    <View style={S.screen}>
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={S.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.title}>Ghost Mode</Text>
      </View>

      <View style={S.intro}>
        <Text style={S.introTxt}>
          Per-contact privacy overrides. Hide online, typing, read receipts,
          or last seen from specific people while staying visible to everyone else.
        </Text>
      </View>

      {rows.length === 0 ? (
        <View style={[S.center, { flex: 1, paddingHorizontal: 32 }]}>
          <Text style={S.emptyTitle}>No overrides set</Text>
          <Text style={S.emptySub}>
            Open any chat → tap the ⋮ menu → “Ghost Mode” to hide live signals from that person.
          </Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.targetId}
          contentContainerStyle={{ paddingBottom: 32 }}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={S.row}
              activeOpacity={0.7}
              onPress={() => router.push({
                pathname: '/ghost-mode' as any,
                params: { targetId: item.targetId, targetName: item.name ?? item.email ?? '' },
              })}
            >
              <View style={S.avatar}>
                {item.photoURL && authHeader ? (
                  <Image
                    source={{ uri: attachmentUrl(item.photoURL), headers: { Authorization: authHeader } }}
                    style={S.avatarImg}
                  />
                ) : (
                  <Text style={S.avatarTxt}>{(item.name || item.email || '?').trim()[0].toUpperCase()}</Text>
                )}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={S.rowName} numberOfLines={1}>{item.name || item.email || item.targetId.slice(0, 8)}</Text>
                <Text style={S.rowSub} numberOfLines={1}>{summarise(item)}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

function summarise(g: GhostMode): string {
  const hidden: string[] = [];
  if (g.hideOnline)   hidden.push('online');
  if (g.hideTyping)   hidden.push('typing');
  if (g.hideRead)     hidden.push('read');
  if (g.hideLastSeen) hidden.push('last seen');
  return hidden.length === 0 ? 'no overrides' : `Hidden: ${hidden.join(' · ')}`;
}

// ─── Per-target editor ────────────────────────────────────────
function PerTargetEditor({ targetId, targetName }: { targetId: string; targetName: string | null }) {
  const S = useS();
  const { colors } = useTheme();
  const router = useRouter();
  const [state,   setState]   = useState<GhostMode | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState<null | keyof GhostMode>(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      // Local-first: paint this contact's last-known overrides, then refresh.
      const cached = await readCache<GhostMode>('ghost-mode:' + targetId);
      if (!cancel && cached) { setState(cached); setLoading(false); }
      try {
        const g = await getGhostMode(targetId);
        if (!cancel) setState(g);
        writeCache('ghost-mode:' + targetId, g);
      } catch (e: any) {
        if (!cancel && !cached) Alert.alert('Could not load', e?.message ?? 'Try again');
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, [targetId]);

  const toggle = useCallback(async (key: keyof Pick<GhostMode, 'hideOnline' | 'hideTyping' | 'hideRead' | 'hideLastSeen'>) => {
    if (!state || saving) return;
    const next = { ...state, [key]: !state[key] };
    setState(next);
    setSaving(key);
    try {
      await setGhostMode(targetId, { [key]: next[key] });
    } catch (e: any) {
      setState(state); // rollback
      Alert.alert('Save failed', e?.message ?? 'Try again');
    } finally {
      setSaving(null);
    }
  }, [state, saving, targetId]);

  const onClearAll = useCallback(() => {
    Alert.alert(
      'Clear Ghost Mode?',
      'All overrides for this contact will be removed. They\'ll see your live signals normally again.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear', style: 'destructive', onPress: async () => {
            try {
              await clearGhostMode(targetId);
              router.back();
            } catch (e: any) {
              Alert.alert('Failed', e?.message ?? 'Try again');
            }
          }
        },
      ],
    );
  }, [targetId, router]);

  if (loading || !state) {
    return <View style={[S.screen, S.center]}><ActivityIndicator color={colors.primary} size="large" /></View>;
  }

  const anySet = state.hideOnline || state.hideTyping || state.hideRead || state.hideLastSeen;

  return (
    <ScrollView style={S.screen} contentContainerStyle={{ paddingBottom: 64 }}>
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={S.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.title}>Ghost Mode</Text>
      </View>

      <View style={S.intro}>
        <Text style={S.introTxt}>
          Hide live signals from <Text style={{ color: colors.primary, fontWeight: '700' }}>{targetName || targetId.slice(0, 8)}</Text>.
          They stay your contact — they just won’t see the chosen indicators in real time.
        </Text>
      </View>

      <View style={S.section}>
        <ToggleRow
          title="Hide online status"
          sub="Appear offline to this contact even when you're using the app."
          value={state.hideOnline}
          busy={saving === 'hideOnline'}
          onChange={() => toggle('hideOnline')}
        />
        <ToggleRow
          title="Hide typing indicator"
          sub="They won't see “typing…” when you compose a reply."
          value={state.hideTyping}
          busy={saving === 'hideTyping'}
          onChange={() => toggle('hideTyping')}
        />
        <ToggleRow
          title="Hide read receipts"
          sub="They'll still see ✓✓ delivered, but not the blue read tick."
          value={state.hideRead}
          busy={saving === 'hideRead'}
          onChange={() => toggle('hideRead')}
        />
        <ToggleRow
          title="Hide last seen"
          sub="Your last-active timestamp won't appear in their chat list or header."
          value={state.hideLastSeen}
          busy={saving === 'hideLastSeen'}
          onChange={() => toggle('hideLastSeen')}
        />
      </View>

      {anySet && (
        <TouchableOpacity style={S.clearBtn} onPress={onClearAll} activeOpacity={0.85}>
          <Text style={S.clearBtnTxt}>Clear all overrides</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}

function ToggleRow({
  title, sub, value, busy, onChange,
}: {
  title: string; sub: string; value: boolean; busy: boolean; onChange: () => void;
}) {
  const S = useS();
  const { colors } = useTheme();
  return (
    <View style={S.toggleRow}>
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={S.toggleTitle}>{title}</Text>
        <Text style={S.toggleSub}>{sub}</Text>
      </View>
      {busy ? (
        <ActivityIndicator color={colors.primary} style={{ marginLeft: 8 }} />
      ) : (
        <Switch
          value={value}
          onValueChange={onChange}
          trackColor={{ true: colors.primary, false: '#374151' }}
          thumbColor="#fff"
        />
      )}
    </View>
  );
}


const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  center:        { justifyContent: 'center', alignItems: 'center' },

  header:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: HEADER_TOP, paddingBottom: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  backBtn:       { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  backTxt:       { color: c.text, fontSize: 26, fontWeight: '600' },
  title:         { color: c.text, fontSize: 22, fontWeight: '800' },

  intro:         { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
  introTxt:      { color: c.textDim, fontSize: 13, lineHeight: 18 },

  emptyTitle:    { color: c.text, fontSize: 16, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  emptySub:      { color: c.textDim, fontSize: 13, lineHeight: 18, textAlign: 'center' },

  row:           { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  avatar:        { width: 44, height: 44, borderRadius: 22, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarImg:     { width: '100%', height: '100%' },
  avatarTxt:     { color: '#fff', fontWeight: '700' },
  rowName:       { color: c.text, fontSize: 15, fontWeight: '600' },
  rowSub:        { color: c.textDim, fontSize: 12, marginTop: 2 },
  rowChev:       { color: c.textDim, fontSize: 22, fontWeight: '600' },

  section:       { paddingHorizontal: 16, marginTop: 8 },
  toggleRow:     { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  toggleTitle:   { color: c.text, fontSize: 15, fontWeight: '600' },
  toggleSub:     { color: c.textDim, fontSize: 12, lineHeight: 16, marginTop: 2 },

  clearBtn:      { marginHorizontal: 20, marginTop: 32, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: c.danger, backgroundColor: c.glassSoft, alignItems: 'center' },
  clearBtnTxt:   { color: c.danger, fontWeight: '700' },
});
