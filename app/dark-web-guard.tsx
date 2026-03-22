// app/dark-web-guard.tsx
// Dark Web Guard — monitors email for data breaches
// Demo mode: uses realistic mock breach data
// To enable real API: set HIBP_API_KEY below (from haveibeenpwned.com — $3.50/mo)
// Everything else stays the same — just flip USE_REAL_API to true

import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ScrollView, TextInput, Alert, ActivityIndicator,
  Modal,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';

// ─────────────────────────────────────────────────────────────────
// ⚙️  API CONFIG — flip this when you get a HIBP key
// ─────────────────────────────────────────────────────────────────

const USE_REAL_API  = false;                    // ← set true when ready
const HIBP_API_KEY  = 'YOUR_HIBP_KEY_HERE';    // ← paste key here

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

interface Breach {
  name:          string;   // e.g. "Adobe"
  domain:        string;   // e.g. "adobe.com"
  breachDate:    string;   // e.g. "2013-10-04"
  pwnCount:      number;   // accounts exposed
  dataClasses:   string[]; // e.g. ["Passwords","Emails","Names"]
  description:   string;
  isVerified:    boolean;
  isSensitive:   boolean;
  severity:      'critical' | 'high' | 'medium' | 'low';
}

// ─────────────────────────────────────────────────────────────────
// Demo breach data — realistic, looks real in UI
// ─────────────────────────────────────────────────────────────────

const DEMO_BREACHES: Breach[] = [
  {
    name:        'LinkedIn',
    domain:      'linkedin.com',
    breachDate:  '2021-06-22',
    pwnCount:    700000000,
    dataClasses: ['Email addresses', 'Phone numbers', 'Full names', 'Job titles'],
    description: 'In June 2021, data scraped from 700M LinkedIn profiles was posted for sale. The data included emails, phone numbers, and professional info.',
    isVerified:  true,
    isSensitive: false,
    severity:    'critical',
  },
  {
    name:        'Adobe',
    domain:      'adobe.com',
    breachDate:  '2013-10-04',
    pwnCount:    152445165,
    dataClasses: ['Email addresses', 'Password hints', 'Encrypted passwords'],
    description: 'In October 2013, 153 million Adobe accounts were exposed including internal IDs, usernames, salted password hashes and unencrypted password hints.',
    isVerified:  true,
    isSensitive: false,
    severity:    'high',
  },
  {
    name:        'Canva',
    domain:      'canva.com',
    breachDate:  '2019-05-24',
    pwnCount:    137272116,
    dataClasses: ['Email addresses', 'Names', 'Usernames', 'Passwords'],
    description: 'In May 2019, the graphic design tool Canva suffered a data breach exposing 137M records including email addresses, names, and bcrypt hashed passwords.',
    isVerified:  true,
    isSensitive: false,
    severity:    'high',
  },
  {
    name:        'Dropbox',
    domain:      'dropbox.com',
    breachDate:  '2012-07-01',
    pwnCount:    68648009,
    dataClasses: ['Email addresses', 'Passwords'],
    description: 'In mid-2012, Dropbox suffered a data breach which exposed the stored credentials of tens of millions of customers. Passwords were hashed with bcrypt and salted.',
    isVerified:  true,
    isSensitive: false,
    severity:    'medium',
  },
];

// ─────────────────────────────────────────────────────────────────
// Fetch breaches — real or demo
// ─────────────────────────────────────────────────────────────────

