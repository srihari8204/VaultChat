// app/aiguardian.tsx — Security Guardian.
//
// Honest device & account security overview. Replaces the old screen that
// hardcoded a "97/100" score and a fake 3-second "AI analysis". Everything here
// is real: the score is computed from actual signals (services/security/
// securityScore), recent events come from the on-device tamper-evident audit
// chain, and "Run device scan" performs a real root/Frida/emulator scan.
// No invented numbers, no behavioral-AI claims we don't implement.

import { BRAND_ACCENT } from '../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState , useMemo} from 'react';
import {
  ActivityIndicator, Alert, ScrollView, StyleSheet, Text,
  TouchableOpacity, View,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import {
  listSecurityEvents, type AuditSeverity, type SecurityEvent,
} from '../services/security/auditChain';
import { computeSecurityScore, type SecurityScore } from '../services/security/securityScore';
import { scanDeviceAndRecord } from '../services/securityService';

const SEV_COLOR: Record<AuditSeverity, string> = {
  critical: '#EF4444', high: '#F59E0B', medium: '#FBBF24', low: '#34D399', info: '#06B6D4',
};

const GRADE_META: Record<SecurityScore['grade'], { color: string; label: string }> = {
  strong:  { color: BRAND_ACCENT, label: 'Strong'      },
  good:    { color: '#34D399',      label: 'Good'        },
  fair:    { color: '#F59E0B',      label: 'Fair'        },
  weak:    { color: '#EF4444',      label: 'Needs work'  },
  unknown: { color: '#9CA3AF', label: 'Run a scan'  },
};

function iconForType(type: string): keyof typeof Ionicons.glyphMap {
  switch (type) {
    case 'SCREENSHOT_ATTEMPT': return 'camera';
    case 'DEVICE_SCAN':
    case 'DEVICE_INTEGRITY':   return 'shield-checkmark';
    case 'ROOT_DETECTED':      return 'bug';
    case 'KEY_CHANGE':         return 'key';
    case 'LOGIN':              return 'log-in';
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

export default function SecurityGuardianScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const [data, setData] = useState<SecurityScore | null>(null);
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [scanning, setScanning] = useState(false);

  const load = useCallback(async () => {
    const [score, evs] = await Promise.all([computeSecurityScore(), listSecurityEvents(8)]);
    setData(score);
    setEvents(evs);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onScan = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    try {
      const report = await scanDeviceAndRecord();
      Alert.alert(
        report.clean ? 'Scan complete — clean' : 'Scan complete — issues found',
        report.clean
          ? 'No root, instrumentation, or tampering indicators were detected.\n\nNote: a sandboxed app cannot detect kernel-level implants, so clean does not guarantee safety.'
          : report.threats.map((t) => `• ${t.detail}`).join('\n'),
      );
    } catch {
      Alert.alert('Scan failed', 'The device scan could not complete. Please try again.');
    } finally {
      setScanning(false);
      load();
    }
  }, [scanning, load]);

  const grade = GRADE_META[data?.grade ?? 'unknown'];

  return (
    <View style={S.container}>
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} style={S.backBtn} hitSlop={10}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={S.headerTitle}>Security Guardian</Text>
          <Text style={S.headerSub}>Live checks on this device & account</Text>
        </View>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
        {/* Score hero */}
        <View style={S.hero}>
          <View style={[S.ring, { borderColor: grade.color }]}>
            <Text style={[S.scoreNum, { color: grade.color }]}>
              {data?.score ?? '—'}
            </Text>
            {data?.score != null && <Text style={S.scoreMax}>/100</Text>}
          </View>
          <Text style={[S.gradeLabel, { color: grade.color }]}>{grade.label}</Text>
          <Text style={S.heroSub}>
            {data?.score == null
              ? 'Run a device scan to evaluate device integrity.'
              : 'Score reflects encryption, app lock, and your latest device scan.'}
          </Text>
        </View>

        {/* Run scan */}
        <TouchableOpacity style={S.scanBtn} onPress={onScan} disabled={scanning} activeOpacity={0.85}>
          {scanning
            ? <ActivityIndicator size="small" color="#fff" />
            : <Ionicons name="shield-checkmark" size={18} color="#fff" />}
          <Text style={S.scanBtnText}>{scanning ? 'Scanning device…' : 'Run device scan'}</Text>
        </TouchableOpacity>

        {/* Checks */}
        <Text style={S.sectionTitle}>CHECKS</Text>
        <View style={S.card}>
          {(data?.factors ?? []).map((f, i) => {
            const color = f.pending ? colors.textDim : f.ok ? BRAND_ACCENT : '#EF4444';
            const icon = f.pending ? 'help-circle' : f.ok ? 'checkmark-circle' : 'close-circle';
            return (
              <View key={f.key}>
                <View style={S.checkRow}>
                  <Ionicons name={icon} size={22} color={color} />
                  <View style={{ flex: 1 }}>
                    <Text style={S.checkLabel}>{f.label}</Text>
                    <Text style={S.checkDetail}>{f.detail}</Text>
                  </View>
                </View>
                {i < (data!.factors.length - 1) && <View style={S.divider} />}
              </View>
            );
          })}
        </View>

        {/* Recent events */}
        <Text style={S.sectionTitle}>RECENT SECURITY EVENTS</Text>
        {events.length === 0 ? (
          <View style={[S.card, S.emptyCard]}>
            <Text style={S.emptyText}>
              No events recorded yet. Captures and scans appear here and in the Alerts tab.
            </Text>
          </View>
        ) : (
          <View style={S.card}>
            {events.map((e, i) => {
              const color = SEV_COLOR[e.severity] ?? SEV_COLOR.info;
              return (
                <View key={e.seq}>
                  <TouchableOpacity
                    style={S.eventRow}
                    activeOpacity={0.7}
                    onPress={() => Alert.alert(e.title, `${e.detail || '—'}\n\n${new Date(e.ts).toLocaleString()}`)}
                  >
                    <View style={[S.eventIcon, { backgroundColor: color + '22' }]}>
                      <Ionicons name={iconForType(e.type)} size={18} color={color} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={S.eventTitle} numberOfLines={1}>{e.title}</Text>
                      <Text style={S.eventDetail} numberOfLines={1}>{e.detail || '—'}</Text>
                    </View>
                    <Text style={S.eventTime}>{timeAgo(e.ts)}</Text>
                  </TouchableOpacity>
                  {i < events.length - 1 && <View style={S.divider} />}
                </View>
              );
            })}
          </View>
        )}

        <TouchableOpacity style={S.alertsLink} onPress={() => router.push('/(tabs)/alerts')} activeOpacity={0.7}>
          <Text style={S.alertsLinkText}>View full security log</Text>
          <Ionicons name="arrow-forward" size={15} color={colors.primary} />
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 54, paddingBottom: 14, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: c.border },
  backBtn: { padding: 4 },
  headerTitle: { color: c.text, fontSize: 18, fontWeight: '800' },
  headerSub: { color: c.textDim, fontSize: 12, marginTop: 1 },

  hero: { alignItems: 'center', paddingVertical: 28, gap: 8 },
  ring: { width: 130, height: 130, borderRadius: 65, borderWidth: 5, justifyContent: 'center', alignItems: 'center', flexDirection: 'row' },
  scoreNum: { fontSize: 44, fontWeight: '900' },
  scoreMax: { color: c.textFaint, fontSize: 15, fontWeight: '700', marginLeft: 2, marginTop: 14 },
  gradeLabel: { fontSize: 18, fontWeight: '800', marginTop: 4 },
  heroSub: { color: c.textDim, fontSize: 13, textAlign: 'center', paddingHorizontal: 40, lineHeight: 19 },

  scanBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginHorizontal: 16, backgroundColor: c.primary, paddingVertical: 15, borderRadius: 14 },
  scanBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },

  sectionTitle: { color: c.textFaint, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginTop: 24, marginBottom: 8, marginLeft: 20 },
  card: { marginHorizontal: 16, backgroundColor: c.card, borderRadius: 16, borderWidth: 1, borderColor: c.border, overflow: 'hidden' },
  divider: { height: 1, backgroundColor: c.separator, marginLeft: 16 },

  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  checkLabel: { color: c.text, fontSize: 14.5, fontWeight: '700' },
  checkDetail: { color: c.textDim, fontSize: 12.5, marginTop: 2, lineHeight: 17 },

  emptyCard: { padding: 18 },
  emptyText: { color: c.textDim, fontSize: 13, lineHeight: 19, textAlign: 'center' },

  eventRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
  eventIcon: { width: 36, height: 36, borderRadius: 11, justifyContent: 'center', alignItems: 'center' },
  eventTitle: { color: c.text, fontSize: 14, fontWeight: '700' },
  eventDetail: { color: c.textDim, fontSize: 12, marginTop: 1 },
  eventTime: { color: c.textFaint, fontSize: 11 },

  alertsLink: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 22 },
  alertsLinkText: { color: c.primary, fontSize: 14, fontWeight: '700' },
});
