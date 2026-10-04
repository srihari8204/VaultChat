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

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { usePathname } from 'expo-router';

import { SERVER_URL } from '../constants/server';
import { TERMS_GATE as G } from '../constants/gatePalette';
import { hasSession } from '../lib/api';
import { isLockOrAuthRoute } from '../lib/pendingLink';
// AUDIT F8. The first screen a new user sees is the worst place to be speaking
// the wrong language, so the gates are the first consumers of the app catalog.
import { t, useLang } from '../lib/i18n';
import { acceptTerms, fetchTermsState, termsAreAnUpdate, termsOutstanding, type TermsState } from '../lib/terms';

export function TermsGate({ children }: { children: React.ReactNode }) {
  useLang();   // re-render if the language changes while this is on screen
  const [state, setState] = useState<TermsState | null>(null);
  // The AppState listener below is registered once; it reads the CURRENT
  // answer through this ref. It used to read `state` from the mount render —
  // always null — so its "already outstanding?" test never saw a real answer.
  const stateRef = useRef<TermsState | null>(null);
  stateRef.current = state;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Signed out, there is nothing to poll for: the ask waits for the user to
  // leave the sign-in/lock routes (which is what signing in does), see below.
  const pathname = usePathname();
  const askRef = useRef<((force?: boolean) => Promise<void>) | null>(null);
  const waitingForSignIn = useRef(false);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Deliberately NOT awaited before the first paint, for the same reason the
    // version check is not: gating render on a network round trip turns every
    // cold start on a slow connection into a blank screen, for a check that
    // says "nothing outstanding" essentially always.
    //
    // IT HAS TO ASK MORE THAN ONCE. This component mounts at app start, which
    // is before anybody has signed in, so the first ask has no session to ask
    // about and comes back with no answer. A single attempt meant the gate
    // never fired for a new user — they signed up seconds later and nothing
    // looked again. Found on a device; no amount of typechecking would have
    // shown it.
    //
    // So: keep asking while there is no answer, backing off, and stop the
    // moment there is one. An answer includes "nothing outstanding" — this
    // stops as soon as the server says anything at all.
    let delay = 1500;
    const again = () => {
      delay = Math.min(delay * 2, 30_000);
      timer = setTimeout(() => ask(), delay);
    };
    const ask = async (force = false) => {
      // Signed out there is nothing to ask the SERVER about: check the local
      // session only (no request), and wait for the navigation that signing in
      // makes instead of waking on a timer.
      if (!(await hasSession().catch(() => false))) { waitingForSignIn.current = true; return; }
      waitingForSignIn.current = false;
      fetchTermsState(force)
        .then((s) => {
          if (!alive) return;
          if (s) { setState(s); return; }   // an answer, of either kind — done
          // No answer yet: offline, or a server without the endpoint. Ask
          // again, backing off to at most every half minute.
          again();
        })
        .catch(() => {});
    };
    askRef.current = ask;
    void ask();

    // Coming back to the foreground is the other moment the answer can change —
    // a session established in another tab, a token refreshed, terms republished.
    // force: without it fetchTermsState returns the answer cached at the first
    // ask, so terms republished while the app was running were never seen.
    // The retry ladder restarts from here rather than running twice.
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active' || !alive || termsOutstanding(stateRef.current)) return;
      if (timer) { clearTimeout(timer); timer = null; }
      delay = 1500;
      void ask(true);
    });

    return () => {
      alive = false;
      askRef.current = null;
      if (timer) clearTimeout(timer);
      sub.remove();
    };
  }, []);

  // Every sign-in path ends by leaving the auth and lock routes (resetTo the
  // tabs, restore-backup, a replayed link), so that is when to look again.
  useEffect(() => {
    if (waitingForSignIn.current && !isLockOrAuthRoute(pathname)) void askRef.current?.();
  }, [pathname]);

  const onAccept = useCallback(async () => {
    if (!state || busy) return;
    setBusy(true);
    setError(null);
    try {
      await acceptTerms(state);
      setState({ ...state, acceptedVersion: state.requiredVersion });
    } catch {
      // Stay on the screen and say so. Silently continuing would leave the app
      // believing an acceptance was recorded when it was not, which defeats the
      // only purpose this screen has.
      // The catalog's words, not the raw request error ("Network request failed").
      setError(t('terms.error'));
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
      {/* Scrolls: at large font scales the block is taller than a short phone,
          and the accept button was pushed off the bottom with no way to reach it. */}
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      <View style={styles.icon} accessibilityElementsHidden importantForAccessibility="no">
        <Ionicons name={isUpdate ? 'refresh-circle' : 'document-text'} size={44} color={G.onAccent} />
      </View>

      <Text style={styles.title} accessibilityRole="header">
        {t(isUpdate ? 'terms.update.title' : 'terms.first.title')}
      </Text>

      <Text style={styles.body}>
        {t(isUpdate ? 'terms.update.body' : 'terms.first.body')}
      </Text>

      <TouchableOpacity style={styles.link} onPress={() => open(termsHref)} accessibilityRole="link">
        <Ionicons name="document-text-outline" size={18} color={G.linkIcon} />
        <Text style={styles.linkTxt}>{t('terms.read.terms')}</Text>
        <Ionicons name="open-outline" size={15} color={G.linkOpenIcon} />
      </TouchableOpacity>

      <TouchableOpacity style={styles.link} onPress={() => open(`${SERVER_URL}/privacy`)} accessibilityRole="link">
        <Ionicons name="lock-closed-outline" size={18} color={G.linkIcon} />
        <Text style={styles.linkTxt}>{t('terms.read.privacy')}</Text>
        <Ionicons name="open-outline" size={15} color={G.linkOpenIcon} />
      </TouchableOpacity>

      {error && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}

      <TouchableOpacity
        style={[styles.button, busy && styles.buttonBusy]}
        onPress={onAccept}
        disabled={busy}
        accessibilityRole="button"
        accessibilityState={{ disabled: busy, busy }}
      >
        {busy
          ? <ActivityIndicator color={G.onAccent} />
          : <Text style={styles.buttonTxt}>{t('terms.agree')}</Text>}
      </TouchableOpacity>

      {/* Says what the button means, in the one place where saying it matters.
          "I agree" on its own is a claim the user has to take on trust. */}
      <Text style={styles.foot}>{t('terms.agree.foot')}</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  // Always dark, like the other full-screen gates in this app — it is a system
  // surface shown before the themed shell exists, so it cannot depend on theme
  // state having loaded. The fixed palette and its contrast checks live in
  // constants/gatePalette.ts.
  block: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: G.ground,
    zIndex: 9999,
  },
  scroll: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, paddingVertical: 48 },
  icon: {
    width: 84, height: 84, borderRadius: 42,
    backgroundColor: G.accent,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 22,
  },
  // minHeight, never height: these strings grow with the system font scale and
  // a fixed height would clip them (see the test:layout guard).
  title: {
    color: G.title, fontSize: 22, fontWeight: '700',
    textAlign: 'center', minHeight: 28, marginBottom: 10,
  },
  body: {
    color: G.body, fontSize: 15, lineHeight: 22, minHeight: 22,
    textAlign: 'center', marginBottom: 24, maxWidth: 420,
  },
  link: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    alignSelf: 'stretch', maxWidth: 420,
    paddingVertical: 14, paddingHorizontal: 16,
    borderRadius: 10, borderWidth: 1, borderColor: G.linkStroke,
    backgroundColor: G.linkFill,
    marginBottom: 10,
  },
  linkTxt: { color: G.linkText, fontSize: 15, flex: 1, minHeight: 20 },
  error: {
    color: G.error, fontSize: 13.5, lineHeight: 19, minHeight: 19,
    textAlign: 'center', marginTop: 12, maxWidth: 420,
  },
  button: {
    marginTop: 22, alignSelf: 'stretch', maxWidth: 420,
    backgroundColor: G.accent, borderRadius: 12,
    paddingVertical: 15, alignItems: 'center', minHeight: 50, justifyContent: 'center',
  },
  buttonBusy: { opacity: 0.7 },
  buttonTxt: { color: G.onAccent, fontSize: 16, fontWeight: '700' },
  foot: {
    color: G.foot, fontSize: 12.5, lineHeight: 18, minHeight: 18,
    textAlign: 'center', marginTop: 14, maxWidth: 420,
  },
});

export default TermsGate;
