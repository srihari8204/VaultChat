// app/(tabs)/alerts.tsx — Security console (#41).
//
// Renders the on-device, tamper-evident audit chain (services/security/auditChain).
// Every entry is a real recorded event (screenshot captures, device-integrity
// scans, …); the chain is hash-linked so any after-the-fact edit/deletion is
// detected and shown in the integrity banner. "Scan device" runs a real
// root/Frida/emulator scan and appends its result. Nothing here is mock data.

import { HEADER_TOP, TAB_BAR_SPACE } from '../../constants/layout';
import { brandAlpha } from '../../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useState , useMemo} from 'react';
import {
  ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text,
  TouchableOpacity, View,
} from 'react-native';
import { type Palette } from '../../constants/theme';
import { useTheme } from '../../lib/theme';
import {
  listSecurityEvents, markAllSeen, syncAuditChain, verifyAuditChain,
  type AuditSeverity, type ChainStatus, type SecurityEvent,
} from '../../services/security/auditChain';
import { scanDeviceAndRecord } from '../../services/securityService';
import { AuroraBackground } from '../../components/ui';

const SEV_COLOR: Record<AuditSeverity, string> = {
  critical: '#EF4444',
  high:     '#F59E0B',
  medium:   '#FBBF24',
  low:      '#34D399',
  info:     '#06B6D4',
};

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
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function AlertsScreen() {
  const { colors } = useTheme();
  const S = useS();
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [status, setStatus] = useState<ChainStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = useCallback(async () => {
    const [evs, st] = await Promise.all([listSecurityEvents(), verifyAuditChain()]);
    setEvents(evs);
    setStatus(st);
    setLoading(false);
    markAllSeen().catch(() => {});
    // Background: mirror new events to the zero-knowledge backup and restore on
    // a fresh install, then refresh the feed if anything changed.
    syncAuditChain().then(async () => {
      const [e2, s2] = await Promise.all([listSecurityEvents(), verifyAuditChain()]);
      setEvents(e2);
      setStatus(s2);
    }).catch(() => {});
  }, []);

  // Refresh whenever the tab gains focus so new events appear immediately.
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onScan = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    try {
      await scanDeviceAndRecord();
    } catch {
      // scan failures are non-fatal; the entry simply won't be added
    } finally {
      setScanning(false);
      load();
    }
  }, [scanning, load]);

  const renderItem = useCallback(({ item }: { item: SecurityEvent }) => {
    const color = SEV_COLOR[item.severity] ?? SEV_COLOR.info;
    const isOpen = expanded === item.seq;
    return (
      <TouchableOpacity
        style={S.row}
        activeOpacity={0.7}
        onPress={() => setExpanded(isOpen ? null : item.seq)}
      >
        <View style={[S.iconWrap, { backgroundColor: color + '22' }]}>
          <Ionicons name={iconForType(item.type)} size={20} color={color} />
        </View>
        <View style={S.rowBody}>
          <View style={S.rowTop}>
            <Text style={S.rowTitle} numberOfLines={1}>{item.title}</Text>
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
              <Text style={S.metaLine} numberOfLines={1}>
                <Text style={S.metaKey}>Hash  </Text>{item.hash.slice(0, 24)}…
              </Text>
            </View>
          )}
        </View>
      </TouchableOpacity>
    );
  }, [expanded]);

  return (
    <View style={S.screen}>
      <AuroraBackground />
      <View style={S.header}>
        <View style={{ flex: 1 }}>
          <Text style={S.title}>Alerts</Text>
          <Text style={S.subtitle}>Tamper-evident security log</Text>
        </View>
        <TouchableOpacity style={S.scanBtn} onPress={onScan} disabled={scanning} activeOpacity={0.8}>
          {scanning
            ? <ActivityIndicator size="small" color="#fff" />
            : <Ionicons name="shield-checkmark" size={16} color="#fff" />}
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

      {loading ? (
        <View style={S.center}><ActivityIndicator color={colors.primary} /></View>
      ) : (
        <FlatList
          data={events}
          keyExtractor={(e) => String(e.seq)}
          renderItem={renderItem}
          contentContainerStyle={events.length === 0 ? S.emptyWrap : { paddingVertical: 8, paddingBottom: TAB_BAR_SPACE + 16 }}
          refreshControl={
            <RefreshControl refreshing={false} onRefresh={load} tintColor={colors.primary} />
          }
          ListEmptyComponent={
            <View style={S.empty}>
              <Ionicons name="shield-checkmark-outline" size={56} color={colors.textFaint} />
              <Text style={S.emptyTitle}>No security events yet</Text>
              <Text style={S.emptySub}>
                Screenshot captures, device scans, and other security events are recorded
                here in a tamper-evident on-device log. Tap “Scan device” to run a check now.
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  header:   { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: HEADER_TOP, paddingBottom: 12, gap: 12 },
  title:    { color: c.text, fontSize: 28, fontWeight: '800' },
  subtitle: { color: c.textDim, fontSize: 13, marginTop: 2 },
  scanBtn:  { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.primary, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 12 },
  scanBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },

  banner:   { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, borderWidth: 1 },
  bannerOk: { backgroundColor: brandAlpha(0.08), borderColor: brandAlpha(0.3) },
  bannerBad:{ backgroundColor: 'rgba(239,68,68,0.08)', borderColor: 'rgba(239,68,68,0.35)' },
  bannerText: { fontSize: 12.5, fontWeight: '600', flex: 1 },

  center:   { flex: 1, justifyContent: 'center', alignItems: 'center' },

  row:      { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 12, alignItems: 'flex-start' },
  iconWrap: { width: 40, height: 40, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  rowBody:  { flex: 1 },
  rowTop:   { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowTitle: { color: c.text, fontSize: 15, fontWeight: '700', flex: 1 },
  rowTime:  { color: c.textFaint, fontSize: 11.5 },
  rowDetail:{ color: c.textDim, fontSize: 13, lineHeight: 18, marginTop: 2 },
  metaBox:  { marginTop: 8, padding: 10, borderRadius: 10, backgroundColor: c.surface, gap: 3 },
  metaLine: { color: c.textDim, fontSize: 12 },
  metaKey:  { color: c.textFaint, fontWeight: '700' },

  emptyWrap:{ flexGrow: 1, justifyContent: 'center' },
  empty:    { alignItems: 'center', paddingHorizontal: 36, gap: 10 },
  emptyTitle: { color: c.text, fontSize: 17, fontWeight: '700', marginTop: 6 },
  emptySub: { color: c.textDim, fontSize: 13.5, textAlign: 'center', lineHeight: 20 },
});
