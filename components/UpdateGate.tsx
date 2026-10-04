// components/UpdateGate.tsx — the blocking "please update" screen.
//
// Rendered over everything when the server's minimum build is above this one.
// There is no dismiss and no back: that is the point. A client below the floor
// can misread versioned formats — envelopes, sender keys, backups — and the
// damage lands in someone's message history rather than in a log.
//
// It is deliberately the ONLY thing on screen. A banner over a working app gets
// ignored, and the whole reason this exists is for the case where "ignored" is
// not an acceptable outcome.
//
// The soft floor gets a different treatment entirely: a dismissible bar, no
// blocking, because "we would like you to update" and "you cannot continue" are
// different messages and collapsing them trains people to ignore both.

import React, { useEffect, useState } from 'react';
import { AppState, View, Text, TouchableOpacity, StyleSheet, Linking, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import { Ionicons } from '@expo/vector-icons';
import {
  checkAppVersion, currentBuild, fetchVersionGate, verdictFor, type VersionGate, type VersionVerdict,
} from '../lib/appVersion';
// The catalog's update.* keys, as TermsGate uses terms.* (lib/i18n).
import { t, useLang } from '../lib/i18n';

/** Re-ask the server on foreground at most this often: a floor raised while the
 *  app sat in the background must still apply, without a request per resume. */
const RECHECK_MS = 60 * 60_000;

/**
 * Where "Update" goes when the server sent no updateUrl. On Android the Play
 * listing for this package (market:// first, the web page if no store app); on
 * iOS app.json's ios.appStoreUrl when it is set; otherwise false — the screen
 * then says where to update instead of a dead button.
 */
async function openStoreFallback(): Promise<boolean> {
  if (Platform.OS === 'ios') {
    const url = Constants.expoConfig?.ios?.appStoreUrl;
    if (!url) return false;
    try { await Linking.openURL(url); return true; } catch { return false; }
  }
  const pkg = Constants.expoConfig?.android?.package;
  if (Platform.OS !== 'android' || !pkg) return false;
  try { await Linking.openURL(`market://details?id=${pkg}`); return true; } catch { /* no Play Store app */ }
  try { await Linking.openURL(`https://play.google.com/store/apps/details?id=${pkg}`); return true; } catch { return false; }
}

export function UpdateGate({ children }: { children: React.ReactNode }) {
  useLang();   // re-render if the language changes while this is on screen
  const [verdict, setVerdict] = useState<VersionVerdict>('ok');
  const [gate, setGate] = useState<VersionGate | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [noStore, setNoStore] = useState(false);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    let alive = true;
    let checkedAt = Date.now();
    // Deliberately NOT awaited before the first paint. A version check that
    // gates rendering would add a network round trip to every cold start, and
    // on a slow connection that is a blank screen — for a check that says "ok"
    // essentially always.
    checkAppVersion()
      .then(({ verdict: v, gate: g }) => { if (alive) { setVerdict(v); setGate(g); } })
      .catch(() => {});
    // Re-check on foreground (throttled): the check used to run once per
    // process, so a floor raised while the app lived in the background never
    // applied until the next cold start.
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active' || Date.now() - checkedAt < RECHECK_MS) return;
      checkedAt = Date.now();
      fetchVersionGate(true)
        .then((g) => { if (alive && g) { setVerdict(verdictFor(currentBuild(), g)); setGate(g); } })
        .catch(() => {});
    });
    return () => { alive = false; sub.remove(); };
  }, []);

  const openStore = async () => {
    const url = gate?.updateUrl;
    if (url) { Linking.openURL(url).catch(() => {}); return; }
    if (!(await openStoreFallback())) setNoStore(true);
  };

  if (verdict === 'blocked') {
    return (
      <View style={styles.block}>
        <View style={styles.icon} accessibilityElementsHidden importantForAccessibility="no"><Ionicons name="arrow-up-circle" size={44} color="#fff" /></View>
        <Text style={styles.title} accessibilityRole="header">{t('update.blocked.title')}</Text>
        <Text style={styles.body}>
          {gate?.message?.trim() ? gate.message : t('update.blocked.body')}
        </Text>
        <TouchableOpacity style={styles.cta} onPress={openStore} activeOpacity={0.85} accessibilityRole="button">
          <Text style={styles.ctaTxt}>{t('update.button')}</Text>
        </TouchableOpacity>
        {noStore && (
          <Text style={styles.body} accessibilityLiveRegion="polite">
            {t('update.noStore')}
          </Text>
        )}
        <Text style={styles.meta}>
          Installed build {currentBuild() || '—'} · minimum {gate?.minBuild ?? '—'}
        </Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {verdict === 'advise' && !dismissed && (
        <View style={[styles.bar, { paddingTop: 9 + insets.top }]}>
          <Ionicons name="arrow-up-circle-outline" size={17} color="#fff" />
          <Text style={styles.barTxt} numberOfLines={1}>{t('update.advise.body')}</Text>
          <TouchableOpacity onPress={openStore} accessibilityRole="button" accessibilityLabel={t('update.advise.label')} hitSlop={12}>
            <Text style={styles.barCta}>{t('update.advise.cta')}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setDismissed(true)} accessibilityRole="button"
            accessibilityLabel={t('update.dismiss')} hitSlop={14}>
            <Ionicons name="close" size={17} color="rgba(255,255,255,0.8)" />
          </TouchableOpacity>
        </View>
      )}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  // Fixed colours, not the app palette: this screen may be the only thing a
  // user ever sees from a broken build, so it must not depend on theme code
  // that could itself be the thing that is out of date.
  block: {
    flex: 1,
    backgroundColor: '#0A0A0F',   // theme-exempt: see the note above — this screen must not depend on theme code that may itself be the out-of-date part
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 16,
  },
  icon: {
    width: 82, height: 82, borderRadius: 41,
    backgroundColor: 'rgba(157,111,208,0.18)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 4,
  },
  title: { color: '#F6F7F9', fontSize: 22, fontWeight: '800', textAlign: 'center' },
  body: {
    color: 'rgba(246,247,249,0.72)', fontSize: 15, lineHeight: 21,
    textAlign: 'center', maxWidth: 340,
  },
  cta: {
    marginTop: 10, minHeight: 50, borderRadius: 14, paddingHorizontal: 40,
    backgroundColor: '#9D6FD0', alignItems: 'center', justifyContent: 'center',
  },
  ctaTxt: { color: '#fff', fontSize: 16, fontWeight: '800' },
  meta: { color: 'rgba(246,247,249,0.38)', fontSize: 12, marginTop: 6, fontVariant: ['tabular-nums'] },

  bar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#6D4AA8', paddingHorizontal: 14, paddingVertical: 9,
  },
  barTxt: { color: '#fff', fontSize: 13, flex: 1, minWidth: 0 },
  barCta: { color: '#fff', fontSize: 13, fontWeight: '800' },
});

export default UpdateGate;
