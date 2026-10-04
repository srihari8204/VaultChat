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
 * "My Contacts" is gone: the server only stores on/off for last seen and
 * profile photo, so "contacts" silently meant "everyone".
 *
 * The dashboard no longer edits last seen / profile photo itself. Those (with
 * read receipts and discoverable) are owned by app/last-seen-privacy.tsx; the
 * "Who can see" card shows their current state and links there.
 *
 * Each source loads on its own: if trusted contacts or MFA cannot be read,
 * that row says "Could not check" instead of the whole screen failing.
 */

import { brandAlpha, type Palette } from '../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useRouter, type Href } from 'expo-router';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTheme } from '../lib/theme';
import Svg, { Circle } from 'react-native-svg';
import { getSettings, listTrustedContacts, listBlocks, type UserSettings } from '../lib/chatService';
import { readSecureStateSettled } from '../lib/screenGuard';
import { isMfaEnabled } from '../lib/mfa';
import { hasPIN } from './(constants)/authService';
import { E2EE_ENABLED } from '../constants/flags';
import { privacyChecklist, privacyScore, type ChecklistRow, type FactValue } from '../lib/privacyChecklist';
import { AppText as Text, AuroraBackground } from '../components/ui';
import { HEADER_TOP } from '../constants/layout';

/** A settled promise's value, or 'unknown' when it failed. */
function factOf<T>(r: PromiseSettledResult<T>, pick: (v: T) => boolean): FactValue {
  return r.status === 'fulfilled' ? pick(r.value) : 'unknown';
}

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function PrivacyDashboardScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();

  const [server, setServer] = useState<UserSettings | null>(null);
  const [rows, setRows] = useState<ChecklistRow[] | null>(null);
  const [blockedCount, setBlockedCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    const [bs, trusted, pin, mfa, secure] = await Promise.allSettled([
      getSettings(), listTrustedContacts(), hasPIN(), isMfaEnabled(),
      // Waits for a setSecure call still in flight (the root layout's).
      readSecureStateSettled(),
    ]);
    if (seq !== loadSeq.current) return;
    setLoading(false);
    setServer(bs.status === 'fulfilled' ? bs.value : null);
    setRows(privacyChecklist({
      e2ee: E2EE_ENABLED,
      // A read of what the guard last confirmed, not a platform guess and not a
      // setSecure(true) that would change the answer by asking: false in a dev
      // build, 'unknown' when no call was confirmed. iOS cannot block at all.
      screenshotsBlocked: Platform.OS === 'android' ? (secure.status === 'fulfilled' ? secure.value : 'unknown') : null,
      deviceMfa: factOf(mfa, (v) => !!v),
      pinSet: factOf(pin, (v) => !!v),
      trustedContacts: factOf(trusted, (v) => v.length > 0),
      lastSeenHidden: factOf(bs, (v) => v.lastSeenVisible === false),
      readReceiptsOff: factOf(bs, (v) => v.readReceipts === false),
    }));
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

  const score = privacyScore(rows ?? []);
  const unchecked = (rows ?? []).filter((r) => r.on === 'unknown').length;

  // Settings is where privacy-dashboard is opened from, and where Device MFA
  // and the blocked-users list live: go back to it rather than stacking a
  // second copy on top.
  const openRoute = useCallback((route: Href) => {
    if (route === '/settings') router.dismissTo('/settings');
    else router.push(route);
  }, [router]);

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
    const on = r.on === true;
    const stateText = r.on === null ? 'Not available on this device'
      : r.on === 'unknown' ? 'Could not check' : on ? 'On' : 'Off';
    const body = (
      <>
        <View style={[s.checkIcon, on ? s.checkIconOn : s.checkIconOff]}>
          <Ionicons name={on ? 'checkmark' : r.on === false ? 'close' : r.on === 'unknown' ? 'help' : 'remove'} size={14} color={on ? colors.onPrimary : colors.textDim} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[s.checkLabel, !on && { color: colors.textDim }]}>{r.label}</Text>
          {(r.on === null || r.on === 'unknown') && <Text style={s.checkSub}>{stateText}</Text>}
        </View>
        {r.fixed ? (
          on && <View style={s.alwaysBadge}><Text style={s.alwaysBadgeText}>Built in</Text></View>
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

  // ── Who can see: read-only, edited on app/last-seen-privacy.tsx ──
  const seen = (v: boolean | undefined) => (v ? 'Everyone' : 'Nobody');
  const visibilitySummary = server
    ? `Last seen: ${seen(server.lastSeenVisible)} · Profile photo: ${seen(server.profilePhotoVisible)} · Read receipts: ${server.readReceipts ? 'On' : 'Off'}`
    : 'Could not load these settings';

  const suggestions = (rows ?? []).filter(r => r.on === false && r.suggestion && r.route);

  const content = !rows ? (
    <View style={s.stateBox}><ActivityIndicator color={colors.primary} size="large" /></View>
  ) : (
    <ScrollView contentContainerStyle={{ paddingBottom: 60 }} showsVerticalScrollIndicator={false}>
      {renderScoreRing()}

      {unchecked > 0 && (
        <View style={s.notice} accessibilityRole="alert">
          <Text style={s.noticeTxt}>
            {unchecked === 1 ? '1 check' : `${unchecked} checks`} could not be loaded and {unchecked === 1 ? 'is' : 'are'} left out of the score.
          </Text>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Try loading the checks again" accessibilityState={{ busy: loading, disabled: loading }}
            disabled={loading} onPress={load} style={s.retryBtn}>
            {loading ? <ActivityIndicator color={colors.primary} /> : <Text style={s.retryTxt}>Try again</Text>}
          </TouchableOpacity>
        </View>
      )}

      <View style={s.section}>
        <Text style={s.sectionTitle} accessibilityRole="header">Checks</Text>
        {rows.map(renderRow)}
      </View>

      <View style={s.section}>
        <Text style={s.sectionTitle} accessibilityRole="header">Who can see</Text>
        <TouchableOpacity
          style={s.blockedRow}
          onPress={() => openRoute('/last-seen-privacy')}
          accessibilityRole="button"
          accessibilityLabel={`${visibilitySummary}. Change in Last seen and privacy`}
        >
          <View style={{ flex: 1, marginRight: 8 }}>
            <View style={[s.privacyLeft, { marginBottom: 4 }]}>
              <Ionicons name="time" size={20} color={colors.accent} style={{ marginRight: 10 }} />
              <Text style={s.privacyLabel}>Last seen & privacy</Text>
            </View>
            <Text style={s.checkSub}>{visibilitySummary}</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.accent} />
        </TouchableOpacity>

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
              onPress={() => openRoute(r.route)}
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
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} hitSlop={8} style={s.backBtn}>
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
  privacyLeft: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  privacyLabel: { fontSize: 14, color: c.text, fontWeight: '600' },

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

  // Loading / partial-failure notice
  stateBox: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 8 },
  notice: { marginHorizontal: 16, marginTop: 16, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: c.danger, backgroundColor: c.glassSoft, gap: 4 },
  noticeTxt: { fontSize: 13, color: c.text, lineHeight: 18 },
  retryBtn: { alignSelf: 'flex-start', marginTop: 8, minHeight: 44, paddingHorizontal: 18, justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: c.glassStroke, backgroundColor: c.glassSoft },
  retryTxt: { color: c.primary, fontWeight: '700' },
});
