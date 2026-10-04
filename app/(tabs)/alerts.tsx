// app/(tabs)/alerts.tsx — Security console (#41).
//
// Renders the on-device, tamper-evident audit chain (services/security/auditChain).
// Every entry is a real recorded event (screenshot captures, device-integrity
// scans, …); the chain is hash-linked so any after-the-fact edit/deletion is
// detected and shown in the integrity banner. "Scan device" runs a real
// root/Frida/emulator scan and appends its result. Nothing here is mock data.

import { HEADER_TOP, TAB_BAR_SPACE } from '../../constants/layout';
import { brandAlpha, type Palette } from '../../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, RefreshControl, StyleSheet,
  TouchableOpacity, View,
} from 'react-native';
import { useTheme } from '../../lib/theme';
import { useVisionComfort } from '../../lib/visionComfort';
import {
  listSecurityEvents, markAllSeen, syncAuditChain, verifyAuditChain,
  type AuditSeverity, type ChainStatus, type SecurityEvent,
} from '../../services/security/auditChain';
import { scanDeviceAndRecord } from '../../services/securityService';
import { holdSecurityVerdict } from '../../lib/securityVerdict';
import { AppText as Text } from '../../components/ui/Text';
import { AuroraBackground } from '../../components/ui';
import { tint } from '../../lib/tintColor';

// Severity ink, all palette roles (danger, warning, caution, success, accentOn
// — each AA on this theme's ground). Medium's caution yellow is kept distinct
// from high's amber.
function sevColor(sev: AuditSeverity, c: Palette): string {
  if (sev === 'critical') return c.danger;
  if (sev === 'high') return c.warning;
  if (sev === 'medium') return c.caution;
  if (sev === 'low') return c.success;
  return c.accentOn;
}

const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message) || fallback;

function iconForType(type: string): keyof typeof Ionicons.glyphMap {
  switch (type) {
    case 'SCREENSHOT_ATTEMPT': return 'camera';
    case 'DEVICE_SCAN':
    case 'DEVICE_INTEGRITY':   return 'shield-checkmark';
    case 'ROOT_DETECTED':      return 'bug';
    case 'KEY_CHANGE':         return 'key';
    case 'LOGIN':              return 'log-in';
    case 'BREACH':             return 'water';
    case 'ATTACHMENT_FLAG':    return 'document-attach';
    case 'THREAT_INTEL':       return 'globe';
    default:                   return 'notifications';
  }
}

function timeAgo(ts: number): string {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  const m = s / 60; if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60; if (h < 24) return `${Math.floor(h)}h ago`;
  const d = h / 24; if (d < 7) return `${Math.floor(d)}d ago`;
  return new Date(ts).toLocaleDateString();
}

function useS() {
  const { colors } = useTheme();
  const { metrics } = useVisionComfort();
  return useMemo(() => makeStyles(colors, metrics), [colors, metrics]);
}

