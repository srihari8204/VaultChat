// app/(tabs)/_layout.tsx
// 5-tab navigation: Chats | Status | [Mini Apps] | Calls | Profile.
// Mini Apps sits in the CENTER as a prominent raised/glowing button. Alerts
// stays a hidden route (href: null), reached from the Chats header.
// Custom glass SVG artwork, with independent day/night tab inks.

import { Tabs } from 'expo-router';
import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import type { Palette } from '../../constants/theme';
import { useColors, useTheme } from '../../lib/theme';
import { TabGlyph, type TabGlyphName } from '../../components/ui/TabGlyph';
import { AppText } from '../../components/ui/Text';
import { GlassView } from '../../components/ui/GlassView';
import { TAB_BAR_RAISE } from '../../constants/layout';
import { TAB_LABEL_MAX_SCALE, visionTabBarGrowth } from '../../constants/layoutMath';
import { useUnreadTotal } from '../../lib/unreadStore';
import { useReducedMotion } from '../../lib/useReducedMotion';
import { useVisionComfort } from '../../lib/visionComfort';
import { APPS_DISC_GRADIENT, MOTION, TAB_BAR_SHADOW, TAB_ICON_INK } from '../../constants/theme';

// Prominent raised center button for Mini Apps (the eye-catcher).
// Styles and the unread count are computed ONCE in TabLayout and passed down:
// each icon used to build its own StyleSheet and subscribe to the unread store.
type TabStyles = ReturnType<typeof makeStyles>;

function MiniCenterIcon({ focused, styles }: { focused: boolean; styles: TabStyles }) {
  const { metrics } = useVisionComfort();
  const { scheme } = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const normalLabels = fontScale <= 1.2 && metrics.textScale <= 1.15;
  return (
    <View style={[styles.centerWrap, { width: Math.min(64, (width - 32) / 5) }]} pointerEvents="none">
      <LinearGradient
        colors={APPS_DISC_GRADIENT[scheme]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.centerBtn, focused && styles.centerBtnActive]}
      >
        {/* Fixed white on the fixed brand disc in both themes, not a palette
            ink: ≥3:1 (graphics) on every APPS_DISC_GRADIENT stop. */}
        <TabGlyph name="mini" size={28} color="#FFFFFF" active={focused} />
      </LinearGradient>
      <AppText variant="tiny" color={TAB_ICON_INK.mini[scheme]} style={styles.centerLabel} numberOfLines={normalLabels ? 1 : 2} maxFontSizeMultiplier={TAB_LABEL_MAX_SCALE}>Apps</AppText>
    </View>
  );
}

function TabIcon({ tab, label, focused, styles, unread = 0 }: {
  tab: TabGlyphName; label: string; focused: boolean; styles: TabStyles; unread?: number;
}) {
  const c = useColors();
  const { metrics } = useVisionComfort();
  const { scheme } = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const normalLabels = fontScale <= 1.2 && metrics.textScale <= 1.15;
  const reduced = useReducedMotion();
  const lift = useRef(new Animated.Value(focused ? 1 : 0)).current;
  useEffect(() => {
    lift.stopAnimation();
    if (reduced) { lift.setValue(focused ? 1 : 0); return; }
    const animation = Animated.spring(lift, {
      toValue: focused ? 1 : 0,
      useNativeDriver: true,          // transform only — stays on the UI thread
      ...MOTION.springSnappy,
    });
    animation.start();
    return () => animation.stop();
  }, [focused, lift, reduced]);
  // One transform, not two: a mixed translate+scale array does not narrow in TS
  // without a cast, and the scale alone already reads as a lift.
  const anim = reduced
    ? undefined
    : { transform: [{ scale: lift.interpolate({ inputRange: [0, 1], outputRange: [1, 1.09] }) }] };
  const color = TAB_ICON_INK[tab][scheme];
  const badge = unread > 0;
  return (
    <View style={[styles.tabIconWrap, { width: Math.min(64, (width - 32) / 5) }]}>
      <Animated.View style={anim}>
        <TabGlyph name={tab} size={25 * metrics.controlScale} color={color} active={focused} />
        {badge && (
          <View style={styles.badge}>
            <AppText variant="tiny" color={c.onDanger} style={styles.badgeTxt} numberOfLines={1} maxFontSizeMultiplier={1.1}>{unread > 99 ? '99+' : unread}</AppText>
          </View>
        )}
      </Animated.View>
      <AppText variant="tiny" color={focused ? color : c.textDim} style={[styles.tabLabel, focused && styles.tabLabelActive]} numberOfLines={normalLabels ? 1 : 2} maxFontSizeMultiplier={TAB_LABEL_MAX_SCALE}>{label}</AppText>
      {focused ? <View style={[styles.activeDash, { backgroundColor: color }]} /> : null}
    </View>
  );
}