async function fetchBreaches(email: string): Promise<Breach[]> {
  if (!USE_REAL_API) {
    // Demo: simulate network delay, return mock data
    await new Promise(r => setTimeout(r, 1800));
    // Return subset based on email to make it feel real
    const count = (email.charCodeAt(0) % 4) + 1;
    return DEMO_BREACHES.slice(0, count);
  }

  // Real HaveIBeenPwned API
  // Returns breach data for the given email address
  const res = await fetch(
    `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=false`,
    {
      headers: {
        'hibp-api-key': HIBP_API_KEY,
        'User-Agent':   'VaultChat-SecurityApp',
      },
    }
  );

  if (res.status === 404) return []; // No breaches found — good!
  if (res.status === 401) throw new Error('Invalid HIBP API key');
  if (res.status === 429) throw new Error('Rate limited — wait 1 minute and try again');
  if (!res.ok) throw new Error(`HIBP API error: ${res.status}`);

  const data = await res.json();

  // Map HIBP response to our Breach type
  return data.map((b: any): Breach => ({
    name:        b.Name,
    domain:      b.Domain,
    breachDate:  b.BreachDate,
    pwnCount:    b.PwnCount,
    dataClasses: b.DataClasses,
    description: b.Description.replace(/<[^>]*>/g, ''), // strip HTML
    isVerified:  b.IsVerified,
    isSensitive: b.IsSensitive,
    severity:
      b.PwnCount > 100_000_000 ? 'critical' :
      b.PwnCount > 10_000_000  ? 'high'     :
      b.PwnCount > 1_000_000   ? 'medium'   : 'low',
  }));
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function severityColor(s: Breach['severity']): string {
  switch (s) {
    case 'critical': return '#FF4D6D';
    case 'high':     return '#F97316';
    case 'medium':   return '#F5C842';
    case 'low':      return '#00D4AA';
  }
}

function severityLabel(s: Breach['severity']): string {
  switch (s) {
    case 'critical': return '🔴 CRITICAL';
    case 'high':     return '🟠 HIGH';
    case 'medium':   return '🟡 MEDIUM';
    case 'low':      return '🟢 LOW';
  }
}

function formatCount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)         return `${(n / 1_000).toFixed(0)}K`;
  return n.toString();
}

// ─────────────────────────────────────────────────────────────────
// Breach Detail Modal
// ─────────────────────────────────────────────────────────────────

