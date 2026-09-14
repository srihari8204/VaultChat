// app/(tabs)/_layout.tsx
// 5-tab navigation: Chats | Status | [Mini Apps] | Calls | Profile.
// Mini Apps sits in the CENTER as a prominent raised/glowing button. Alerts
// stays a hidden route (href: null), reached from the Chats header.
// U5: vector icons (Ionicons) instead of emoji + Aurora design tokens.

import { Tabs } from 'expo-router';
import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import type { Palette } from '../../constants/theme';
import { useColors } from '../../lib/theme';
import { AppText } from '../../components/ui/Text';
import { GlassView } from '../../components/ui/GlassView';
import { TAB_BAR_RAISE } from '../../constants/layout';
import { useUnreadTotal } from '../../lib/unreadStore';
import { useReducedMotion } from '../../lib/useReducedMotion';
import { MOTION } from '../../constants/theme';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

// Each tab's filled (active) + outline (inactive) glyphs.
const ICONS: Record<string, { on: IoniconName; off: IoniconName }> = {
  chats:   { on: 'chatbubble',     off: 'chatbubble-outline' },
  status:  { on: 'aperture',       off: 'aperture-outline' },
  calls:   { on: 'call',           off: 'call-outline' },
  mini:    { on: 'grid',           off: 'grid-outline' },
  alerts:  { on: 'notifications',  off: 'notifications-outline' },
  profile: { on: 'person',         off: 'person-outline' },
};

// Prominent raised center button for Mini Apps (the eye-catcher).
function MiniCenterIcon({ focused }: { focused: boolean }) {
  const c = useColors();
  const styles = useStyles(c);
  return (
    <View style={styles.centerWrap} pointerEvents="none">
      <LinearGradient
        colors={[c.accentLight, c.accentDeep]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.centerBtn, focused && styles.centerBtnActive]}
      >
        <Ionicons name="grid" size={24} color="#fff" />
      </LinearGradient>
      <AppText variant="tiny" color={focused ? c.accentOn : c.textFaint} style={styles.centerLabel} numberOfLines={1} maxFontSizeMultiplier={1.2}>Apps</AppText>
    </View>
  );
}

function TabIcon({ tab, label, focused }: { tab: keyof typeof ICONS; label: string; focused: boolean }) {
  const c = useColors();
  const styles = useStyles(c);
  const reduced = useReducedMotion();
  const lift = useRef(new Animated.Value(focused ? 1 : 0)).current;
  useEffect(() => {
    Animated.spring(lift, {
      toValue: focused ? 1 : 0,
      useNativeDriver: true,          // transform only — stays on the UI thread
      ...MOTION.springSnappy,
    }).start();
  }, [focused, lift]);
  // One transform, not two: a mixed translate+scale array does not narrow in TS
  // without a cast, and the scale alone already reads as a lift.
  const anim = reduced
    ? undefined
    : { transform: [{ scale: lift.interpolate({ inputRange: [0, 1], outputRange: [1, 1.09] }) }] };
  const g = ICONS[tab];
  const color = focused ? c.accentOn : c.textFaint;
  const unread = useUnreadTotal();
  const badge = tab === 'chats' && unread > 0;
  return (
    <View style={styles.tabIconWrap}>
      <Animated.View style={anim}>
        <Ionicons name={focused ? g.on : g.off} size={22} color={color} />
        {badge && (
          <View style={styles.badge}>
            <AppText variant="tiny" color="#fff" style={styles.badgeTxt} numberOfLines={1} maxFontSizeMultiplier={1.1}>{unread > 99 ? '99+' : unread}</AppText>
          </View>
        )}
      </Animated.View>
      <AppText variant="tiny" color={color} style={styles.tabLabel} numberOfLines={1} maxFontSizeMultiplier={1.2}>{label}</AppText>
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
        tabBarActiveTintColor: c.accentOn,
        tabBarInactiveTintColor: c.textFaint,
        tabBarItemStyle: styles.tabItem,
        // Real translucency, and the only blur pass on the screen. Content
        // scrolls underneath it, which is the entire point of the treatment.
        tabBarBackground: () => <GlassView kind="chrome" highlight style={styles.tabBarGlass} />,
      }}
    >
      <Tabs.Screen name="chats"   options={{ title: 'Chats',   tabBarIcon: ({ focused }) => <TabIcon tab="chats"   label="Chats"   focused={focused} /> }} />
      <Tabs.Screen name="status"  options={{ title: 'Status',  tabBarIcon: ({ focused }) => <TabIcon tab="status"  label="Status"  focused={focused} /> }} />
      {/* Center: Mini Apps — prominent raised button */}
      {/* The ONLY item that fills the bar's full (raised) height: its disc is
          drawn above the pill, and Android will not deliver a touch to a child
          outside its parent, so the item has to reach up to the art. The other
          four stay pinned to the pill so the band above it does not eat taps
          meant for the list behind. */}
      <Tabs.Screen name="mini"    options={{ title: 'Apps',    tabBarItemStyle: styles.tabItemCenter, tabBarIconStyle: styles.centerIconBox, tabBarIcon: ({ focused }) => <MiniCenterIcon focused={focused} /> }} />
      <Tabs.Screen name="calls"   options={{ title: 'Calls',   tabBarIcon: ({ focused }) => <TabIcon tab="calls"   label="Calls"   focused={focused} /> }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarIcon: ({ focused }) => <TabIcon tab="profile" label="Profile" focused={focused} /> }} />
      {/* Routable but hidden from the bar — opened from the Chats header */}
      <Tabs.Screen name="alerts"  options={{ href: null }} />
    </Tabs>
  );
}

const useStyles = (c: Palette) => useMemo(() => makeStyles(c), [c]);

const makeStyles = (c: Palette) => StyleSheet.create({
  tabBar: {
    position: 'absolute',
    left: 16,
    right: 16,
    // Taller than the 66pt pill it paints: the extra TAB_BAR_RAISE at the top
    // is a transparent band that exists only so the raised Apps disc lands
    // inside a touchable. tabBarGlass insets past it, so nothing moves.
    height: 66 + TAB_BAR_RAISE,
    paddingTop: 8,
    paddingBottom: 8,
    backgroundColor: 'transparent',
    borderTopWidth: 0,
    // Must stay visible so the raised Apps disc can break the bar's outline.
    overflow: 'visible',
    elevation: 0,
    shadowColor: '#05030D',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.55,
    shadowRadius: 28,
  },
  tabBarGlass: {
    ...StyleSheet.absoluteFillObject,
    top: TAB_BAR_RAISE,          // the pill is still 66pt, in the same place
    borderRadius: 30,
  },
  // flex-end keeps the four side tabs on the pill, exactly where they were.
  tabItem: { height: 50, alignSelf: 'flex-end' },
  tabItemCenter: { alignSelf: 'stretch' },
  tabIconWrap: { alignItems: 'center', justifyContent: 'center', gap: 3, width: 64 },
  tabLabel: { marginTop: 1 },
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
  centerLabel: { marginTop: 3, fontWeight: '700' },
  badge: {
    position: 'absolute', top: -5, right: -10, minWidth: 18, height: 18, borderRadius: 9,
    backgroundColor: c.danger, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4,
  },
  badgeTxt: { fontSize: 10, fontWeight: '800', lineHeight: 14 },
});
