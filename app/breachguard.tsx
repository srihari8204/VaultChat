// app/breachguard.tsx — Breach Guard (real, full-stack).
//
// Replaces the old screen that hardcoded fake breaches (LinkedIn/RockYou…) and a
// fake "Querying DeHashed/IntelligenceX" scan. Everything here is real:
//   • Monitored targets persist on the backend (/user/breach-monitors).
//   • Email checks hit the real HIBP breach API on-device with the user's own key
//     (the key never leaves the phone).
//   • The password check is keyless (HIBP k-anonymity).
//   • Findings are recorded to the on-device tamper-evident audit chain (#41).
// No invented data, no fake scan theatre.

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState , useMemo} from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView,
  StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import {
  addMonitor, checkEmailBreaches, checkPasswordPwned, fmtCount, listMonitors,
  recordMonitorScan, removeMonitor, type Breach, type BreachMonitor,
} from '../lib/breachCheck';
import { getMyProfile } from '../lib/chatService';
import { appendSecurityEvent } from '../services/security/auditChain';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function BreachGuardScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();

  const [monitors, setMonitors] = useState<BreachMonitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [emailInput, setEmailInput] = useState('');
  const [adding, setAdding] = useState(false);

  const [hibpKey, setHibpKey] = useState('');
  const [keyInput, setKeyInput] = useState('');

  const [scanning, setScanning] = useState(false);
  const [results, setResults] = useState<Record<number, Breach[]>>({});

  const [pw, setPw] = useState('');
  const [pwChecking, setPwChecking] = useState(false);
  const [pwResult, setPwResult] = useState<number | null>(null);

  const loadMonitors = useCallback(async () => {
    try { setMonitors(await listMonitors()); }
    catch { /* offline / unauth — leave list as-is */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    loadMonitors();
    SecureStore.getItemAsync('hibp_key').then((v) => { if (v) setHibpKey(v); }).catch(() => {});
    // Pre-fill the user's own email as a suggested first monitor.
    getMyProfile().then((p) => { if (p?.email) setEmailInput(p.email); }).catch(() => {});
  }, [loadMonitors]);

  const saveKey = async () => {
    const k = keyInput.trim();
    if (!k) return;
    await SecureStore.setItemAsync('hibp_key', k);
    setHibpKey(k);
    setKeyInput('');
    Alert.alert('Saved', 'HIBP API key stored securely on this device.');
  };

  const onAdd = async () => {
    const email = emailInput.trim().toLowerCase();
    if (!email.includes('@')) { Alert.alert('Invalid', 'Enter a valid email address'); return; }
    setAdding(true);
    try {
      await addMonitor(email);
      setEmailInput('');
      await loadMonitors();
    } catch (e: any) {
      Alert.alert('Could not add', e?.message ?? 'Try again');
    } finally {
      setAdding(false);
    }
  };

  const onRemove = (m: BreachMonitor) => {
    Alert.alert('Stop monitoring?', m.target, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive',
        onPress: async () => {
          try { await removeMonitor(m.id); await loadMonitors(); }
          catch (e: any) { Alert.alert('Failed', e?.message ?? 'Try again'); }
        },
      },
    ]);
  };

  const scanAll = useCallback(async () => {
    if (scanning) return;
    if (!hibpKey) { Alert.alert('Key required', 'Email breach lookup needs your HIBP API key. Add it above.'); return; }
    if (!monitors.length) { Alert.alert('Nothing to scan', 'Add an email to monitor first.'); return; }

    setScanning(true);
    const next: Record<number, Breach[]> = {};
    let totalBreached = 0;
    try {
      for (const m of monitors) {
        if (m.targetType !== 'email') continue;
        try {
          const breaches = await checkEmailBreaches(m.target, hibpKey);
          next[m.id] = breaches;
          await recordMonitorScan(m.id, breaches.length).catch(() => {});
          if (breaches.length > 0) {
            totalBreached++;
            // Record a real finding in the tamper-evident audit chain (#41).
            await appendSecurityEvent({
              type: 'BREACH',
              severity: breaches.length >= 3 ? 'high' : 'medium',
              title: `${breaches.length} breach${breaches.length === 1 ? '' : 'es'} found for ${m.target}`,
              detail: `Exposed in: ${breaches.map((b) => b.name).join(', ')}`,
              meta: { email: m.target, count: breaches.length, breaches: breaches.map((b) => b.name) },
            }).catch(() => {});
          }
        } catch (e: any) {
          // One target failing (rate limit etc.) shouldn't abort the whole scan.
          if (e?.message?.includes('Invalid HIBP')) { Alert.alert('Invalid key', e.message); break; }
        }
      }
      setResults(next);
      await loadMonitors();
      Alert.alert(
        'Scan complete',
        totalBreached === 0
          ? 'No breaches found for your monitored emails.'
          : `${totalBreached} of your monitored email${totalBreached === 1 ? '' : 's'} appear in known breaches. Tap a row for details.`,
      );
    } finally {
      setScanning(false);
    }
  }, [scanning, hibpKey, monitors, loadMonitors]);

  const showFindings = (m: BreachMonitor) => {
    const found = results[m.id];
    if (!found || found.length === 0) {
      Alert.alert(m.target, m.lastCheckedAt ? 'No breaches found in the last scan.' : 'Not scanned yet.');
      return;
    }
    Alert.alert(
      `${m.target} — ${found.length} breach${found.length === 1 ? '' : 'es'}`,
      found.map((b) => `• ${b.name} (${b.breachDate}) — ${fmtCount(b.pwnCount)} accounts\n  ${b.dataClasses.slice(0, 4).join(', ')}`).join('\n\n'),
    );
  };

  const checkPassword = useCallback(async () => {
    if (!pw) return;
    setPwChecking(true); setPwResult(null);
    try { setPwResult(await checkPasswordPwned(pw)); }
    catch (e: any) { Alert.alert('Error', e?.message ?? 'Check failed'); }
    finally { setPwChecking(false); }
  }, [pw]);

  return (
    <KeyboardAvoidingView style={S.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} style={S.backBtn} hitSlop={10}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={S.title}>Breach Guard</Text>
          <Text style={S.subtitle}>Real Have I Been Pwned monitoring</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
        {/* HIBP key */}
        {!hibpKey ? (
          <View style={S.card}>
            <Text style={S.cardTitle}>HIBP API key required</Text>
            <Text style={S.cardSub}>
              Email breach lookups use the official Have I Been Pwned API, which needs your own key.
              It is stored only on this device and never sent to our servers.
            </Text>
            <TextInput
              style={S.input}
              value={keyInput}
              onChangeText={setKeyInput}
              placeholder="Paste HIBP API key"
              placeholderTextColor={colors.textFaint}
              autoCapitalize="none"
              secureTextEntry
            />
            <TouchableOpacity style={S.primaryBtn} onPress={saveKey}>
              <Text style={S.primaryBtnText}>Save key</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={[S.card, S.keyOkRow]}>
            <Ionicons name="key" size={18} color={colors.success} />
            <Text style={S.keyOkText}>HIBP key set</Text>
            <TouchableOpacity onPress={() => setHibpKey('')}>
              <Text style={S.changeKey}>Change</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Monitored emails */}
        <Text style={S.sectionTitle}>MONITORED EMAILS</Text>
        <View style={S.card}>
          <View style={S.addRow}>
            <TextInput
              style={[S.input, { flex: 1, marginBottom: 0 }]}
              value={emailInput}
              onChangeText={setEmailInput}
              placeholder="email@example.com"
              placeholderTextColor={colors.textFaint}
              autoCapitalize="none"
              keyboardType="email-address"
            />
            <TouchableOpacity style={S.addBtn} onPress={onAdd} disabled={adding}>
              {adding ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="add" size={22} color="#fff" />}
            </TouchableOpacity>
          </View>

          {loading ? (
            <ActivityIndicator color={colors.primary} style={{ marginVertical: 16 }} />
          ) : monitors.length === 0 ? (
            <Text style={S.emptyText}>No emails monitored yet. Add one above to start watching for breaches.</Text>
          ) : (
            monitors.map((m, i) => (
              <View key={m.id}>
                <TouchableOpacity style={S.monitorRow} onPress={() => showFindings(m)} activeOpacity={0.7}>
                  <Ionicons name="mail" size={18} color={colors.textDim} />
                  <View style={{ flex: 1 }}>
                    <Text style={S.monitorEmail} numberOfLines={1}>{m.target}</Text>
                    <Text style={S.monitorMeta}>
                      {m.lastCheckedAt ? `Checked ${new Date(m.lastCheckedAt).toLocaleDateString()}` : 'Not scanned yet'}
                    </Text>
                  </View>
                  {m.breachCount > 0 ? (
                    <View style={S.breachBadge}><Text style={S.breachBadgeText}>{m.breachCount}</Text></View>
                  ) : m.lastCheckedAt ? (
                    <Ionicons name="shield-checkmark" size={18} color={colors.success} />
                  ) : null}
                  <TouchableOpacity onPress={() => onRemove(m)} hitSlop={8} style={{ paddingLeft: 6 }}>
                    <Ionicons name="trash-outline" size={18} color={colors.textFaint} />
                  </TouchableOpacity>
                </TouchableOpacity>
                {i < monitors.length - 1 && <View style={S.divider} />}
              </View>
            ))
          )}
        </View>

        <TouchableOpacity
          style={[S.primaryBtn, S.scanBtn, (scanning || !monitors.length) && S.btnDim]}
          onPress={scanAll}
          disabled={scanning || !monitors.length}
        >
          {scanning
            ? <ActivityIndicator size="small" color="#fff" />
            : <Ionicons name="search" size={18} color="#fff" />}
          <Text style={S.primaryBtnText}>{scanning ? 'Scanning…' : 'Scan monitored emails'}</Text>
        </TouchableOpacity>

        {/* Keyless password check */}
        <Text style={S.sectionTitle}>PASSWORD CHECK (KEYLESS)</Text>
        <View style={S.card}>
          <Text style={S.cardSub}>
            Checks if a password appears in known breaches using k-anonymity — only a partial hash
            leaves the device, never the password.
          </Text>
          <View style={S.addRow}>
            <TextInput
              style={[S.input, { flex: 1, marginBottom: 0 }]}
              value={pw}
              onChangeText={(t) => { setPw(t); setPwResult(null); }}
              placeholder="Enter a password to check"
              placeholderTextColor={colors.textFaint}
              autoCapitalize="none"
              secureTextEntry
            />
            <TouchableOpacity style={S.addBtn} onPress={checkPassword} disabled={pwChecking || !pw}>
              {pwChecking ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="search" size={20} color="#fff" />}
            </TouchableOpacity>
          </View>
          {pwResult != null && (
            <Text style={[S.pwResult, { color: pwResult > 0 ? colors.danger : colors.success }]}>
              {pwResult > 0
                ? `⚠ Found in ${fmtCount(pwResult)} breaches — do not use this password.`
                : '✓ Not found in any known breach.'}
            </Text>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 54, paddingBottom: 14, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: c.border },
  backBtn: { padding: 4 },
  title: { color: c.text, fontSize: 18, fontWeight: '800' },
  subtitle: { color: c.textDim, fontSize: 12, marginTop: 1 },

  sectionTitle: { color: c.textFaint, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginTop: 22, marginBottom: 8, marginLeft: 20 },
  card: { marginHorizontal: 16, marginTop: 12, backgroundColor: c.card, borderRadius: 16, borderWidth: 1, borderColor: c.border, padding: 14 },
  cardTitle: { color: c.text, fontSize: 15, fontWeight: '700', marginBottom: 6 },
  cardSub: { color: c.textDim, fontSize: 12.5, lineHeight: 18, marginBottom: 10 },

  input: { backgroundColor: c.surface, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11, color: c.text, fontSize: 14, borderWidth: 1, borderColor: c.border, marginBottom: 10 },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: c.primary, paddingVertical: 13, borderRadius: 12 },
  primaryBtnText: { color: '#fff', fontWeight: '800', fontSize: 14.5 },
  btnDim: { opacity: 0.45 },
  scanBtn: { marginHorizontal: 16, marginTop: 16 },

  keyOkRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  keyOkText: { color: c.text, fontSize: 14, fontWeight: '600', flex: 1 },
  changeKey: { color: c.primary, fontSize: 13, fontWeight: '700' },

  addRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  addBtn: { width: 44, height: 44, borderRadius: 12, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },

  emptyText: { color: c.textDim, fontSize: 13, lineHeight: 19, paddingVertical: 12, textAlign: 'center' },
  divider: { height: 1, backgroundColor: c.separator, marginVertical: 2 },

  monitorRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  monitorEmail: { color: c.text, fontSize: 14, fontWeight: '600' },
  monitorMeta: { color: c.textFaint, fontSize: 11.5, marginTop: 2 },
  breachBadge: { backgroundColor: c.danger, borderRadius: 11, minWidth: 22, height: 22, paddingHorizontal: 7, alignItems: 'center', justifyContent: 'center' },
  breachBadgeText: { color: '#fff', fontSize: 12, fontWeight: '800' },

  pwResult: { fontSize: 13, fontWeight: '600', marginTop: 12, lineHeight: 18 },
});
