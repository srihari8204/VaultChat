// components/TermsGate.tsx — the recorded terms acceptance (audit F10).
//
// Rendered over everything when the server says this user has not accepted the
// terms currently in force. Two different situations reach this screen and they
// deserve different words: someone who has never accepted anything is finishing
// signing up, and someone whose acceptance is stale is being interrupted. A
// single "Accept to continue" for both reads as a dark pattern to the second
// group, who quite reasonably want to know what changed.
//
// IT ONLY APPEARS WHEN THE SERVER SAYS SO. lib/terms fails open on every
// uncertain path — offline, an outage, a server predating the endpoint, no
// configured version, not signed in — because an acceptance screen nobody can
// get past is a far worse outcome than an acceptance recorded a day later.
//
// The links are real and open the published pages. An acceptance of terms the
// user could not read would be worth nothing, which is the whole reason
// caddy/public/terms.html is served at a stable URL.

import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { SERVER_URL } from '../constants/server';
// AUDIT F8. The first screen a new user sees is the worst place to be speaking
// the wrong language, so the gates are the first consumers of the app catalog.
import { t, useLang } from '../lib/i18n';
import { acceptTerms, fetchTermsState, termsAreAnUpdate, termsOutstanding, type TermsState } from '../lib/terms';

export function TermsGate({ children }: { children: React.ReactNode }) {
  useLang();   // re-render if the language changes while this is on screen
  const [state, setState] = useState<TermsState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // Deliberately NOT awaited before the first paint, for the same reason the
    // version check is not: gating render on a network round trip turns every
    // cold start on a slow connection into a blank screen, for a check that
    // says "nothing outstanding" essentially always.
    fetchTermsState()
      .then((s) => { if (alive) setState(s); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const onAccept = useCallback(async () => {
    if (!state || busy) return;
    setBusy(true);
    setError(null);
    try {
      await acceptTerms(state);
      setState({ ...state, acceptedVersion: state.requiredVersion });
    } catch (e: any) {
      // Stay on the screen and say so. Silently continuing would leave the app
      // believing an acceptance was recorded when it was not, which defeats the
      // only purpose this screen has.
      setError(e?.message ?? t('terms.error'));
    } finally {
      setBusy(false);
    }
  }, [state, busy]);

  if (!termsOutstanding(state)) return <>{children}</>;

  const isUpdate = termsAreAnUpdate(state);
  const termsHref = state?.url || `${SERVER_URL}/terms`;
  const open = (url: string) => Linking.openURL(url).catch(() => {});

  return (
    <View style={styles.block}>
      <View style={styles.icon}>
        <Ionicons name={isUpdate ? 'refresh-circle' : 'document-text'} size={44} color="#fff" />
      </View>

      <Text style={styles.title}>
        {t(isUpdate ? 'terms.update.title' : 'terms.first.title')}
      </Text>

      <Text style={styles.body}>
        {t(isUpdate ? 'terms.update.body' : 'terms.first.body')}
      </Text>

      <TouchableOpacity style={styles.link} onPress={() => open(termsHref)} accessibilityRole="link">
        <Ionicons name="document-text-outline" size={18} color="#B48CE8" />
        <Text style={styles.linkTxt}>{t('terms.read.terms')}</Text>
        <Ionicons name="open-outline" size={15} color="#8A879B" />
      </TouchableOpacity>

      <TouchableOpacity style={styles.link} onPress={() => open(`${SERVER_URL}/privacy`)} accessibilityRole="link">
        <Ionicons name="lock-closed-outline" size={18} color="#B48CE8" />
        <Text style={styles.linkTxt}>{t('terms.read.privacy')}</Text>
        <Ionicons name="open-outline" size={15} color="#8A879B" />
      </TouchableOpacity>

      {error && <Text style={styles.error}>{error}</Text>}

      <TouchableOpacity
        style={[styles.button, busy && styles.buttonBusy]}
        onPress={onAccept}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Accept the terms of service and privacy policy"
      >
        {busy
          ? <ActivityIndicator color="#fff" />
          : <Text style={styles.buttonTxt}>{t('terms.agree')}</Text>}
      </TouchableOpacity>

      {/* Says what the button means, in the one place where saying it matters.
          "I agree" on its own is a claim the user has to take on trust. */}
      <Text style={styles.foot}>{t('terms.agree.foot')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // Always dark, like the other full-screen gates in this app — it is a system
  // surface shown before the themed shell exists, so it cannot depend on theme
  // state having loaded. theme-exempt: deliberate system surface.
  block: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#0F1115',   // theme-exempt: shown before the themed shell exists
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    zIndex: 9999,
  },
  icon: {
    width: 84, height: 84, borderRadius: 42,
    backgroundColor: '#9D6FD0',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 22,
  },
  // minHeight, never height: these strings grow with the system font scale and
  // a fixed height would clip them (see the test:layout guard).
  title: {
    color: '#F2F2F6', fontSize: 22, fontWeight: '700',
    textAlign: 'center', minHeight: 28, marginBottom: 10,
  },
  body: {
    color: '#A5A2B5', fontSize: 15, lineHeight: 22, minHeight: 22,   // theme-exempt: always-dark gate
    textAlign: 'center', marginBottom: 24, maxWidth: 420,
  },
  link: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    alignSelf: 'stretch', maxWidth: 420,
    paddingVertical: 14, paddingHorizontal: 16,
    borderRadius: 10, borderWidth: 1, borderColor: '#242833',   // theme-exempt: always-dark gate
    backgroundColor: '#171A21',   // theme-exempt: always-dark gate
    marginBottom: 10,
  },
  linkTxt: { color: '#E7E9EE', fontSize: 15, flex: 1, minHeight: 20 },   // theme-exempt: always-dark gate
  error: {
    color: '#F1737A', fontSize: 13.5, lineHeight: 19, minHeight: 19,
    textAlign: 'center', marginTop: 12, maxWidth: 420,
  },
  button: {
    marginTop: 22, alignSelf: 'stretch', maxWidth: 420,
    backgroundColor: '#9D6FD0', borderRadius: 12,
    paddingVertical: 15, alignItems: 'center', minHeight: 50, justifyContent: 'center',
  },
  buttonBusy: { opacity: 0.7 },
  buttonTxt: { color: '#fff', fontSize: 16, fontWeight: '700' },
  foot: {
    color: '#75728A', fontSize: 12.5, lineHeight: 18, minHeight: 18,   // theme-exempt: always-dark gate
    textAlign: 'center', marginTop: 14, maxWidth: 420,
  },
});

export default TermsGate;
