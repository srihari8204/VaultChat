/**
 * app/privacy-dashboard.tsx
 * Privacy Dashboard — security score, feature checklist, privacy controls.
 */

import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Svg, { Circle } from 'react-native-svg';

const C = {
  bg: '#FFFFFF',
  card: '#F9FAFB',
  cardAlt: '#111D32',
  accent: '#4A9FFF',
  cyan: '#4A9FFF',
  green: '#10B981',
  red: '#EF4444',
  orange: '#F59E0B',
  text: '#FFFFFF',
  textDim: 'rgba(255,255,255,0.5)',
  textFaint: 'rgba(255,255,255,0.22)',
  border: 'rgba(74,159,255,0.15)',
};

const TOP = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 44;
const STORAGE_KEY = 'vc_privacy_settings';

type PrivacyLevel = 'everyone' | 'contacts' | 'nobody';

interface PrivacySettings {
  faceLock: boolean;
  pinSet: boolean;
  duressPin: boolean;
  screenshotProtection: boolean;
  biometricLock: boolean;
  twoFactorAuth: boolean;
  trustedContacts: boolean;
  lastSeenHidden: boolean;
  readReceiptsOff: boolean;
  lastSeenPrivacy: PrivacyLevel;
  profilePhotoPrivacy: PrivacyLevel;
  aboutPrivacy: PrivacyLevel;
  onlineStatus: boolean; // true = show, false = hide
  blockedCount: number;
}

const DEFAULT_SETTINGS: PrivacySettings = {
  faceLock: false,
  pinSet: false,
  duressPin: false,
  screenshotProtection: true,
  biometricLock: false,
  twoFactorAuth: false,
  trustedContacts: false,
  lastSeenHidden: false,
  readReceiptsOff: false,
  lastSeenPrivacy: 'everyone',
  profilePhotoPrivacy: 'everyone',
  aboutPrivacy: 'everyone',
  onlineStatus: true,
  blockedCount: 0,
};

interface FeatureItem {
  key: keyof PrivacySettings;
  label: string;
  alwaysOn?: boolean;
  points: number;
  suggestion?: string;
}

const FEATURES: FeatureItem[] = [
  { key: 'screenshotProtection', label: 'E2E Encryption', alwaysOn: true, points: 10 },
  { key: 'faceLock', label: 'Face Lock', points: 10, suggestion: 'Enable Face Lock in Settings for biometric protection.' },
  { key: 'pinSet', label: 'PIN Set', points: 10, suggestion: 'Set a PIN to add a second layer of security.' },
  { key: 'duressPin', label: 'Duress PIN Configured', points: 10, suggestion: 'Set a duress PIN that wipes data if entered under threat.' },
  { key: 'screenshotProtection', label: 'Screenshot Protection', points: 10, suggestion: 'Screenshot protection is already enabled by default.' },
  { key: 'biometricLock', label: 'Biometric Lock', points: 10, suggestion: 'Enable biometric lock for quick secure access.' },
  { key: 'twoFactorAuth', label: '2FA Enabled', points: 10, suggestion: 'Enable two-factor authentication for account recovery.' },
  { key: 'trustedContacts', label: 'Trusted Contacts Set', points: 10, suggestion: 'Designate trusted contacts for account recovery.' },
  { key: 'lastSeenHidden', label: 'Last Seen Hidden', points: 10, suggestion: 'Hide your last seen to protect your activity.' },
  { key: 'readReceiptsOff', label: 'Read Receipts Off', points: 10, suggestion: 'Turn off read receipts for more privacy.' },
];


