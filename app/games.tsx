// app/games.tsx — Games mini app: games.corefinite.com in a WebView.
//
// LAUNCH HANDSHAKE (matches what the site actually does — read from the live
// page's boot(), not assumed):
//
//   dev  : the site fetches its own /dev/launch-token, then POSTs it to
//          /api/session to get a cookie.
//   prod : /dev/launch-token is 404 and GAMES_CONFIG.dev is false, so the site
//          mints NOTHING. It waits on "a secure launch from VaultChat".
//
// So we mint the Ed25519-signed token from our own backend and exchange it at
// /api/session INSIDE the WebView. Doing that POST from React Native instead
// would put the session cookie in the app's jar, not the WebView's, and the
// page would still see no session.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Linking, Share, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
// useFocusEffect from expo-router, NOT @react-navigation/native: both work, but
// only one of them is a dependency this app actually needs.
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import { useColors } from '../lib/theme';
import { api } from '../lib/api';

const GAMES_URL = 'https://games.corefinite.com';

/**
 * Bound a slug that is about to be interpolated into the games URL.
 *
 * The server validates these before they ever enter a push (gamesNotifySlug in
 * games_notify.go), and this is the same rule applied again on arrival. Worth
 * repeating rather than trusting: these params reach here through a navigation
 * route, which anything holding a deep link can drive — not only our own
 * notification. Anything with a slash, a quote, a `?` or a `#` in it would
 * rewrite the URL rather than fill it in.
 */
const slug = (v: unknown): string => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length > 0 && s.length <= 64 && /^[A-Za-z0-9_-]+$/.test(s) ? s : '';
};

/**
 * The table to open, or the hub when there is no valid deep link.
 *
 * Both halves are required: a game with no room is a lobby, not the table the
 * player was nudged about, so it falls back rather than opening something
 * confidently wrong.
 */
const startUrlFor = (game: unknown, room: unknown): string => {
  const g = slug(game), r = slug(room);
  return g && r ? `${GAMES_URL}/${g}.html?room=${encodeURIComponent(r)}` : GAMES_URL;
};

/**
 * Exchange the launch token for a games session, in the page's own context.
 *
 * Idempotent by design: it asks /api/profile first and returns early when a
 * session already exists, so the reload below cannot loop. The token is
 * embedded as a JSON string literal — it is opaque, short-lived (15 min) and
 * single-use on the games server, and it never leaves this WebView.
 */
const sessionBootstrap = (token: string) => `(async function(){
  try {
    var pr = await fetch('/api/profile', { credentials: 'include' });
    var pj = await pr.json().catch(function(){ return null; });
    if (pj && pj.ok) return;
    await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ token: ${JSON.stringify(token)} }),
    });
    location.reload();
  } catch (e) {}
})(); true;`;