function BreachDetail({
  breach,
  onClose,
}: {
  breach: Breach;
  onClose: () => void;
}) {
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity
        style={detailStyles.overlay}
        activeOpacity={1}
        onPress={onClose}
      >
        <View style={detailStyles.panel}>
          <View style={detailStyles.handle} />

          {/* Title */}
          <View style={detailStyles.titleRow}>
            <View style={detailStyles.domainCircle}>
              <Text style={detailStyles.domainInitial}>
                {breach.name[0]}
              </Text>
            </View>
            <View>
              <Text style={detailStyles.breachName}>{breach.name}</Text>
              <Text style={detailStyles.breachDomain}>{breach.domain}</Text>
            </View>
            <View style={[detailStyles.severityPill,
              { backgroundColor: severityColor(breach.severity) + '22',
                borderColor: severityColor(breach.severity) + '66' }]}>
              <Text style={[detailStyles.severityPillText,
                { color: severityColor(breach.severity) }]}>
                {severityLabel(breach.severity)}
              </Text>
            </View>
          </View>

          {/* Stats */}
          <View style={detailStyles.statsRow}>
            <View style={detailStyles.stat}>
              <Text style={detailStyles.statNum}>{formatCount(breach.pwnCount)}</Text>
              <Text style={detailStyles.statLabel}>Accounts Exposed</Text>
            </View>
            <View style={detailStyles.statDiv} />
            <View style={detailStyles.stat}>
              <Text style={detailStyles.statNum}>{breach.breachDate.slice(0, 4)}</Text>
              <Text style={detailStyles.statLabel}>Breach Year</Text>
            </View>
            <View style={detailStyles.statDiv} />
            <View style={detailStyles.stat}>
              <Text style={detailStyles.statNum}>{breach.dataClasses.length}</Text>
              <Text style={detailStyles.statLabel}>Data Types</Text>
            </View>
          </View>

          {/* Exposed data types */}
          <Text style={detailStyles.sectionLabel}>EXPOSED DATA</Text>
          <View style={detailStyles.tagsWrap}>
            {breach.dataClasses.map(dc => (
              <View key={dc} style={detailStyles.tag}>
                <Text style={detailStyles.tagText}>{dc}</Text>
              </View>
            ))}
          </View>

          {/* Description */}
          <Text style={detailStyles.sectionLabel}>WHAT HAPPENED</Text>
          <Text style={detailStyles.description}>{breach.description}</Text>

          {/* Actions */}
          <Text style={detailStyles.sectionLabel}>RECOMMENDED ACTIONS</Text>
          {[
            '🔑 Change your password on this service immediately',
            '🔐 Enable two-factor authentication',
            '📧 Check if same password used elsewhere',
            '🚫 Monitor for suspicious login activity',
          ].map(a => (
            <Text key={a} style={detailStyles.action}>{a}</Text>
          ))}

          <TouchableOpacity style={detailStyles.closeBtn} onPress={onClose}>
            <Text style={detailStyles.closeBtnText}>Close</Text>
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────
// Main Screen
// ─────────────────────────────────────────────────────────────────

export default function DarkWebGuardScreen() {
  const router = useRouter();
  const uid    = auth().currentUser?.uid || '';

  const [email,        setEmail]        = useState('');
  const [scanning,     setScanning]     = useState(false);
  const [scanned,      setScanned]      = useState(false);
  const [breaches,     setBreaches]     = useState<Breach[]>([]);
  const [selectedBreach, setSelectedBreach] = useState<Breach | null>(null);
  const [lastScanned,  setLastScanned]  = useState<string | null>(null);
  const [savedEmails,  setSavedEmails]  = useState<string[]>([]);

  // ── Load saved emails + last scan time ───────────────────────
  useEffect(() => {
    SecureStore.getItemAsync('dwg_last_scan').then(v => { if (v) setLastScanned(v); });
    SecureStore.getItemAsync('dwg_emails').then(v => {
      if (v) setSavedEmails(JSON.parse(v));
    });
    // Pre-fill with Firebase Auth email if available
    const authEmail = auth().currentUser?.email;
    if (authEmail) setEmail(authEmail);
  }, []);

  // ── Scan email ────────────────────────────────────────────────
  const handleScan = async () => {
    if (!email.trim() || !email.includes('@')) {
      Alert.alert('Invalid Email', 'Enter a valid email address to scan');
      return;
    }

    setScanning(true);
    setScanned(false);
    setBreaches([]);

    try {
      const results = await fetchBreaches(email.trim().toLowerCase());
      setBreaches(results);
      setScanned(true);

      // Save scan timestamp
      const now = new Date().toLocaleDateString([], {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
      await SecureStore.setItemAsync('dwg_last_scan', now);
      setLastScanned(now);

      // Save email to monitored list
      if (!savedEmails.includes(email.trim())) {
        const updated = [...savedEmails, email.trim()];
        setSavedEmails(updated);
        await SecureStore.setItemAsync('dwg_emails', JSON.stringify(updated));
      }

      // Log scan to Firestore for alert history
      if (results.length > 0) {
        await firestore()
          .collection('users').doc(uid)
          .collection('alerts')
          .add({
            type:      'breach',
            message:   `${results.length} breach${results.length > 1 ? 'es' : ''} found for ${email}`,
            detail:    results.map(b => b.name).join(', '),
            severity:  results.some(b => b.severity === 'critical') ? 'high' : 'medium',
            createdAt: firestore.FieldValue.serverTimestamp(),
            read:      false,
          })
          .catch(() => {});
      }
    } catch (e: any) {
      Alert.alert('Scan Failed', e.message || 'Could not complete scan');
    } finally {
      setScanning(false);
    }
  };

  // ─────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.back}>‹</Text>
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Dark Web Guard</Text>
          <Text style={styles.headerSub}>
            {USE_REAL_API ? 'LIVE · HIBP API' : 'DEMO MODE'}
          </Text>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero */}
        <View style={styles.hero}>
          <Text style={styles.heroIcon}>🌑</Text>
          <Text style={styles.heroTitle}>Dark Web Monitor</Text>
          <Text style={styles.heroSub}>
            Check if your email has appeared in known data breaches across the dark web
          </Text>
          {!USE_REAL_API && (
            <View style={styles.demoBanner}>
              <Text style={styles.demoBannerText}>
                📋 Demo mode — showing sample breach data
              </Text>
            </View>
          )}
        </View>

        {/* Scan input */}
        <View style={styles.scanCard}>
          <Text style={styles.scanLabel}>Email to scan</Text>
          <View style={styles.scanRow}>
            <TextInput
              style={styles.scanInput}
              value={email}
              onChangeText={setEmail}
              placeholder="your@email.com"
              placeholderTextColor="#374151"
              keyboardType="email-address"
              autoCapitalize="none"
              editable={!scanning}
            />
            <TouchableOpacity
              style={[styles.scanBtn, scanning && styles.scanBtnDim]}
              onPress={handleScan}
              disabled={scanning}
            >
              {scanning
                ? <ActivityIndicator color="#0A0E1A" size="small" />
                : <Text style={styles.scanBtnText}>Scan</Text>
              }
            </TouchableOpacity>
          </View>
          {lastScanned && (
            <Text style={styles.lastScanned}>Last scan: {lastScanned}</Text>
          )}
        </View>

        {/* Scanning animation */}
        {scanning && (
          <View style={styles.scanningWrap}>
            <ActivityIndicator color="#00D4AA" size="large" />
            <Text style={styles.scanningText}>Scanning dark web databases...</Text>
            <Text style={styles.scanningHint}>Checking 12+ billion compromised accounts</Text>
          </View>
        )}

        {/* Results */}
        {scanned && (
          <>
            {/* Summary */}
            <View style={[
              styles.summaryCard,
              breaches.length === 0 ? styles.summaryClean : styles.summaryBreached,
            ]}>
              <Text style={styles.summaryIcon}>
                {breaches.length === 0 ? '✅' : '⚠️'}
              </Text>
              <Text style={styles.summaryTitle}>
                {breaches.length === 0
                  ? 'No breaches found!'
                  : `${breaches.length} breach${breaches.length > 1 ? 'es' : ''} found`}
              </Text>
              <Text style={styles.summarySub}>
                {breaches.length === 0
                  ? `${email} was not found in any known data breaches.`
                  : `${email} appeared in ${breaches.length} known data breach${breaches.length > 1 ? 'es' : ''}.`}
              </Text>
            </View>

            {/* Breach list */}
            {breaches.length > 0 && (
              <>
                <Text style={styles.sectionLabel}>BREACHES FOUND</Text>
                {breaches.map(breach => (
                  <TouchableOpacity
                    key={breach.name}
                    style={styles.breachCard}
                    onPress={() => setSelectedBreach(breach)}
                    activeOpacity={0.8}
                  >
                    {/* Severity left bar */}
                    <View style={[styles.severityBar,
                      { backgroundColor: severityColor(breach.severity) }]} />

                    <View style={styles.breachCircle}>
                      <Text style={styles.breachInitial}>{breach.name[0]}</Text>
                    </View>

                    <View style={styles.breachInfo}>
                      <View style={styles.breachTop}>
                        <Text style={styles.breachName}>{breach.name}</Text>
                        <Text style={[styles.breachSeverity,
                          { color: severityColor(breach.severity) }]}>
                          {severityLabel(breach.severity)}
                        </Text>
                      </View>
                      <Text style={styles.breachMeta}>
                        {formatCount(breach.pwnCount)} accounts · {breach.breachDate.slice(0, 4)}
                      </Text>
                      <View style={styles.tagsRow}>
                        {breach.dataClasses.slice(0, 3).map(dc => (
                          <View key={dc} style={styles.miniTag}>
                            <Text style={styles.miniTagText}>{dc}</Text>
                          </View>
                        ))}
                        {breach.dataClasses.length > 3 && (
                          <Text style={styles.moreTag}>
                            +{breach.dataClasses.length - 3}
                          </Text>
                        )}
                      </View>
                    </View>

                    <Text style={styles.chevron}>›</Text>
                  </TouchableOpacity>
                ))}

                {/* Action recommendations */}
                <View style={styles.actionsCard}>
                  <Text style={styles.actionsTitle}>🛡️ Immediate Actions</Text>
                  {[
                    '1. Change passwords on all breached services',
                    '2. Enable 2FA everywhere possible',
                    '3. Check if you used the same password elsewhere',
                    '4. Monitor your accounts for suspicious activity',
                    '5. Consider a password manager',
                  ].map(a => (
                    <Text key={a} style={styles.actionText}>{a}</Text>
                  ))}
                </View>
              </>
            )}
          </>
        )}

        {/* Monitored emails */}
        {savedEmails.length > 0 && !scanned && (
          <>
            <Text style={styles.sectionLabel}>MONITORED EMAILS</Text>
            {savedEmails.map(e => (
              <TouchableOpacity
                key={e}
                style={styles.monitoredRow}
                onPress={() => { setEmail(e); }}
              >
                <Text style={styles.monitoredEmail}>{e}</Text>
                <Text style={styles.monitoredRescan}>Re-scan ›</Text>
              </TouchableOpacity>
            ))}
          </>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Breach detail modal */}
      {selectedBreach && (
        <BreachDetail
          breach={selectedBreach}
          onClose={() => setSelectedBreach(null)}
        />
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: '#0A0E1A' },
  header: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#111827',
    paddingTop: 48, paddingBottom: 12, paddingHorizontal: 16,
    borderBottomWidth: 0.5, borderBottomColor: '#1E293B', gap: 12,
  },
  back:         { fontSize: 28, color: '#00D4AA', fontWeight: 'bold' },
  headerCenter: { flex: 1 },
  headerTitle:  { fontSize: 18, fontWeight: 'bold', color: '#000000' },
  headerSub:    { fontSize: 9, color: '#00D4AA', marginTop: 1, fontWeight: 'bold' },

  scroll:       { flex: 1 },
  scrollContent:{ padding: 16, paddingBottom: 60 },

  // Hero
  hero: { alignItems: 'center', paddingVertical: 24 },
  heroIcon:  { fontSize: 56, marginBottom: 12 },
  heroTitle: { fontSize: 22, fontWeight: 'bold', color: '#000000', marginBottom: 8 },
  heroSub: {
    fontSize: 13, color: '#64748B', textAlign: 'center',
    lineHeight: 20, paddingHorizontal: 16, marginBottom: 12,
  },
  demoBanner: {
    backgroundColor: '#F5C84222', borderRadius: 8,
    borderWidth: 0.5, borderColor: '#F5C84244',
    paddingHorizontal: 14, paddingVertical: 6,
  },
  demoBannerText: { fontSize: 11, color: '#F5C842' },

  // Scan card
  scanCard: {
    backgroundColor: '#111827', borderRadius: 14,
    borderWidth: 0.5, borderColor: '#1E293B',
    padding: 16, marginBottom: 20,
  },
  scanLabel:  { fontSize: 11, color: '#64748B', marginBottom: 8 },
  scanRow:    { flexDirection: 'row', gap: 10 },
  scanInput: {
    flex: 1, backgroundColor: '#1A2235',
    borderRadius: 10, borderWidth: 0.5, borderColor: '#1E293B',
    paddingHorizontal: 14, paddingVertical: 11,
    color: '#000000', fontSize: 14,
  },
  scanBtn: {
    backgroundColor: '#00D4AA', borderRadius: 10,
    paddingHorizontal: 18, justifyContent: 'center', alignItems: 'center',
    minWidth: 70,
  },
  scanBtnDim:  { backgroundColor: '#003328' },
  scanBtnText: { color: '#0A0E1A', fontWeight: 'bold', fontSize: 14 },
  lastScanned: { fontSize: 10, color: '#374151', marginTop: 8 },

  // Scanning
  scanningWrap: {
    alignItems: 'center', paddingVertical: 32, gap: 10,
  },
  scanningText: { fontSize: 14, color: '#000000', fontWeight: 'bold' },
  scanningHint: { fontSize: 11, color: '#374151' },

  // Summary
  summaryCard: {
    borderRadius: 14, borderWidth: 0.5,
    padding: 20, alignItems: 'center', marginBottom: 20, gap: 8,
  },
  summaryClean:    { backgroundColor: '#00332820', borderColor: '#00D4AA44' },
  summaryBreached: { backgroundColor: '#FF4D6D11', borderColor: '#FF4D6D44' },
  summaryIcon:     { fontSize: 40 },
  summaryTitle:    { fontSize: 18, fontWeight: 'bold', color: '#000000' },
  summarySub:      { fontSize: 13, color: '#64748B', textAlign: 'center', lineHeight: 19 },

  sectionLabel: {
    fontSize: 10, fontWeight: 'bold', color: '#374151',
    letterSpacing: 0.8, marginBottom: 10, marginTop: 4,
  },

  // Breach card
  breachCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#111827', borderRadius: 12,
    borderWidth: 0.5, borderColor: '#1E293B',
    padding: 12, marginBottom: 8, gap: 10,
    overflow: 'hidden',
  },
  severityBar:   { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
  breachCircle: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: '#1A2235', borderWidth: 1, borderColor: '#1E293B',
    justifyContent: 'center', alignItems: 'center',
  },
  breachInitial: { fontSize: 18, fontWeight: 'bold', color: '#64748B' },
  breachInfo:    { flex: 1 },
  breachTop: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', marginBottom: 3,
  },
  breachName:     { fontSize: 15, fontWeight: 'bold', color: '#000000' },
  breachSeverity: { fontSize: 10, fontWeight: 'bold' },
  breachMeta:     { fontSize: 11, color: '#374151', marginBottom: 6 },
  tagsRow:        { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  miniTag: {
    backgroundColor: '#1A2235', borderRadius: 6,
    paddingHorizontal: 6, paddingVertical: 2,
    borderWidth: 0.5, borderColor: '#1E293B',
  },
  miniTagText:   { fontSize: 9, color: '#64748B' },
  moreTag:       { fontSize: 10, color: '#374151', alignSelf: 'center' },
  chevron:       { fontSize: 20, color: '#374151' },

  // Actions card
  actionsCard: {
    backgroundColor: '#111827', borderRadius: 12,
    borderWidth: 0.5, borderColor: '#1E293B',
    padding: 16, marginTop: 12, gap: 8,
  },
  actionsTitle: { fontSize: 13, fontWeight: 'bold', color: '#000000', marginBottom: 4 },
  actionText:   { fontSize: 13, color: '#64748B', lineHeight: 20 },

  // Monitored emails
  monitoredRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: '#111827', borderRadius: 10,
    borderWidth: 0.5, borderColor: '#1E293B',
    paddingHorizontal: 14, paddingVertical: 12, marginBottom: 8,
  },
  monitoredEmail:  { fontSize: 14, color: '#000000' },
  monitoredRescan: { fontSize: 12, color: '#00D4AA' },
});

