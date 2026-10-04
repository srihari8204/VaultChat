/**
 * app/privacy-dashboard.tsx
 * Privacy Dashboard — a score, a checklist and two privacy controls, all read
 * from where the app really keeps them.
 *
 * 2026-10-04: the checklist used to be AsyncStorage flags (Face Lock, Biometric
 * Lock, 2FA, Screenshot Protection, About, Online status) that nothing else
 * read, so tapping a row changed the score and protected nothing, and "E2E
 * Encryption" was bound to the screenshot key. Every row is now a checkable
 * fact (lib/privacyChecklist.ts) and opens the screen where it is changed.
 * "My Contacts" is gone from the chips: the server only stores on/off for last
 * seen and profile photo, so "contacts" silently meant "everyone".
 */

import { brandAlpha, type Palette } from '../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTheme } from '../lib/theme';
import Svg, { Circle } from 'react-native-svg';
import { getSettings, updateSettings, listTrustedContacts, listBlocks, type UserSettings } from '../lib/chatService';
import { isMfaEnabled } from '../lib/mfa';
import { hasPIN } from './(constants)/authService';
import { E2EE_ENABLED } from '../constants/flags';
import { privacyChecklist, privacyScore, type ChecklistRow, type PrivacyFacts } from '../lib/privacyChecklist';
import { AppText as Text, AuroraBackground } from '../components/ui';
import { HEADER_TOP } from '../constants/layout';