export default function GamesScreen() {
  const colors = useColors();
  const router = useRouter();
  const webRef = useRef<WebView>(null);

  // Set when the screen was opened by tapping a VaultGames turn/invite push.
  // Memoised on the two values, not on the params object: expo-router hands
  // back a fresh object every render, which would rebuild the uri each time and
  // reload the WebView out from under a game in progress.
  const params = useLocalSearchParams<{ game?: string; room?: string }>();
  const startUrl = useMemo(
    () => startUrlFor(params.game, params.room),
    [params.game, params.room],
  );

  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  // null = still minting, '' = minting failed. Distinguished so a backend
  // without GAMES_SIGNING_PRIVATE_KEY_PEM (503) still opens the site rather
  // than blocking the screen — the page shows its own "Open from VaultChat"
  // state, which is the truth.
  useEffect(() => {
    let cancelled = false;
    api<{ token: string }>('/games/launch-token', { method: 'POST' })
      .then(r => { if (!cancelled) setToken(r?.token ?? ''); })
      .catch(() => { if (!cancelled) setToken(''); });
    return () => { cancelled = true; };
  }, []);
  // Tracked so the hardware back button walks the site's own history before it
  // leaves the screen — otherwise one back press from three pages deep drops the
  // user out of the whole mini app, which is the usual complaint about WebViews.
  const canGoBack = useRef(false);

  // ANDROID HARDWARE BACK.
  //
  // Bound on focus and released on blur, NOT in a bare useEffect: a listener
  // that outlives the screen keeps swallowing back presses on whatever is on
  // top of it afterwards. Returning true means "handled" — returning false lets
  // the navigator pop, which is exactly what we want at the site's root.
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        if (canGoBack.current) { webRef.current?.goBack(); return true; }
        return false;
      });
      return () => sub.remove();
    }, []),
  );

  const onNav = (e: WebViewNavigation) => { canGoBack.current = e.canGoBack; };

  const reload = () => { setFailed(false); setLoading(true); webRef.current?.reload(); };

  return (
    <View style={[s.fill, { backgroundColor: colors.bg }]}>
      {/* The root layout sets headerShown:false app-wide, so every screen must
          opt back in or its top ~150px sits under the status bar and silently
          eats taps — the fault that made several screens' actions unreachable.
          The native header also gives us a working back affordance for free. */}
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Games',
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          headerShadowVisible: false,
          headerRight: () => (
            <TouchableOpacity onPress={reload} hitSlop={12} accessibilityLabel="Reload games">
              <Text style={{ color: colors.text, fontSize: 18 }}>⟳</Text>
            </TouchableOpacity>
          ),
        }}
      />

      {failed ? (
        <View style={[s.fill, s.centered]}>
          <Text style={[s.msg, { color: colors.text }]}>Could not load Games</Text>
          <Text style={[s.sub, { color: colors.text }]}>Check your connection and try again.</Text>
          <TouchableOpacity onPress={reload} style={[s.btn, { borderColor: colors.text }]}>
            <Text style={{ color: colors.text }}>Retry</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.back()} style={s.close}>
            <Text style={{ color: colors.text, opacity: 0.7 }}>Close</Text>
          </TouchableOpacity>
        </View>
      ) : token === null ? (
        // Hold the WebView back until the mint settles. Loading the page first
        // would let boot() run with no session, land the user on the site's
        // "Open from VaultChat" screen, and only then inject — a visible
        // false-failure followed by a reload.
        <View style={[s.fill, s.centered]}>
          <ActivityIndicator size="large" color={colors.text} />
        </View>
      ) : (
        <>
          <WebView
            ref={webRef}
            source={{ uri: startUrl }}
            style={s.fill}
            onNavigationStateChange={onNav}
            onLoadEnd={() => {
              setLoading(false);
              // Injected AFTER load, not before: the bootstrap calls
              // /api/profile and /api/session on the page's own origin, which
              // needs the document to exist. It self-checks and reloads once,
              // exactly mirroring what the site's own dev path does.
              if (token) webRef.current?.injectJavaScript(sessionBootstrap(token));
            }}
            // The site already speaks this bridge: on a win/invite it posts
            // {type:'vaultchat-share'} expecting the native shell to handle it.
            // Without this handler those taps silently do nothing in-app.
            onMessage={(e) => {
              try {
                const msg = JSON.parse(e.nativeEvent.data);
                if (msg?.type === 'vaultchat-share') {
                  const p = msg.payload ?? {};
                  Share.share({
                    title: p.title,
                    message: [p.message, p.url].filter(Boolean).join(' '),
                  }).catch(() => {});
                }
              } catch { /* not our message — the page posts other things too */ }
            }}
            onError={() => { setLoading(false); setFailed(true); }}
            onHttpError={({ nativeEvent }) => {
              // A 404/500 still fires onLoadEnd, so without this the spinner
              // clears and the user is left staring at the site's error page
              // with no way to tell it apart from a game that just looks broken.
              if (nativeEvent.statusCode >= 400) { setLoading(false); setFailed(true); }
            }}
            // Games are the one thing that legitimately wants the screen: let
            // them go fullscreen and keep the media/audio behaviour they expect.
            allowsFullscreenVideo
            mediaPlaybackRequiresUserAction={false}
            // Responsiveness comes from the SITE, not from us — the viewport
            // meta tag is what makes it fit. Forcing scalesPageToFit or a
            // desktop UA would fight it. This just refuses a zoomed-out
            // desktop layout on a phone.
            scalesPageToFit={false}
            javaScriptEnabled
            domStorageEnabled
            // Keeps sessions across visits once auth lands.
            sharedCookiesEnabled
            thirdPartyCookiesEnabled
            // Anything that is not games.corefinite.com opens in the real
            // browser instead of inside our chrome-less WebView, so a stray
            // link cannot impersonate the app.
            onShouldStartLoadWithRequest={(req) => {
              if (req.url.startsWith(GAMES_URL)) return true;
              if (req.url.startsWith('about:')) return true;
              // react-native's own Linking — expo-linking adds nothing we need
              // here and is not otherwise used by this app.
              Linking.openURL(req.url).catch(() => {});
              return false;
            }}
          />
          {loading && (
            <View style={[s.overlay, { backgroundColor: colors.bg }]} pointerEvents="none">
              <ActivityIndicator size="large" color={colors.text} />
            </View>
          )}
        </>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  centered: { alignItems: 'center', justifyContent: 'center', padding: 24 },
  // Covers the WebView while it paints so the user never sees a white flash of
  // an empty page on a dark theme.
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  msg: { fontSize: 17, fontWeight: '600', marginBottom: 6 },
  sub: { fontSize: 13, opacity: 0.7, textAlign: 'center', marginBottom: 18 },
  btn: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 24 },
  close: { marginTop: 14, padding: 8 },
});