const detailStyles = StyleSheet.create({
  overlay:  { flex: 1, backgroundColor: '#00000088', justifyContent: 'flex-end' },
  panel: {
    backgroundColor: '#111827',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 20, paddingBottom: 36, maxHeight: '90%',
  },
  handle: {
    width: 40, height: 4, backgroundColor: '#1E293B',
    borderRadius: 2, alignSelf: 'center', marginBottom: 16,
  },
  titleRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16,
  },
  domainCircle: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: '#1A2235', borderWidth: 1, borderColor: '#1E293B',
    justifyContent: 'center', alignItems: 'center',
  },
  domainInitial: { fontSize: 20, fontWeight: 'bold', color: '#64748B' },
  breachName:    { fontSize: 17, fontWeight: 'bold', color: '#000000' },
  breachDomain:  { fontSize: 12, color: '#374151' },
  severityPill: {
    marginLeft: 'auto', borderRadius: 10,
    borderWidth: 0.5, paddingHorizontal: 8, paddingVertical: 3,
  },
  severityPillText: { fontSize: 10, fontWeight: 'bold' },
  statsRow: {
    flexDirection: 'row', backgroundColor: '#1A2235',
    borderRadius: 12, padding: 14, marginBottom: 16,
  },
  stat:      { flex: 1, alignItems: 'center' },
  statNum:   { fontSize: 16, fontWeight: 'bold', color: '#000000', marginBottom: 2 },
  statLabel: { fontSize: 10, color: '#374151' },
  statDiv:   { width: 0.5, backgroundColor: '#1E293B', marginVertical: 4 },
  sectionLabel: {
    fontSize: 10, fontWeight: 'bold', color: '#374151',
    letterSpacing: 0.8, marginBottom: 8, marginTop: 12,
  },
  tagsWrap:  { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 4 },
  tag: {
    backgroundColor: '#1A2235', borderRadius: 8,
    borderWidth: 0.5, borderColor: '#1E293B',
    paddingHorizontal: 10, paddingVertical: 4,
  },
  tagText:     { fontSize: 12, color: '#000000' },
  description: { fontSize: 13, color: '#64748B', lineHeight: 20, marginBottom: 4 },
  action:      { fontSize: 13, color: '#64748B', lineHeight: 22 },
  closeBtn: {
    backgroundColor: '#1A2235', borderRadius: 10,
    borderWidth: 0.5, borderColor: '#1E293B',
    paddingVertical: 13, alignItems: 'center', marginTop: 16,
  },
  closeBtnText: { color: '#000000', fontWeight: 'bold', fontSize: 15 },
});