type Visibility = 'everyone' | 'nobody';
type ServerKey = 'lastSeenVisible' | 'profilePhotoVisible';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function PrivacyDashboardScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();

  const [server, setServer] = useState<UserSettings | null>(null);
  const [facts, setFacts] = useState<PrivacyFacts | null>(null);
  const [blockedCount, setBlockedCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<ServerKey | null>(null);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setError(null);
    try {
      const [bs, trusted, pin, mfa] = await Promise.all([
        getSettings(), listTrustedContacts(), hasPIN(), isMfaEnabled(),
      ]);
      if (seq !== loadSeq.current) return;
      setServer(bs);
      setFacts({
        e2ee: E2EE_ENABLED,
        // FLAG_SECURE is set app-wide by the root layout on Android and never
        // lowered; iOS offers no way to block capture.
        screenshotsBlocked: Platform.OS === 'android' ? true : null,
        deviceMfa: mfa,
        pinSet: !!pin,
        trustedContacts: trusted.length > 0,
        lastSeenHidden: bs.lastSeenVisible === false,
        readReceiptsOff: bs.readReceipts === false,
      });
    } catch (e: any) {
      if (seq === loadSeq.current) setError(e?.message ?? 'Could not load your privacy settings');
    }
    listBlocks()
      .then((b) => { if (seq === loadSeq.current) setBlockedCount(b.length); })
      .catch(() => { if (seq === loadSeq.current) setBlockedCount(null); });
  }, []);

  // Rows open other screens; re-read on return so the checklist shows what
  // was just changed there.
  useFocusEffect(useCallback(() => {
    load();
    return () => { loadSeq.current++; };
  }, [load]));

  const rows = useMemo(() => (facts ? privacyChecklist(facts) : []), [facts]);
  const score = privacyScore(rows);

  // Settings is where privacy-dashboard is opened from, and where Device MFA
  // and the blocked-users list live: go back to it rather than stacking a
  // second copy on top.
  const openRoute = useCallback((route: string) => {
    if (route === '/settings') router.dismissTo('/settings' as any);
    else router.push(route as any);
  }, [router]);

  const setVisibility = useCallback(async (key: ServerKey, value: Visibility) => {
    if (!server || saving) return;
    const prev = server;
    const next = { ...server, [key]: value === 'everyone' };
    if (next[key] === prev[key]) return;
    setServer(next);
    if (key === 'lastSeenVisible' && facts) setFacts({ ...facts, lastSeenHidden: !next.lastSeenVisible });
    setSaving(key);
    try {
      await updateSettings({ [key]: next[key] });
    } catch (e: any) {
      setServer(prev);
      if (key === 'lastSeenVisible' && facts) setFacts({ ...facts, lastSeenHidden: !prev.lastSeenVisible });
      Alert.alert('Could not save', e?.message ?? 'Try again');
    } finally {
      setSaving(null);
    }
  }, [server, saving, facts]);

  const scoreColor = score >= 80 ? colors.primary : score >= 50 ? colors.accent : colors.danger;

  // ── Score Ring ──
  const renderScoreRing = () => {
    const size = 160;
    const strokeWidth = 10;
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const progress = score / 100;

    return (
      <View style={s.scoreContainer}>
        <View style={s.ringWrapper} accessible accessibilityLabel={`Privacy score ${score} out of 100`}>
          <Svg width={size} height={size} style={{ transform: [{ rotate: '-90deg' }] }}>
            <Circle cx={size / 2} cy={size / 2} r={radius} stroke={colors.hairline} strokeWidth={strokeWidth} fill="transparent" />
            <Circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              stroke={scoreColor}
              strokeWidth={strokeWidth}
              fill="transparent"
              strokeDasharray={`${circumference}`}
              strokeDashoffset={circumference * (1 - progress)}
              strokeLinecap="round"
            />
          </Svg>
          <View style={s.scoreTextContainer}>
            <Text style={[s.scoreNumber, { color: scoreColor }]}>{score}</Text>
            <Text style={s.scoreLabel}>Privacy score</Text>
          </View>
        </View>

        <Text style={s.scoreHint}>
          The share of the checks below that are on for your account and this phone.
        </Text>
      </View>
    );
  };

  // ── Checklist ──
  const renderRow = (r: ChecklistRow) => {
    const stateText = r.on === null ? 'Not available on this device' : r.on ? 'On' : 'Off';
    const body = (
      <>
        <View style={[s.checkIcon, r.on ? s.checkIconOn : s.checkIconOff]}>
          <Ionicons name={r.on ? 'checkmark' : r.on === null ? 'remove' : 'close'} size={14} color={r.on ? colors.text : colors.textDim} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[s.checkLabel, !r.on && { color: colors.textDim }]}>{r.label}</Text>
          {r.on === null && <Text style={s.checkSub}>{stateText}</Text>}
        </View>
        {r.fixed ? (
          r.on !== null && <View style={s.alwaysBadge}><Text style={s.alwaysBadgeText}>Built in</Text></View>
        ) : (
          <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
        )}
      </>
    );
    if (r.fixed || !r.route) {
      return (
        <View key={r.key} style={s.checkRow} accessible accessibilityLabel={`${r.label}: ${stateText}`}>
          {body}
        </View>
      );
    }
    const route = r.route;
    return (
      <TouchableOpacity
        key={r.key}
        style={s.checkRow}
        onPress={() => openRoute(route)}
        accessibilityRole="button"
        accessibilityLabel={`${r.label}: ${stateText}`}
        accessibilityHint="Opens the setting"
      >
        {body}
      </TouchableOpacity>
    );
  };

  // ── Privacy Options ──
  const renderVisibility = (label: string, key: ServerKey, icon: React.ComponentProps<typeof Ionicons>['name']) => {
    const value: Visibility = server?.[key] ? 'everyone' : 'nobody';
    const options: { label: string; value: Visibility }[] = [
      { label: 'Everyone', value: 'everyone' },
      { label: 'Nobody', value: 'nobody' },
    ];
    return (
      <View style={s.privacyRow}>
        <View style={s.privacyLeft}>
          <Ionicons name={icon} size={20} color={colors.accent} style={{ marginRight: 10 }} />
          <Text style={s.privacyLabel}>{label}</Text>
          {saving === key && <ActivityIndicator size="small" color={colors.primary} style={{ marginLeft: 8 }} />}
        </View>
        <View style={s.privacyChips} accessibilityRole="radiogroup" accessibilityLabel={label}>
          {options.map(opt => (
            <TouchableOpacity
              key={opt.value}
              style={[s.pChip, value === opt.value && s.pChipActive]}
              onPress={() => setVisibility(key, opt.value)}
              disabled={!!saving}
              accessibilityRole="radio"
              accessibilityLabel={`${label}: ${opt.label}`}
              accessibilityState={{ selected: value === opt.value, disabled: !!saving }}
            >
              <Text style={[s.pChipText, value === opt.value && s.pChipTextActive]}>{opt.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    );
  };

  const suggestions = rows.filter(r => r.on === false && r.suggestion && r.route);

  const content = error ? (
    <View style={s.stateBox} accessibilityRole="alert">
      <Text style={s.stateTitle}>Could not load your privacy settings</Text>
      <Text style={s.stateSub}>{error}</Text>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="Try again" onPress={load} style={s.retryBtn}>
        <Text style={s.retryTxt}>Try again</Text>
      </TouchableOpacity>
    </View>
  ) : !facts || !server ? (
    <View style={s.stateBox}><ActivityIndicator color={colors.primary} size="large" /></View>
  ) : (
    <ScrollView contentContainerStyle={{ paddingBottom: 60 }} showsVerticalScrollIndicator={false}>
      {renderScoreRing()}

      <View style={s.section}>
        <Text style={s.sectionTitle} accessibilityRole="header">Checks</Text>
        {rows.map(renderRow)}
      </View>

      <View style={s.section}>
        <Text style={s.sectionTitle} accessibilityRole="header">Who can see</Text>
        {renderVisibility('Last seen', 'lastSeenVisible', 'time')}
        {renderVisibility('Profile photo', 'profilePhotoVisible', 'person-circle')}

        {/* The blocked-users list (with Unblock) lives in Settings. This row
            used to push /blocked — the SECURITY lock-out screen, which swallows
            Back and left the user with no way out. */}
        <TouchableOpacity
          style={s.blockedRow}
          onPress={() => openRoute('/settings')}
          accessibilityRole="button"
          accessibilityLabel={`Blocked users${blockedCount != null ? `, ${blockedCount}` : ''}. Manage in Settings`}
        >
          <View style={[s.privacyLeft, { marginBottom: 0 }]}>
            <Ionicons name="ban" size={20} color={colors.danger} style={{ marginRight: 10 }} />
            <Text style={s.privacyLabel}>Blocked users</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            {blockedCount != null && <Text style={s.blockedCount}>{blockedCount}</Text>}
            <Text style={s.manageLink}>Manage in Settings</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.accent} />
          </View>
        </TouchableOpacity>
      </View>

      {suggestions.length > 0 && (
        <View style={s.section}>
          <Text style={s.sectionTitle} accessibilityRole="header">Improve your score</Text>
          {suggestions.map(r => (
            <TouchableOpacity
              key={r.key}
              style={s.suggestionRow}
              onPress={() => openRoute(r.route!)}
              accessibilityRole="button"
              accessibilityLabel={`${r.label}. ${r.suggestion}`}
            >
              <Ionicons name="arrow-up-circle" size={18} color={colors.accent} style={{ marginRight: 10, marginTop: 1 }} />
              <View style={{ flex: 1 }}>
                <Text style={s.suggestionLabel}>{r.label}</Text>
                <Text style={s.suggestionText}>{r.suggestion}</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
            </TouchableOpacity>
          ))}
        </View>
      )}
    </ScrollView>
  );

  return (
    <View style={s.container}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />
      <View style={s.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={s.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle} accessibilityRole="header">Privacy Dashboard</Text>
        <View style={{ width: 40 }} />
      </View>
      {content}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: HEADER_TOP,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { fontSize: 18, fontWeight: '700', color: c.text },

  // Score ring
  scoreContainer: { alignItems: 'center', marginTop: 12, marginBottom: 8, paddingHorizontal: 24 },
  ringWrapper: { position: 'relative', width: 160, height: 160, justifyContent: 'center', alignItems: 'center' },
  scoreTextContainer: { position: 'absolute', alignItems: 'center' },
  scoreNumber: { fontSize: 42, fontWeight: '800' },
  scoreLabel: { fontSize: 12, color: c.textDim, marginTop: -2 },
  scoreHint: { fontSize: 13, color: c.textDim, textAlign: 'center', marginTop: 12, lineHeight: 20 },

  // Sections
  section: {
    marginHorizontal: 16,
    marginTop: 20,
    backgroundColor: c.glass,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: c.glassStroke,
  },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: c.text, marginBottom: 12 },

  // Checklist
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: c.hairline,
  },
  checkIcon: {
    width: 24,
    height: 24,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  checkIconOn: { backgroundColor: c.primary },
  checkIconOff: { backgroundColor: c.glassSoft, borderWidth: 1, borderColor: c.glassStroke },
  checkLabel: { fontSize: 14, color: c.text, fontWeight: '500' },
  checkSub: { fontSize: 12, color: c.textDim, marginTop: 2 },
  alwaysBadge: {
    backgroundColor: brandAlpha(0.15),
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  alwaysBadgeText: { fontSize: 10, color: c.primary, fontWeight: '700' },

  // Privacy controls
  privacyRow: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: c.hairline,
  },
  privacyLeft: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  privacyLabel: { fontSize: 14, color: c.text, fontWeight: '600' },
  privacyChips: { flexDirection: 'row', gap: 6 },
  pChip: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: c.surfaceSolid,
    borderWidth: 1,
    borderColor: c.glassStroke,
  },
  pChipActive: { backgroundColor: brandAlpha(0.15), borderColor: c.accent },
  pChipText: { fontSize: 12, color: c.textDim, fontWeight: '600' },
  pChipTextActive: { color: c.accent },

  blockedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
  },
  blockedCount: { fontSize: 14, fontWeight: '700', color: c.text, marginRight: 8 },
  manageLink: { fontSize: 13, color: c.accent, fontWeight: '600', marginRight: 4 },

  // Suggestions
  suggestionRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: c.hairline,
  },
  suggestionLabel: { fontSize: 13, fontWeight: '600', color: c.text },
  suggestionText: { fontSize: 12, color: c.textDim, marginTop: 2, lineHeight: 18 },

  // Loading / error
  stateBox: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 8 },
  stateTitle: { fontSize: 16, fontWeight: '700', color: c.text, textAlign: 'center' },
  stateSub: { fontSize: 13, color: c.textDim, textAlign: 'center', lineHeight: 18 },
  retryBtn: { marginTop: 8, minHeight: 44, paddingHorizontal: 18, justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: c.glassStroke, backgroundColor: c.glassSoft },
  retryTxt: { color: c.primary, fontWeight: '700' },
});
