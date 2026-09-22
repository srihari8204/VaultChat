// app/(tabs)/mini.tsx
// Mini Apps Platform — a launcher for the full mini apps.
//
// Tiles that only raise "Coming Soon" are NOT listed: a dead tile on a primary
// tab reads as a broken app, not as a promise. Add one back the same day its
// screen lands.
//
// EVERY TILE HERE IS A ROUTE. The Calculator and Todo List used to run inline
// on this screen, and "Build Your Own" advertised an SDK whose only button
// raised "Documentation portal coming soon" — the exact shape of dead tile the
// note above refuses. All three were removed 2026-09-22, and with them the
// fullscreen-inside-a-tab mechanism they needed.

import { Ionicons } from '@expo/vector-icons';
import { flagEnabled } from '../../lib/remoteFlags';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useRouter } from 'expo-router';
import { HEADER_TOP, SCREEN_BOTTOM } from '../../constants/layout';
import React, { useMemo } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { AppText, AuroraBackground } from '../../components/ui';
import type { Palette } from '../../constants/theme';
import { useColors } from '../../lib/theme';
import { useVisionComfort } from '../../lib/visionComfort';
import { GLOW } from '../../constants/glass';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

// ── Mini Apps matching PDF (page 12) ─────────────────────────────
// Row 1: Watch, Walkie, Screen
// Row 2: Notes, Scanner, Location
// Row 3: Current Loc, Cloud, Security Hub
const MINI_APPS_MAIN = [
  // Broadcast. The ONLY mode that is not end-to-end encrypted \u2014 app/live.tsx
  // states that before anything is published, rather than leaving someone to
  // assume their stream has the same protection as their calls.
  { id: 'live',        icon: 'radio-outline', name: 'Go Live', route: '/live', gradient: ['#EF4444', '#B91C1C'] as [string, string] },
  { id: 'navigate',    icon: 'navigate-outline', name: 'Navigate', route: '/navigate', gradient: ['#1777FE', '#1D4ED8'] as [string, string] },
  // Spaces absorbed the old Family Circle + SOS tiles \u2014 one app, one hub.
  // Renamed from "Family Space": family is one TYPE of space, alongside school
  // transport, offices and the rest. The route stays /family so existing deep
  // links and the tile's stored id keep working \u2014 renaming a route to match a
  // label is churn that breaks bookmarks.
  { id: 'familyspace', icon: 'people-outline', name: 'Spaces', route: '/family', gradient: ['#7C3AED', '#2563EB'] as [string, string] },
  { id: 'finance',     icon: 'cash-outline', name: 'Vault Finance', route: '/finance', gradient: ['#6D3FA8', '#1552E0'] as [string, string] },
  { id: 'shopbook',    icon: 'storefront-outline', name: 'Shop Book', route: '/shop-book', gradient: ['#0B7A3B', '#16A34A'] as [string, string] },
  { id: 'notes',       icon: 'document-text-outline', name: 'Notes',       route: '/encrypted-notes', gradient: ['#F59E0B', '#D97706'] as [string, string] },
  { id: 'scanner',     icon: 'scan-outline', name: 'Scanner',     route: '/docscanner',     gradient: ['#1777FE', '#1D4ED8'] as [string, string] },
  { id: 'shelf',       icon: 'library-outline', name: 'Shelf',        route: '/shelf',      gradient: ['#B45309', '#D97706'] as [string, string] },
  // Hosted at games.corefinite.com, rendered in a WebView. Auth is not wired
  // yet by design \u2014 the site loads anonymously until it is.
  { id: 'games',       icon: 'game-controller-outline', name: 'Games',       route: '/games',      gradient: ['#DB2777', '#7C3AED'] as [string, string] },
  { id: 'security',    icon: 'shield-checkmark-outline', name: 'Security Hub', route: '/aiguardian', gradient: ['#0E7490', '#164E63'] as [string, string] },
] satisfies readonly { id: string; icon: IoniconName; name: string; route: string; gradient: [string, string] }[];

// The Todo List's saved items are still on device under `vc_miniapp_todos`,
// sealed with the cache DEK. NOT deleted with the feature: that key holds the
// user's own text, and removing a screen is reversible while destroying what
// someone wrote is not. It is also not in purgeAccountData()'s scoped list, so
// it already outlived sign-out before this change. Decide it deliberately —
// purge it, or leave it — rather than as a side effect of deleting a tile.

