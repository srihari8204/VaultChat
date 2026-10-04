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
import { useCallback, useEffect, useRef, useState , useMemo} from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  RefreshControl,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
// Sealed-or-nothing: session IPs and user agents are not kept in plain
// AsyncStorage (see lib/localCache.ts).
import { readSealedCache as readCache, writeSealedCache as writeCache } from '../lib/localCache';
import {
  listSessions,
  revokeAllOtherSessions,
  revokeSession,
  type SessionRow,
} from '../lib/chatService';
import { AppText as Text, AuroraBackground } from '../components/ui';
import { userErrorText } from '../lib/userErrorText';

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
  // One sign-out at a time: a double tap on a confirmed Sign out used to fire
  // the DELETE twice.
  const [revoking,   setRevoking]   = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const fetchAll = useCallback(async () => {
    try {
      const list = await listSessions();
      if (!mounted.current) return;
      setRows(list);
      setError(null);
      writeCache(CACHE_KEY, list);
    } catch (e: unknown) {
      // Cached rows stay on screen, and the notice above them says they are
      // the saved list (a cold-load failure has no list and says so instead).
      if (mounted.current) setError(userErrorText(e, 'Failed to load sessions'));
    }
  }, []);

  useEffect(() => {
    (async () => {
      const cached = await readCache<SessionRow[]>(CACHE_KEY);
      if (!mounted.current) return;
      if (cached) { setRows(cached); setLoading(false); }
      await fetchAll();
      if (mounted.current) setLoading(false);
    })();
  }, [fetchAll]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchAll();
    if (mounted.current) setRefreshing(false);
  }, [fetchAll]);

  const onRevoke = useCallback((row: SessionRow) => {
    if (row.isCurrent || revoking) return; // guarded in the UI too
    Alert.alert(
      'Sign out this device?',
      `${describeDevice(row.userAgent)} will be signed out immediately and need to log in again to access this account.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign out', style: 'destructive', onPress: async () => {
            setRevoking(true);
            try {
              await revokeSession(row.id);
              if (mounted.current) setRows(prev => prev.filter(r => r.id !== row.id));
            } catch (e: unknown) {
              if (mounted.current) Alert.alert('Could not revoke', (e as Error | undefined)?.message ?? 'Try again');
            } finally {
              if (mounted.current) setRevoking(false);
            }
          }
        },
      ],
    );
  }, [revoking]);

  const onRevokeAllOthers = useCallback(() => {
    if (revoking) return;
    Alert.alert(
      'Sign out other devices?',
      'Every other signed-in device will be revoked immediately. This device stays signed in.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign out others', style: 'destructive', onPress: async () => {
            setRevoking(true);
            try {
              const r = await revokeAllOtherSessions();
              if (!mounted.current) return;
              Alert.alert('Done', `${r.revoked} ${r.revoked === 1 ? 'device' : 'devices'} signed out.`);
              await fetchAll();
            } catch (e: unknown) {
              if (mounted.current) Alert.alert('Failed', (e as Error | undefined)?.message ?? 'Try again');
            } finally {
              if (mounted.current) setRevoking(false);
            }
          }
        },
      ],
    );
  }, [fetchAll, revoking]);

  // The header (with Back) is on screen in every state, loading included.
  const header = (
    <View style={S.header}>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} hitSlop={10} style={S.backBtn}>
        <Ionicons name="arrow-back" size={24} color={colors.text} />
      </TouchableOpacity>
      <Text style={S.title} accessibilityRole="header">Active devices</Text>
    </View>
  );

  if (loading) {
    return (
      <View style={S.screen}>
        <AuroraBackground />
        {header}
        <View style={[S.center, { flex: 1 }]}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      </View>
    );
  }

  const others = rows.filter(r => !r.isCurrent);

  return (
    <View style={S.screen}>
      <AuroraBackground />
      {header}

      {error && (
        <View style={S.errorRow} accessibilityRole="alert">
          <Text style={[S.errorTxt, { flex: 1 }]}>
            {rows.length > 0 ? `Showing your saved list — it could not be refreshed. ${error}` : error}
          </Text>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Try loading devices again" onPress={onRefresh} disabled={refreshing}
            accessibilityState={{ disabled: refreshing, busy: refreshing }} style={S.retryBtn} activeOpacity={0.7}>
            {refreshing ? <ActivityIndicator color={colors.primary} /> : <Text style={S.retryTxt}>Try again</Text>}
          </TouchableOpacity>
        </View>
      )}

      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        refreshControl={<RefreshControl tintColor={colors.primary} refreshing={refreshing} onRefresh={onRefresh} />}
        contentContainerStyle={{ paddingBottom: 24 }}
        ListHeaderComponent={
          // A cold-load failure has no list to describe: "0 signed-in devices"
          // would be a false statement, not an empty state.
          error && rows.length === 0 ? null : <View style={S.intro}>
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
            disabled={r.isCurrent || revoking}
            accessibilityRole="button"
            accessibilityLabel={r.isCurrent ? `${describeDevice(r.userAgent)}, this device` : `Sign out ${describeDevice(r.userAgent)}`}
            accessibilityState={{ disabled: r.isCurrent || revoking }}
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
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Sign out all other devices, ${others.length}`} accessibilityState={{ disabled: revoking, busy: revoking }} disabled={revoking} style={[S.revokeAllBtn, revoking && { opacity: 0.5 }]} onPress={onRevokeAllOthers} activeOpacity={0.85}>
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
  title:         { color: c.text, fontSize: 22, fontWeight: '800' },

  errorTxt:      { color: c.danger, paddingVertical: 8, fontSize: 12 },
  errorRow:      { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16 },
  retryBtn:      { minHeight: 44, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: c.glassStroke, backgroundColor: c.glassSoft },
  retryTxt:      { color: c.primary, fontWeight: '700', fontSize: 13 },

  intro:         { marginHorizontal: 16, marginTop: 12, marginBottom: 8, padding: 14, borderRadius: 16, backgroundColor: c.glass, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  introTxt:      { color: c.textDim, fontSize: 12, lineHeight: 16 },

  row:           { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 14, paddingVertical: 14, borderRadius: 16, backgroundColor: c.glass, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  rowCurrent:    { backgroundColor: c.glassSoft, borderColor: c.primary },
  rowTop:        { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowDevice:     { color: c.text, fontSize: 15, fontWeight: '600', flex: 1 },
  currentTag:    { color: c.primary, fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1, borderColor: c.primary, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: 'hidden' },
  rowSub:        { color: c.textDim, fontSize: 12, marginTop: 4 },
  rowSubSmall:   { color: c.textDim, fontSize: 11, marginTop: 2, opacity: 0.7 },
  revokeTxt:     { color: c.danger, fontSize: 12, fontWeight: '700' },

  revokeAllBtn:  { marginHorizontal: 20, marginTop: 24, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: c.danger, backgroundColor: c.glassSoft, alignItems: 'center' },
  revokeAllTxt:  { color: c.danger, fontWeight: '700' },
});