export default function TabLayout() {
  // THE TAB BAR MUST CLEAR THE SYSTEM NAVIGATION BAR.
  //
  // The height and bottom padding were hardcoded (65 / SPACING.sm on Android),
  // which assumed a device with no gesture bar. On a phone that reserves 24-48px
  // at the bottom the tab bar rendered UNDERNEATH it and the icons were clipped
  // — reported with a photo showing exactly that, and it is why the row looked
  // half cut off. insets.bottom is 0 on hardware-button devices, so this changes
  // nothing on those and only adds the space that is genuinely reserved.
  const c = useColors();
  const styles = useStyles(c);
  const insets = useSafeAreaInsets();
  // The badge is drawn inside the icon, which a screen reader does not read:
  // put the count in the tab's own label.
  const unread = useUnreadTotal();
  const tabBar = [
    styles.tabBar,
    { bottom: Math.max(insets.bottom, 10) + 12 },
  ];
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: tabBar,
        tabBarShowLabel: false,
        tabBarLabelPosition: 'below-icon',
        tabBarActiveTintColor: c.accentOn,
        tabBarInactiveTintColor: c.textFaint,
        tabBarItemStyle: styles.tabItem,
        // Real translucency, and the only blur pass on the screen. Content
        // scrolls underneath it, which is the entire point of the treatment.
        tabBarBackground: () => <GlassView kind="chrome" highlight style={styles.tabBarGlass} />,
      }}
    >
      <Tabs.Screen name="chats"   options={{ title: 'Chats',   tabBarAccessibilityLabel: unread > 0 ? `Chats, ${unread} unread` : 'Chats', tabBarIcon: ({ focused }) => <TabIcon tab="chats"   label="Chats"   focused={focused} styles={styles} unread={unread} /> }} />
      <Tabs.Screen name="status"  options={{ title: 'Status',  tabBarIcon: ({ focused }) => <TabIcon tab="status"  label="Status"  focused={focused} styles={styles} /> }} />
      {/* Center: Mini Apps — prominent raised button */}
      {/* The ONLY item that fills the bar's full (raised) height: its disc is
          drawn above the pill, and Android will not deliver a touch to a child
          outside its parent, so the item has to reach up to the art. The other
          four stay pinned to the pill so the band above it does not eat taps
          meant for the list behind. */}
      {/* BAR HIDDEN ON THIS SCREEN (2026-09-23). Mini Apps is a full-screen
          grid of its own and the floating bar competed with it. Safe to hide
          here because this screen already carries its own way out — the header
          back button — so nothing is stranded. `display: 'none'` rather than
          removing the Screen: the tab must stay routable and stay reachable
          from the bar on Chats, Status and Calls, which still show it. */}
      <Tabs.Screen name="mini"    options={{ title: 'Apps',    tabBarStyle: { display: 'none' }, tabBarItemStyle: styles.tabItemCenter, tabBarIconStyle: styles.centerIconBox, tabBarIcon: ({ focused }) => <MiniCenterIcon focused={focused} styles={styles} /> }} />
      <Tabs.Screen name="calls"   options={{ title: 'Calls',   tabBarIcon: ({ focused }) => <TabIcon tab="calls"   label="Calls"   focused={focused} styles={styles} /> }} />
      {/* BAR HIDDEN HERE TOO — and this one needed a back control added first.
          Profile had NO way off it other than the bar: no header back, no
          router.back() anywhere in the file. Hiding the bar without that would
          have stranded the screen on iOS, which has no hardware back. */}
      <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarStyle: { display: 'none' }, tabBarIcon: ({ focused }) => <TabIcon tab="profile" label="Profile" focused={focused} styles={styles} /> }} />
      {/* Routable but hidden from the bar — opened from the Chats header */}
      <Tabs.Screen name="alerts"  options={{ href: null }} />
    </Tabs>
  );
}