export default function MiniAppsScreen() {
  const c = useColors();
  const { width } = useWindowDimensions();
  const { metrics } = useVisionComfort();
  const styles = useMemo(() => makeStyles(c, width, metrics), [c, width, metrics]);
  const router = useRouter();

  // ── Handle app open ───────────────────────────────────────────
  const handleOpenApp = (appId: string) => {
    // Main mini apps — navigate to their routes
    //
    // A tile hidden by a kill switch must not be reachable by a stale deep link
    // or a remembered "recent app" entry either — hiding the button while the
    // route still opens is a half-disabled feature, which is the failure mode a
    // kill switch exists to avoid.
    if (!flagEnabled(`mini.${appId}`)) return;
    const mainApp = MINI_APPS_MAIN.find(a => a.id === appId);
    if (mainApp?.route) {
      router.push(mainApp.route as any);
      return;
    }
    if (mainApp && !mainApp.route) {
      Alert.alert('Coming Soon', `${mainApp.name} is under development.`);
      return;
    }
    Alert.alert('Coming Soon', 'This mini app is under development.');
  };

  // ── Main grid view ────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />
      <AuroraBackground variant="mini" />

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* ── Header ────────────────────────────────── */}
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} accessibilityLabel="Back">
            <Ionicons name="arrow-back" size={20} color={c.text} />
          </TouchableOpacity>
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={styles.titleRow}>
              <Ionicons name="grid-outline" size={24} color={c.accentOn} />
              <AppText variant="title" style={styles.headerTitle}>Mini Apps</AppText>
            </View>
            <AppText variant="callout" style={styles.headerSub}>Powerful tools right inside your chats</AppText>
          </View>
        </View>

        {/* ── Mini Apps 3x3 Grid (matching PDF page 12) ─── */}
        <AppText variant="h3" style={styles.sectionTitle}>Mini Apps</AppText>
        <View style={styles.grid}>
          {/* AUDIT F11. Each tile is behind a kill switch keyed on its id, so a
              mini-app that starts misbehaving — a broken WebView, a dependency
              outage, a partner endpoint down — can be taken off every device by
              setting VAULTCHAT_REMOTE_FLAGS={"mini.<id>":false} and restarting
              the API, instead of shipping a build that only reaches the people
              who update. The server can only DISABLE; see lib/remoteFlagPolicy.
              Until the flags load, and whenever they cannot, every tile shows —
              the app behaves as built. */}
          {MINI_APPS_MAIN.filter(app => flagEnabled(`mini.${app.id}`)).map(app => (
            <TouchableOpacity
              key={app.id}
              style={styles.appCard}
              onPress={() => handleOpenApp(app.id)}
              activeOpacity={0.78}
              accessibilityRole="button"
              accessibilityLabel={app.name}
            >
              <LinearGradient colors={app.gradient} style={styles.appIconWrap}>
                <Ionicons name={app.icon} size={24} color="#FFFFFF" />
              </LinearGradient>
              <AppText variant="tiny" style={styles.appName}>{app.name}</AppText>
              {!app.route && <AppText variant="tiny" style={styles.comingSoon}>Soon</AppText>}
            </TouchableOpacity>
          ))}
        </View>

        {/* Games ship as a separate WebView deployment — no in-app games. */}

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────
const makeStyles = (c: Palette, width: number, m: ReturnType<typeof useVisionComfort>['metrics']) => {
  const contentW = Math.max(0, width - 40);
  const gridGap = 10;
  const baseCols = width >= 840 ? 5 : width >= 600 ? 4 : 3;
  const gridCols = baseCols;
  const appCardW = Math.floor((contentW - gridGap * (gridCols - 1)) / gridCols);

  return StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: c.bg,
  },
  scroll: {
    padding: 20,
    paddingTop: HEADER_TOP,
    // NOT TAB_BAR_SPACE any more: this screen hides the floating bar
    // (app/(tabs)/_layout.tsx), so reserving room for it left ~80px of dead
    // space under the last row of tiles. SCREEN_BOTTOM is the safe-area inset,
    // which is all that sits below the grid now.
    paddingBottom: SCREEN_BOTTOM + 16,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 24,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: c.glassSoft,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.glassStroke,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0, flexShrink: 1 },
  headerTitle: {
    color: c.text,
    fontSize: 26,
    fontWeight: '800',
    flexShrink: 1,
  },
  headerSub: {
    color: c.textDim,
    fontSize: 13,
    marginTop: 2,
  },
  sectionTitle: {
    color: c.text,
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 14,
  },

  // ── 3-column Grid (matching PDF page 12) ───────────
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: gridGap,
  },
  appCard: {
    width: appCardW,
    minHeight: 104,
    backgroundColor: c.glass,
    borderRadius: 20,
    paddingHorizontal: 8,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.glassStroke,
    ...GLOW.accent,
    shadowOpacity: 0.14,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 3,
  },
  appIconWrap: {
    width: 50,
    height: 50,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 9,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  appName: {
    color: c.text,
    textAlign: 'center',
    flexShrink: 1,
  },
  comingSoon: {
    color: c.textDim,
    marginTop: 2,
    fontStyle: 'italic',
  },
  });
};
