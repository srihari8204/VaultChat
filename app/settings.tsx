import { ErrorBoundary } from '../components/ErrorBoundary';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
    Alert,
    ScrollView,
    StyleSheet,
    Switch,
    Text,
    TouchableOpacity,
    View
} from 'react-native';

function SettingsScreenContent() {
  const router = useRouter();

  const [screenshotBlock, setScreenshotBlock] = useState(true);
  const [deepfakeShield, setDeepfakeShield]   = useState(true);
  const [emergencyVault, setEmergencyVault]   = useState(true);
  const [voiceCloak, setVoiceCloak]           = useState(false);
  const [hideTimer, setHideTimer]             = useState(true);
  const [hideTimerDuration, setHideTimerDuration] = useState('30 min');
  const [notifications, setNotifications]     = useState(true);
  const [readReceipts, setReadReceipts]       = useState(true);
  const [onlineStatus, setOnlineStatus]       = useState(true);
  const [darkWeb, setDarkWeb]                 = useState(true);

  const TIMER_OPTIONS = ['5 min', '15 min', '30 min', '1 hour', 'Never'];

  const showTimerPicker = () => {
    Alert.alert(
      '⏱️ HideTimer Duration',
      'Chats blur after this much inactivity',
      [
        ...TIMER_OPTIONS.map(opt => ({
          text: opt === hideTimerDuration ? `✅ ${opt}` : opt,
          onPress: () => setHideTimerDuration(opt),
        })),
        { text: 'Cancel', style: 'cancel' as const },
      ]
    );
  };

  // ── Reusable toggle row ────────────────────────────────────────
  const SettingRow = ({
    icon, title, subtitle, value, onToggle, danger = false,
  }: {
    icon: string; title: string; subtitle?: string;
    value: boolean; onToggle: () => void; danger?: boolean;
  }) => (
    <View style={styles.settingRow}>
      <View style={styles.settingLeft}>
        <View style={[styles.settingIconBox, danger && styles.settingIconBoxDanger]}>
          <Text style={styles.settingIcon}>{icon}</Text>
        </View>
        <View style={styles.settingInfo}>
          <Text style={[styles.settingTitle, danger && styles.settingTitleDanger]}>
            {title}
          </Text>
          {subtitle ? <Text style={styles.settingSubtitle}>{subtitle}</Text> : null}
        </View>
      </View>
      <Switch
        value={value}
        onValueChange={onToggle}
        trackColor={{ false: '#1E293B', true: '#1D4ED8' }}
        thumbColor={value ? '#FFFFFF' : '#475569'}
      />
    </View>
  );

  // ── Reusable action row (tap → navigate or alert) ──────────────
  const ActionRow = ({
    icon, title, subtitle, value, onPress, color,
  }: {
    icon: string; title: string; subtitle?: string;
    value?: string; onPress: () => void; color?: string;
  }) => (
    <TouchableOpacity style={styles.settingRow} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.settingLeft}>
        <View style={styles.settingIconBox}>
          <Text style={styles.settingIcon}>{icon}</Text>
        </View>
        <View style={styles.settingInfo}>
          <Text style={[styles.settingTitle, color ? { color } : null]}>{title}</Text>
          {subtitle ? <Text style={styles.settingSubtitle}>{subtitle}</Text> : null}
        </View>
      </View>
      <View style={styles.actionRight}>
        {value ? <Text style={styles.actionValue}>{value}</Text> : null}
        <Text style={styles.chevron}>›</Text>
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>

      {/* ── HEADER ───────────────────────────────────────── */}
      <LinearGradient colors={['#030A18', '#050D1F']} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backArrow}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>⚙️ Settings</Text>
        <View style={{ width: 40 }} />
      </LinearGradient>

      <ScrollView showsVerticalScrollIndicator={false}>

        {/* ── SECURITY SCORE CARD ──────────────────────── */}
        <LinearGradient
          colors={['#1D4ED8', '#7C3AED']}
          style={styles.scoreCard}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
        >
          <View style={styles.scoreLeft}>
            <Text style={styles.scoreTitle}>🛡️ Security Score</Text>
            <Text style={styles.scoreSubtitle}>Your account protection level</Text>
            <View style={styles.scoreBarBg}>
              <View style={[styles.scoreBarFill, { width: voiceCloak ? '100%' : '94%' }]} />
            </View>
            <Text style={styles.scoreNote}>
              {voiceCloak ? '🏆 Perfect! Maximum protection enabled!' : 'Excellent · Turn on VoiceCloak for 100%'}
            </Text>
          </View>
          <View style={styles.scoreRight}>
            <Text style={styles.scoreNumber}>{voiceCloak ? '100' : '94'}</Text>
            <Text style={styles.scoreMax}>/100</Text>
          </View>
        </LinearGradient>

        {/* ── PRIVACY ──────────────────────────────────── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>🔒 PRIVACY</Text>
          <View style={styles.card}>
            <SettingRow
              icon="📵" title="Screenshot Block"
              subtitle="Prevents screenshots in all chats"
              value={screenshotBlock}
              onToggle={() => {
                setScreenshotBlock(v => !v);
                Alert.alert(
                  screenshotBlock ? '📵 Screenshot Block OFF' : '📵 Screenshot Block ON',
                  screenshotBlock
                    ? 'Screenshots are now allowed. Not recommended!'
                    : 'Screenshots are now blocked in all chats!'
                );
              }}
            />
            <View style={styles.divider} />
            <SettingRow
              icon="👁️" title="Online Status"
              subtitle="Show when you are active"
              value={onlineStatus}
              onToggle={() => setOnlineStatus(v => !v)}
            />
            <View style={styles.divider} />
            <SettingRow
              icon="✓✓" title="Read Receipts"
              subtitle="Show when you have read messages"
              value={readReceipts}
              onToggle={() => setReadReceipts(v => !v)}
            />
          </View>
        </View>

        {/* ── WORLD-FIRST SECURITY ─────────────────────── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>🏆 WORLD-FIRST SECURITY</Text>
          <View style={styles.card}>
            <SettingRow
              icon="🎭" title="DeepFake Shield"
              subtitle="AI detects fake faces on video calls"
              value={deepfakeShield}
              onToggle={() => setDeepfakeShield(v => !v)}
            />
            <View style={styles.divider} />
            <SettingRow
              icon="🎤" title="VoiceCloak"
              subtitle="Anonymize your voice on calls"
              value={voiceCloak}
              onToggle={() => {
                const next = !voiceCloak;
                setVoiceCloak(next);
                Alert.alert(
                  next ? '🎭 VoiceCloak ON!' : '🎤 VoiceCloak OFF',
                  next
                    ? 'Your voice will be anonymized on all calls! Security score: 100 🏆'
                    : 'Your real voice is restored.'
                );
              }}
            />
            <View style={styles.divider} />
            <SettingRow
              icon="🆘" title="EmergencyVault"
              subtitle="Shake phone 3 times to hide private chats"
              value={emergencyVault}
              onToggle={() => setEmergencyVault(v => !v)}
            />
            <View style={styles.divider} />
            <SettingRow
              icon="🌐" title="Dark Web BreachGuard"
              subtitle="Alert if your number leaks online"
              value={darkWeb}
              onToggle={() => setDarkWeb(v => !v)}
            />
          </View>
        </View>

        {/* ── HIDETIMER ────────────────────────────────── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>⏱️ HIDETIMER</Text>
          <View style={styles.card}>
            <SettingRow
              icon="⏱️" title="HideTimer"
              subtitle="Blur chats after inactivity"
              value={hideTimer}
              onToggle={() => setHideTimer(v => !v)}
            />
            <View style={styles.divider} />
            <ActionRow
              icon="🕐" title="Auto-Blur After"
              subtitle="How long before chats blur"
              value={hideTimerDuration}
              onPress={showTimerPicker}
            />
          </View>
        </View>

        {/* ── NOTIFICATIONS ────────────────────────────── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>🔔 NOTIFICATIONS</Text>
          <View style={styles.card}>
            <SettingRow
              icon="🔔" title="Push Notifications"
              subtitle="New message alerts"
              value={notifications}
              onToggle={() => setNotifications(v => !v)}
            />
          </View>
        </View>

        {/* ── VAULTID & ACCOUNT ────────────────────────── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>⛓️ VAULTID & ACCOUNT</Text>
          <View style={styles.card}>
            <ActionRow
              icon="⛓️" title="My VaultID"
              subtitle="vault:0x4f2b...9a1d · Verified"
              onPress={() => Alert.alert(
                'My VaultID',
                'vault:0x4f2b9a1d3c8e2f7b\n\nVerified on blockchain ✅'
              )}
            />
            <View style={styles.divider} />
            <ActionRow
              icon="👤" title="Face Scan"
              subtitle="Enrolled ✅ · 468-point mapping"
              onPress={() => Alert.alert('Face Scan', 'Re-enroll?', [
                { text: 'Re-enroll', onPress: () => router.push('/facescan' as any) },
                { text: 'Cancel', style: 'cancel' },
              ])}
            />
            <View style={styles.divider} />
            <ActionRow
              icon="🔑" title="Change PIN"
              subtitle="App lock PIN"
              onPress={() => Alert.alert('PIN', 'PIN change coming soon!')}
            />
          </View>
        </View>

        {/* ── ABOUT ────────────────────────────────────── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>ℹ️ ABOUT</Text>
          <View style={styles.card}>
            <ActionRow
              icon="📱" title="App Version"
              value="1.0.0 Beta"
              onPress={() => Alert.alert('VaultChat v1.0.0', 'Built with ❤️ for privacy')}
            />
            <View style={styles.divider} />
            <ActionRow
              icon="📋" title="Privacy Policy"
              onPress={() => Alert.alert('Privacy Policy', 'We collect ZERO data. No ads. No tracking. Ever.')}
            />
            <View style={styles.divider} />
            <ActionRow
              icon="💬" title="Send Feedback"
              onPress={() => Alert.alert('Feedback', 'Thank you! Feedback form coming soon.')}
            />
          </View>
        </View>

        {/* ── DANGER ZONE ──────────────────────────────── */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: '#EF4444' }]}>⚠️ DANGER ZONE</Text>
          <View style={[styles.card, styles.dangerCard]}>
            <ActionRow
              icon="🗑️" title="Delete All Chats"
              subtitle="Permanently delete all messages"
              color="#EF4444"
              onPress={() => Alert.alert(
                '🗑️ Delete All Chats',
                'This will permanently delete ALL your messages. Cannot be undone!',
                [
                  { text: 'Delete Everything', style: 'destructive',
                    onPress: () => Alert.alert('✅ Done', 'All chats deleted!') },
                  { text: 'Cancel', style: 'cancel' },
                ]
              )}
            />
            <View style={styles.divider} />
            <ActionRow
              icon="🚪" title="Log Out"
              subtitle="Sign out of your account"
              color="#EF4444"
              onPress={() => Alert.alert(
                '🚪 Log Out',
                'Are you sure you want to log out?',
                [
                  { text: 'Log Out', style: 'destructive',
                    onPress: () => router.replace('/' as any) },
                  { text: 'Cancel', style: 'cancel' },
                ]
              )}
            />
          </View>
        </View>

        {/* ── BOTTOM CREDIT ────────────────────────────── */}
        <View style={styles.bottomCredit}>
          <Text style={styles.creditEmoji}>🛡️</Text>
          <Text style={styles.creditText}>VaultChat · Privacy First · Always</Text>
          <Text style={styles.creditSub}>Zero data collected · No ads · No tracking</Text>
        </View>

        <View style={{ height: 50 }} />
      </ScrollView>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#030A18' },

  // HEADER
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 54,
    paddingBottom: 14,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#0D1E3A',
  },
  backBtn: { padding: 6, width: 40 },
  backArrow: { color: '#4A9FFF', fontSize: 26, fontWeight: '300' },
  headerTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: '800' },

  // SCORE CARD
  scoreCard: {
    margin: 16,
    borderRadius: 20,
    padding: 20,
    flexDirection: 'row',
    alignItems: 'center',
    elevation: 10,
    shadowColor: '#1D4ED8',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
  },
  scoreLeft: { flex: 1, gap: 6 },
  scoreTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },
  scoreSubtitle: { color: 'rgba(255,255,255,0.7)', fontSize: 12 },
  scoreBarBg: {
    height: 6,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 3,
    marginTop: 4,
  },
  scoreBarFill: {
    height: 6,
    backgroundColor: '#FFFFFF',
    borderRadius: 3,
  },
  scoreNote: { color: 'rgba(255,255,255,0.6)', fontSize: 11 },
  scoreRight: { alignItems: 'center', marginLeft: 16 },
  scoreNumber: { color: '#FFFFFF', fontSize: 48, fontWeight: '900', lineHeight: 54 },
  scoreMax: { color: 'rgba(255,255,255,0.6)', fontSize: 14 },

  // SECTIONS
  section: { marginHorizontal: 16, marginBottom: 20 },
  sectionTitle: {
    color: '#2D4A6B',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
    marginBottom: 8,
    marginLeft: 4,
  },
  card: {
    backgroundColor: '#0A1628',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#0D1E3A',
    overflow: 'hidden',
  },
  dangerCard: {
    borderColor: '#EF444430',
    backgroundColor: '#0F0A0A',
  },
  divider: {
    height: 1,
    backgroundColor: '#0D1E3A',
    marginLeft: 60,
  },

  // SETTING ROW
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  settingLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 12,
  },
  settingIconBox: {
    width: 36,
    height: 36,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0D1E3A',
  },
  settingIconBoxDanger: {
    backgroundColor: '#2A0A0A',
  },
  settingIcon: { fontSize: 18 },
  settingInfo: { flex: 1 },
  settingTitle: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
  settingTitleDanger: { color: '#EF4444' },
  settingSubtitle: { color: '#3D5A7A', fontSize: 11, marginTop: 2 },

  // ACTION ROW
  actionRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  actionValue: { color: '#4A9FFF', fontSize: 13, fontWeight: '600' },
  chevron: { color: '#2D4A6B', fontSize: 22 },

  // BOTTOM CREDIT
  bottomCredit: {
    alignItems: 'center',
    paddingVertical: 24,
    gap: 4,
  },
  creditEmoji: { fontSize: 28 },
  creditText: { color: '#2D4A6B', fontSize: 13, fontWeight: '600' },
  creditSub: { color: '#1A2E44', fontSize: 11 },
});

export default function SettingsScreen() {
  return (
    <ErrorBoundary fallbackTitle="Settings Error" fallbackMessage="Settings had a problem. Your data is safe.">
      <SettingsScreenContent />
    </ErrorBoundary>
  );
}