const useStyles = (c: Palette) => {
  const { metrics } = useVisionComfort();
  const { fontScale } = useWindowDimensions();
  return useMemo(() => makeStyles(c, visionTabBarGrowth(fontScale, metrics.textScale, metrics.lineScale, metrics.controlScale)), [c, fontScale, metrics]);
};

const makeStyles = (c: Palette, barGrowth: number) => StyleSheet.create({
  tabBar: {
    position: 'absolute',
    left: 16,
    right: 16,
    // The pill grows for OS and profile font scaling; the raised Apps disc
    // stays inside its touchable through TAB_BAR_RAISE.
    height: 70 + barGrowth + TAB_BAR_RAISE,
    paddingTop: 8,
    paddingBottom: 8,
    backgroundColor: 'transparent',
    borderTopWidth: 0,
    // Must stay visible so the raised Apps disc can break the bar's outline.
    overflow: 'visible',
    elevation: 0,
    shadowColor: TAB_BAR_SHADOW,
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.55,
    shadowRadius: 28,
  },
  tabBarGlass: {
    ...StyleSheet.absoluteFillObject,
    top: TAB_BAR_RAISE,          // leave the transparent touch band above the pill
    borderRadius: 30,
  },
  // flex-end keeps the four side tabs on the pill, exactly where they were.
  tabItem: { height: 54 + barGrowth, alignSelf: 'flex-end' },
  tabItemCenter: { alignSelf: 'stretch' },
  tabIconWrap: { alignItems: 'center', justifyContent: 'center', gap: 3, width: 64 },
  tabLabel: { marginTop: 1, fontSize: barGrowth > 0 ? 10.5 : 11, lineHeight: 16, ...(barGrowth > 0 ? { textAlign: 'center' as const, maxWidth: '100%' as const } : {}) },
  tabLabelActive: { fontWeight: '800' },
  activeDash: { position: 'absolute', bottom: -4, width: 12, height: 2, borderRadius: 1 },
  // Raised, glowing center button for Mini Apps.
  centerWrap: { alignItems: 'center', justifyContent: 'center', width: 64 },
  // react-navigation lays the icon wrapper out from the TOP of the item, so
  // growing the item upwards would have dragged the disc up with it. This puts
  // it back: the art paints exactly where it always did, only the touchable
  // moved. (It goes on the wrapper, not on centerWrap — the wrapper CENTERS
  // its child, so a margin in there would only move the art by half.)
  centerIconBox: { marginTop: TAB_BAR_RAISE },
  centerBtn: {
    width: 54, height: 54, borderRadius: 27,
    alignItems: 'center', justifyContent: 'center',
    marginTop: -24,                       // pop above the glass pill
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke,
    shadowColor: c.accentDeep, shadowOpacity: 0.6, shadowRadius: 18, shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  centerBtnActive: { transform: [{ scale: 1.06 }] },
  centerLabel: { marginTop: 3, lineHeight: 16, fontWeight: '700', ...(barGrowth > 0 ? { textAlign: 'center' as const, maxWidth: '100%' as const } : {}) },
  badge: {
    position: 'absolute', top: -5, right: -10, minWidth: 18, height: 18, borderRadius: 9,
    backgroundColor: c.danger, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4,
  },
  badgeTxt: { fontSize: 10, fontWeight: '800', lineHeight: 14 },
});
