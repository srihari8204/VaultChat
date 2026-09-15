// app/login-history.tsx — Active sessions + remote sign-out (Postgres).
//
// Backed by:
//   GET    /user/sessions               — list active refresh tokens
//   DELETE /user/sessions/:id           — revoke one
//   DELETE /user/sessions               — revoke all except current
//
// "Session" = one non-revoked refresh token = one signed-in device.
// The row flagged isCurrent is the device this app is running on.

import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState , useMemo} from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { readCache, writeCache } from '../lib/localCache';
import {
  listSessions,
  revokeAllOtherSessions,
  revokeSession,
  type SessionRow,
} from '../lib/chatService';
import { AuroraBackground } from '../components/ui';

const CACHE_KEY = 'sessions';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function LoginHistoryScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const [rows,       setRows]       = useState<SessionRow[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const list = await listSessions();
      setRows(list);
      setError(null);
      writeCache(CACHE_KEY, list);
    } catch (e: any) {
      // Keep cached rows if we have them; only surface the error on a cold load.
      setRows(prev => {
        if (prev.length === 0) setError(e?.message ?? 'Failed to load sessions');
        return prev;
      });
    }
  }, []);

  useEffect(() => {
    (async () => {
      const cached = await readCache<SessionRow[]>(CACHE_KEY);
      if (cached) { setRows(cached); setLoading(false); }
      await fetchAll();
      setLoading(false);
    })();
  }, [fetchAll]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchAll();
    setRefreshing(false);
  }, [fetchAll]);

  const onRevoke = useCallback((row: SessionRow) => {
    if (row.isCurrent) return; // guarded in the UI too
    Alert.alert(
      'Sign out this device?',
      `${describeDevice(row.userAgent)} will be signed out immediately and need to log in again to access this account.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign out', style: 'destructive', onPress: async () => {
            try {
              await revokeSession(row.id);
              setRows(prev => prev.filter(r => r.id !== row.id));
            } catch (e: any) {
              Alert.alert('Could not revoke', e?.message ?? 'Try again');
            }
          }
        },
      ],
    );
  }, []);

  const onRevokeAllOthers = useCallback(() => {
    Alert.alert(
      'Sign out other devices?',
      'Every other signed-in device will be revoked immediately. This device stays signed in.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign out others', style: 'destructive', onPress: async () => {
            try {
              const r = await revokeAllOtherSessions();
              Alert.alert('Done', `${r.revoked} device(s) signed out.`);
              await fetchAll();
            } catch (e: any) {
              Alert.alert('Failed', e?.message ?? 'Try again');
            }
          }
        },
      ],
    );
  }, [fetchAll]);

  if (loading) {
    return (
      <View style={[S.screen, S.center]}>
      <AuroraBackground />
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  const others = rows.filter(r => !r.isCurrent);

  return (
    <View style={S.screen}>
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={S.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.title}>Active devices</Text>
      </View>

      {error && <Text style={S.errorTxt}>{error}</Text>}

      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        refreshControl={<RefreshControl tintColor={colors.primary} refreshing={refreshing} onRefresh={onRefresh} />}
        contentContainerStyle={{ paddingBottom: 24 }}
        ListHeaderComponent={
          <View style={S.intro}>
            <Text style={S.introTxt}>
              {rows.length} signed-in device{rows.length === 1 ? '' : 's'}. Tap any other device to sign it out remotely.
            </Text>
          </View>
        }
        renderItem={({ item: r }) => (
          <TouchableOpacity
            style={[S.row, r.isCurrent && S.rowCurrent]}
            onPress={() => onRevoke(r)}
            activeOpacity={r.isCurrent ? 1 : 0.7}
            disabled={r.isCurrent}
          >
            <View style={{ flex: 1 }}>
              <View style={S.rowTop}>
                <Text style={S.rowDevice} numberOfLines={1}>{describeDevice(r.userAgent)}</Text>
                {r.isCurrent && <Text style={S.currentTag}>this device</Text>}
              </View>
              <Text style={S.rowSub} numberOfLines={1}>
                {r.ip || 'IP unknown'} · last active {formatRelative(r.lastUsedAt || r.createdAt)}
              </Text>
              <Text style={S.rowSubSmall}>Signed in {formatRelative(r.createdAt)} · expires {formatRelative(r.expiresAt)}</Text>
            </View>
            {!r.isCurrent && <Text style={S.revokeTxt}>Sign out</Text>}
          </TouchableOpacity>
        )}
        ListFooterComponent={
          others.length > 0 ? (
            <TouchableOpacity style={S.revokeAllBtn} onPress={onRevokeAllOthers} activeOpacity={0.85}>
              <Text style={S.revokeAllTxt}>Sign out all other devices ({others.length})</Text>
            </TouchableOpacity>
          ) : null
        }
      />
    </View>
  );
}

// Squash a User-Agent string into a short device label. Order matters —
// we check the most-specific tokens first ("iPhone" before "Mobile").
function describeDevice(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device';
  if (/Pixel/i.test(ua))            return `Android · Pixel`;
  if (/Samsung|SM-/i.test(ua))      return `Android · Samsung`;
  if (/OnePlus/i.test(ua))          return `Android · OnePlus`;
  if (/iPhone/i.test(ua))           return `iPhone`;
  if (/iPad/i.test(ua))             return `iPad`;
  if (/Android/i.test(ua))          return `Android`;
  if (/iOS/i.test(ua))              return `iOS`;
  if (/crazzychat/i.test(ua))        return `crazzychat (mobile)`;
  if (/Mac OS X/i.test(ua))         return `macOS`;
  if (/Windows/i.test(ua))          return `Windows`;
  return ua.length > 40 ? `${ua.slice(0, 40)}…` : ua;
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'never';
  try {
    const t = new Date(iso).getTime();
    const diff = t - Date.now();
    const abs  = Math.abs(diff);
    if (abs < 60_000)      return diff > 0 ? 'in <1m' : 'just now';
    if (abs < 3600_000)    return `${diff > 0 ? 'in ' : ''}${Math.floor(abs / 60_000)}m${diff > 0 ? '' : ' ago'}`;
    if (abs < 86400_000)   return `${diff > 0 ? 'in ' : ''}${Math.floor(abs / 3600_000)}h${diff > 0 ? '' : ' ago'}`;
    if (abs < 7 * 86400_000) return `${diff > 0 ? 'in ' : ''}${Math.floor(abs / 86400_000)}d${diff > 0 ? '' : ' ago'}`;
    return new Date(iso).toLocaleDateString();
  } catch { return ''; }
}


const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  center:        { justifyContent: 'center', alignItems: 'center' },

  header:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: HEADER_TOP, paddingBottom: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  backBtn:       { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  backTxt:       { color: c.text, fontSize: 26, fontWeight: '600' },
  title:         { color: c.text, fontSize: 22, fontWeight: '800' },

  errorTxt:      { color: c.danger, paddingHorizontal: 16, paddingVertical: 8, fontSize: 12 },

  intro:         { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 4 },
  introTxt:      { color: c.textDim, fontSize: 12, lineHeight: 16 },

  row:           { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  rowCurrent:    { backgroundColor: 'rgba(108,99,255,0.08)' },
  rowTop:        { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowDevice:     { color: c.text, fontSize: 15, fontWeight: '600', flex: 1 },
  currentTag:    { color: c.primary, fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1, borderColor: c.primary, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: 'hidden' },
  rowSub:        { color: c.textDim, fontSize: 12, marginTop: 4 },
  rowSubSmall:   { color: c.textDim, fontSize: 11, marginTop: 2, opacity: 0.7 },
  revokeTxt:     { color: c.danger, fontSize: 12, fontWeight: '700' },

  revokeAllBtn:  { marginHorizontal: 20, marginTop: 24, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: c.danger, backgroundColor: c.glassSoft, alignItems: 'center' },
  revokeAllTxt:  { color: c.danger, fontWeight: '700' },
});