export default function PrivacyDashboardScreen() {
  const router = useRouter();

  const [settings, setSettings] = useState<PrivacySettings>(DEFAULT_SETTINGS);
  const [, setLoading] = useState(true);

  const fadeIn = useRef(new Animated.Value(0)).current;
  const scoreAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeIn, { toValue: 1, duration: 400, useNativeDriver: true }).start();
    loadSettings();
  }, [fadeIn]);

  const loadSettings = async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) });
      }
    } catch {} finally {
      setLoading(false);
    }
  };

  const saveSettings = async (updated: PrivacySettings) => {
    setSettings(updated);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  };

  // Calculate score
  const calculateScore = (): number => {
    let score = 10; // E2E always on
    if (settings.faceLock) score += 10;
    if (settings.pinSet) score += 10;
    if (settings.duressPin) score += 10;
    if (settings.screenshotProtection) score += 10;
    if (settings.biometricLock) score += 10;
    if (settings.twoFactorAuth) score += 10;
    if (settings.trustedContacts) score += 10;
    if (settings.lastSeenHidden) score += 10;
    if (settings.readReceiptsOff) score += 10;
    return Math.min(score, 100);
  };

  const score = calculateScore();

  useEffect(() => {
    Animated.timing(scoreAnim, { toValue: score, duration: 1200, useNativeDriver: false }).start();
  }, [score, scoreAnim]);

  const getScoreColor = () => {
    if (score >= 80) return C.green;
    if (score >= 50) return C.orange;
    return C.red;
  };

  const isFeatureEnabled = (f: FeatureItem): boolean => {
    if (f.alwaysOn) return true;
    return !!settings[f.key];
  };

  const toggleFeature = (key: keyof PrivacySettings) => {
    const updated = { ...settings, [key]: !settings[key] };
    saveSettings(updated);
  };

  const setPrivacyLevel = (key: 'lastSeenPrivacy' | 'profilePhotoPrivacy' | 'aboutPrivacy', value: PrivacyLevel) => {
    const updated = { ...settings, [key]: value };
    // Also update related boolean flags
    if (key === 'lastSeenPrivacy') {
      updated.lastSeenHidden = value === 'nobody';
    }
    saveSettings(updated);
  };

  const suggestions = FEATURES.filter(f => !isFeatureEnabled(f) && f.suggestion);

  // ── Score Ring ──
  const renderScoreRing = () => {
    const size = 160;
    const strokeWidth = 10;
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const progress = score / 100;

    return (
      <View style={s.scoreContainer}>
        <View style={s.ringWrapper}>
          <Svg width={size} height={size} style={{ transform: [{ rotate: '-90deg' }] }}>
            {/* Background ring */}
            <Circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              stroke="rgba(255,255,255,0.06)"
              strokeWidth={strokeWidth}
              fill="transparent"
            />
            {/* Progress ring */}
            <Circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              stroke={getScoreColor()}
              strokeWidth={strokeWidth}
              fill="transparent"
              strokeDasharray={`${circumference}`}
              strokeDashoffset={circumference * (1 - progress)}
              strokeLinecap="round"
            />
          </Svg>
          <View style={s.scoreTextContainer}>
            <Text style={[s.scoreNumber, { color: getScoreColor() }]}>{score}</Text>
            <Text style={s.scoreLabel}>Security Score</Text>
          </View>
        </View>

        <Text style={s.scoreHint}>
          {score >= 80 ? 'Excellent! Your account is well protected.' :
           score >= 50 ? 'Good, but there\'s room for improvement.' :
           'Your security needs attention. Enable more features below.'}
        </Text>
      </View>
    );
  };

  // ── Feature Checklist ──
  const renderChecklist = () => (
    <View style={s.section}>
      <Text style={s.sectionTitle}>Security Features</Text>
      {FEATURES.map((f, i) => {
        const enabled = isFeatureEnabled(f);
        return (
          <TouchableOpacity
            key={i}
            style={s.checkRow}
            onPress={() => !f.alwaysOn && toggleFeature(f.key)}
            disabled={f.alwaysOn}
          >
            <View style={[s.checkIcon, enabled ? s.checkIconOn : s.checkIconOff]}>
              <Ionicons
                name={enabled ? 'checkmark' : 'close'}
                size={14}
                color={enabled ? '#FFF' : C.textDim}
              />
            </View>
            <Text style={[s.checkLabel, !enabled && { color: C.textDim }]}>{f.label}</Text>
            {f.alwaysOn && (
              <View style={s.alwaysBadge}>
                <Text style={s.alwaysBadgeText}>Always On</Text>
              </View>
            )}
          </TouchableOpacity>
        );
      })}
    </View>
  );

  // ── Privacy Options ──
  const renderPrivacyOption = (
    label: string,
    key: 'lastSeenPrivacy' | 'profilePhotoPrivacy' | 'aboutPrivacy',
    icon: string
  ) => {
    const value = settings[key];
    const options: { label: string; value: PrivacyLevel }[] = [
      { label: 'Everyone', value: 'everyone' },
      { label: 'My Contacts', value: 'contacts' },
      { label: 'Nobody', value: 'nobody' },
    ];

    return (
      <View style={s.privacyRow}>
        <View style={s.privacyLeft}>
          <Ionicons name={icon as any} size={20} color={C.accent} style={{ marginRight: 10 }} />
          <Text style={s.privacyLabel}>{label}</Text>
        </View>
        <View style={s.privacyChips}>
          {options.map(opt => (
            <TouchableOpacity
              key={opt.value}
              style={[s.pChip, value === opt.value && s.pChipActive]}
              onPress={() => setPrivacyLevel(key, opt.value)}
            >
              <Text style={[s.pChipText, value === opt.value && s.pChipTextActive]}>{opt.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    );
  };

  const renderPrivacyControls = () => (
    <View style={s.section}>
      <Text style={s.sectionTitle}>Privacy Controls</Text>
      {renderPrivacyOption('Last Seen', 'lastSeenPrivacy', 'time')}
      {renderPrivacyOption('Profile Photo', 'profilePhotoPrivacy', 'person-circle')}
      {renderPrivacyOption('About', 'aboutPrivacy', 'information-circle')}

      {/* Online status */}
      <View style={s.privacyRow}>
        <View style={s.privacyLeft}>
          <Ionicons name="ellipse" size={20} color={settings.onlineStatus ? C.green : C.textDim} style={{ marginRight: 10 }} />
          <Text style={s.privacyLabel}>Online Status</Text>
        </View>
        <View style={s.privacyChips}>
          <TouchableOpacity
            style={[s.pChip, settings.onlineStatus && s.pChipActive]}
            onPress={() => saveSettings({ ...settings, onlineStatus: true })}
          >
            <Text style={[s.pChipText, settings.onlineStatus && s.pChipTextActive]}>Show</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.pChip, !settings.onlineStatus && s.pChipActive]}
            onPress={() => saveSettings({ ...settings, onlineStatus: false })}
          >
            <Text style={[s.pChipText, !settings.onlineStatus && s.pChipTextActive]}>Hide</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Blocked contacts */}
      <TouchableOpacity style={s.blockedRow} onPress={() => Alert.alert('Blocked Contacts', 'Navigate to blocked contacts management.')}>
        <View style={s.privacyLeft}>
          <Ionicons name="ban" size={20} color={C.red} style={{ marginRight: 10 }} />
          <Text style={s.privacyLabel}>Blocked Contacts</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={s.blockedCount}>{settings.blockedCount}</Text>
          <Text style={s.manageLink}>Manage</Text>
          <Ionicons name="chevron-forward" size={16} color={C.accent} />
        </View>
      </TouchableOpacity>
    </View>
  );

  // ── Suggestions ──
  const renderSuggestions = () => {
    if (suggestions.length === 0) return null;

    return (
      <View style={s.section}>
        <Text style={s.sectionTitle}>Improve Your Score</Text>
        {suggestions.map((f, i) => (
          <View key={i} style={s.suggestionRow}>
            <Ionicons name="arrow-up-circle" size={18} color={C.cyan} style={{ marginRight: 10, marginTop: 1 }} />
            <View style={{ flex: 1 }}>
              <Text style={s.suggestionLabel}>{f.label}</Text>
              <Text style={s.suggestionText}>{f.suggestion}</Text>
            </View>
            <Text style={s.suggestionPoints}>+{f.points}</Text>
          </View>
        ))}
      </View>
    );
  };

  return (
    <View style={s.container}>
      <Stack.Screen options={{ headerShown: false }} />
      <LinearGradient colors={[C.bg, '#F9FAFB', C.bg]} style={StyleSheet.absoluteFill} />

      <Animated.View style={{ flex: 1, opacity: fadeIn }}>
        {/* Header */}
        <View style={s.header}>
          <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
            <Ionicons name="arrow-back" size={24} color={C.text} />
          </TouchableOpacity>
          <Text style={s.headerTitle}>Privacy Dashboard</Text>
          <View style={{ width: 40 }} />
        </View>

        <ScrollView contentContainerStyle={{ paddingBottom: 60 }} showsVerticalScrollIndicator={false}>
          {renderScoreRing()}
          {renderChecklist()}
          {renderPrivacyControls()}
          {renderSuggestions()}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: TOP + 8,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { fontSize: 18, fontWeight: '700', color: C.text },

  // Score ring
  scoreContainer: { alignItems: 'center', marginTop: 12, marginBottom: 8, paddingHorizontal: 24 },
  ringWrapper: { position: 'relative', width: 160, height: 160, justifyContent: 'center', alignItems: 'center' },
  scoreTextContainer: { position: 'absolute', alignItems: 'center' },
  scoreNumber: { fontSize: 42, fontWeight: '800' },
  scoreLabel: { fontSize: 12, color: C.textDim, marginTop: -2 },
  scoreHint: { fontSize: 13, color: C.textDim, textAlign: 'center', marginTop: 12, lineHeight: 20 },

  // Sections
  section: {
    marginHorizontal: 16,
    marginTop: 20,
    backgroundColor: C.card,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: C.border,
  },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: C.text, marginBottom: 12 },

  // Checklist
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
  },
  checkIcon: {
    width: 24,
    height: 24,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  checkIconOn: { backgroundColor: C.green },
  checkIconOff: { backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
  checkLabel: { fontSize: 14, color: C.text, fontWeight: '500', flex: 1 },
  alwaysBadge: {
    backgroundColor: 'rgba(16,185,129,0.15)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  alwaysBadgeText: { fontSize: 10, color: C.green, fontWeight: '700' },

  // Privacy controls
  privacyRow: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
  },
  privacyLeft: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  privacyLabel: { fontSize: 14, color: C.text, fontWeight: '600' },
  privacyChips: { flexDirection: 'row', gap: 6 },
  pChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: C.cardAlt,
    borderWidth: 1,
    borderColor: C.border,
  },
  pChipActive: { backgroundColor: 'rgba(74,159,255,0.15)', borderColor: C.accent },
  pChipText: { fontSize: 12, color: C.textDim, fontWeight: '600' },
  pChipTextActive: { color: C.accent },

  blockedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
  },
  blockedCount: { fontSize: 14, fontWeight: '700', color: C.text, marginRight: 8 },
  manageLink: { fontSize: 13, color: C.accent, fontWeight: '600', marginRight: 4 },

  // Suggestions
  suggestionRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
  },
  suggestionLabel: { fontSize: 13, fontWeight: '600', color: C.text },
  suggestionText: { fontSize: 12, color: C.textDim, marginTop: 2, lineHeight: 18 },
  suggestionPoints: { fontSize: 13, fontWeight: '700', color: C.cyan, marginLeft: 8 },
});