export default function AlertsScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [status, setStatus] = useState<ChainStatus | null>(null);
  const [loading, setLoading] = useState(true);
  // Added with the try/finally in load(): without somewhere to put the failure,
  // a caught error would be silent and the tab would just look empty.
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // The last background backup of the log failed; the local chain is unaffected.
  const [syncNote, setSyncNote] = useState(false);
  // The background sync below settles after the tab may have unmounted.
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    // try/finally added 2026-09-17. setLoading(false) used to sit on the success
    // path only, so ANY throw from listSecurityEvents/verifyAuditChain left this
    // tab on a permanent spinner — and because useFocusEffect below re-runs the
    // same failing call on every focus, it could never self-heal. This is the
    // security console; it failing silently is the worst case for it.
    try {
      setError('');
      const [evs, st] = await Promise.all([listSecurityEvents(), verifyAuditChain()]);
      if (!alive.current) return;
      setEvents(evs);
      setStatus(st);
    } catch (e) {
      if (alive.current) setError(errText(e, 'Could not load security events'));
    } finally {
      if (alive.current) setLoading(false);
    }
    markAllSeen().catch(() => {});
    // Background: mirror new events to the zero-knowledge backup and restore on
    // a fresh install, then refresh the feed if anything changed.
    syncAuditChain().then(async (ok) => {
      if (alive.current) setSyncNote(!ok);
      if (!ok) return;
      const [e2, s2] = await Promise.all([listSecurityEvents(), verifyAuditChain()]);
      if (!alive.current) return;
      setEvents(e2);
      setStatus(s2);
    }).catch(() => {});
  }, []);

  // Refresh whenever the tab gains focus so new events appear immediately.
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    if (alive.current) setRefreshing(false);
  }, [load]);

  // A scan is not read-only: on a wipe-level verdict (root / hooking tools)
  // runSecurityCheck ERASES this phone's encryption keys before it returns
  // (services/securityService.ts). So it is confirmed first, and its verdict is
  // acted on and shown — it used to run on one tap and discard the report.
  const runScan = useCallback(async () => {
    setScanning(true);
    try {
      const report = await scanDeviceAndRecord();
      if (!report.clean) {
        // Same routing as the launch scan in app/_layout.tsx. /blocked reads the
        // held verdict, not route params (a crafted link must not fake one).
        holdSecurityVerdict(report);
        router.replace('/blocked');
        return;
      }
      Alert.alert(
        report.level === 'clean' ? 'No threats found' : 'Scan finished',
        report.level === 'clean'
          ? 'This device passed the integrity scan. The result is in the log below.'
          : `${report.threats.length} low-risk signal${report.threats.length === 1 ? '' : 's'} noted (for example developer options). Nothing was blocked; details are in the log below.`,
      );
    } catch (e) {
      Alert.alert('Scan failed', errText(e, 'The device scan could not run. Nothing was changed — try again.'));
    } finally {
      setScanning(false);
      load();
    }
  }, [load, router]);

  const onScan = useCallback(() => {
    if (scanning) return;
    Alert.alert(
      'Scan this device?',
      'Checks for rooting, hooking tools and similar tampering. If the device is found to be compromised, crazzychat erases its encryption keys on this phone to protect your messages, and you will need to sign in again.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Scan', style: 'destructive', onPress: runScan },
      ],
    );
  }, [scanning, runScan]);

  const renderItem = useCallback(({ item }: { item: SecurityEvent }) => {
    const color = sevColor(item.severity, colors);
    const isOpen = expanded === item.seq;
    return (
      <TouchableOpacity
        style={S.row}
        activeOpacity={0.7}
        onPress={() => setExpanded(isOpen ? null : item.seq)}
        accessibilityRole="button"
        accessibilityLabel={`${item.title}, ${item.severity} severity, ${timeAgo(item.ts)}`}
        accessibilityHint={isOpen ? 'Hides the details' : 'Shows the details'}
        accessibilityState={{ expanded: isOpen }}
      >
        <View style={[S.iconWrap, { backgroundColor: tint(color, 0.13) }]}>
          <Ionicons name={iconForType(item.type)} size={20} color={color} />
        </View>
        <View style={S.rowBody}>
          <View style={S.rowTop}>
            <Text style={S.rowTitle}>{item.title}</Text>
            <Text style={S.rowTime}>{timeAgo(item.ts)}</Text>
          </View>
          <Text style={S.rowDetail} numberOfLines={isOpen ? undefined : 2}>
            {item.detail || '—'}
          </Text>
          {isOpen && (
            <View style={S.metaBox}>
              <Text style={S.metaLine}>
                <Text style={S.metaKey}>Severity  </Text>
                <Text style={{ color }}>{item.severity.toUpperCase()}</Text>
              </Text>
              <Text style={S.metaLine}>
                <Text style={S.metaKey}>Recorded  </Text>{new Date(item.ts).toLocaleString()}
              </Text>
              <Text style={S.metaLine}>
                <Text style={S.metaKey}>Hash  </Text>{item.hash.slice(0, 24)}…
              </Text>
            </View>
          )}
        </View>
      </TouchableOpacity>
    );
  }, [expanded, S, colors]);

  return (
    <View style={S.screen}>
      <AuroraBackground />
      <View style={S.header}>
        <View style={{ flex: 1 }}>
          <Text style={S.title} accessibilityRole="header">Alerts</Text>
          <Text style={S.subtitle}>Tamper-evident security log</Text>
        </View>
        <TouchableOpacity
          style={S.scanBtn}
          onPress={onScan}
          disabled={scanning}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Scan device"
          accessibilityState={{ disabled: scanning, busy: scanning }}
        >
          {scanning
            ? <ActivityIndicator size="small" color={colors.onPrimary} />
            : <Ionicons name="shield-checkmark" size={16} color={colors.onPrimary} />}
          <Text style={S.scanBtnText}>{scanning ? 'Scanning…' : 'Scan device'}</Text>
        </TouchableOpacity>
      </View>

      {status && (
        <View style={[S.banner, status.ok ? S.bannerOk : S.bannerBad]}>
          <Ionicons
            name={status.ok ? 'lock-closed' : 'alert-circle'}
            size={15}
            color={status.ok ? colors.success : colors.danger}
          />
          <Text style={[S.bannerText, { color: status.ok ? colors.success : colors.danger }]}>
            {status.ok
              ? `Log verified · ${status.total} event${status.total === 1 ? '' : 's'} · chain intact`
              : `Integrity broken at entry #${status.brokenAtSeq} — the log was altered`}
          </Text>
        </View>
      )}
      {syncNote && (
        <Text style={[S.metaLine, S.syncNote]} accessibilityLiveRegion="polite">
          Couldn’t back up the log just now — it is safe on this device.
        </Text>
      )}

      {/* A failed refresh must not hide behind the events already listed. */}
      {!!error && events.length > 0 && (
        <TouchableOpacity
          style={[S.banner, S.bannerBad]}
          onPress={onRefresh}
          accessibilityRole="button"
          accessibilityLabel={`Couldn't refresh security events. ${error}. Tap to retry.`}
        >
          <Ionicons name="cloud-offline-outline" size={15} color={colors.danger} />
          <Text style={[S.bannerText, { color: colors.danger }]}>Couldn’t refresh: {error} · Tap to retry</Text>
        </TouchableOpacity>
      )}

      {loading ? (
        <View style={S.center}><ActivityIndicator color={colors.primary} /></View>
      ) : (
        <FlatList
          data={events}
          keyExtractor={(e) => String(e.seq)}
          renderItem={renderItem}
          contentContainerStyle={events.length === 0 ? S.emptyWrap : { paddingVertical: 8, paddingBottom: TAB_BAR_SPACE + 16 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} />
          }
          ListEmptyComponent={
            error ? (
              // A load failure must not read as "you have no security events" —
              // on this tab that is the difference between "nothing happened"
              // and "we could not tell you what happened".
              <View style={S.empty}>
                <Ionicons name="alert-circle-outline" size={56} color={colors.textFaint} />
                <Text style={S.emptyTitle}>Couldn’t load security events</Text>
                <Text style={S.emptySub}>{error}</Text>
                <Text style={S.emptySub}>Pull down to try again.</Text>
              </View>
            ) : (
            <View style={S.empty}>
              <Ionicons name="shield-checkmark-outline" size={56} color={colors.textFaint} />
              <Text style={S.emptyTitle}>No security events yet</Text>
              <Text style={S.emptySub}>
                Screenshot captures, device scans, and other security events are recorded
                here in a tamper-evident on-device log. Tap “Scan device” to run a check now.
              </Text>
            </View>
            )
          }
        />
      )}
    </View>
  );
}

const makeStyles = (c: Palette, m: ReturnType<typeof useVisionComfort>['metrics']) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  header:   { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', paddingHorizontal: 20, paddingTop: HEADER_TOP, paddingBottom: 12, gap: 12 },
  title:    { color: c.text, fontSize: 28, fontWeight: '800' },
  subtitle: { color: c.textDim, fontSize: 13, marginTop: 2 },
  scanBtn:  { minHeight: 44 * m.controlScale, flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.primary, paddingHorizontal: 14, paddingVertical: 9 * m.controlScale, borderRadius: 12 },
  scanBtnText: { flexShrink: 1, color: c.onPrimary, fontWeight: '700', fontSize: 13 },

  banner:   { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, borderWidth: 1 },
  bannerOk: { backgroundColor: brandAlpha(0.08), borderColor: brandAlpha(0.3) },
  bannerBad:{ backgroundColor: tint(c.danger, 0.08), borderColor: tint(c.danger, 0.35) },
  bannerText: { fontSize: 12.5, fontWeight: '600', flex: 1 },

  center:   { flex: 1, justifyContent: 'center', alignItems: 'center' },

  row:      { marginHorizontal: 12, marginVertical: 4, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke, backgroundColor: c.glassSoft, flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 12 * m.spacingScale, alignItems: 'flex-start' },
  iconWrap: { width: 40, height: 40, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  rowBody:  { flex: 1 },
  rowTop:   { gap: 3 },
  rowTitle: { color: c.text, fontSize: 15, fontWeight: '700', flex: 1 },
  rowTime:  { color: c.textDim, fontSize: 12 },
  rowDetail:{ color: c.textDim, fontSize: 13, lineHeight: 18, marginTop: 2 },
  metaBox:  { marginTop: 8, padding: 10, borderRadius: 10, backgroundColor: c.glassSoft, gap: 3 },
  metaLine: { color: c.textDim, fontSize: 12 },
  syncNote: { marginHorizontal: 16, marginBottom: 8 },
  metaKey:  { color: c.textFaint, fontWeight: '700' },

  emptyWrap:{ paddingBottom: TAB_BAR_SPACE + 16, paddingTop: 20, flexGrow: 1, justifyContent: 'center' },
  empty:    { alignItems: 'center', paddingHorizontal: 36, gap: 10 },
  emptyTitle: { color: c.text, fontSize: 17, fontWeight: '700', marginTop: 6 },
  emptySub: { color: c.textDim, fontSize: 13.5, textAlign: 'center', lineHeight: 20 },
});
