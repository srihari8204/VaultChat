// app/(tabs)/_layout.tsx
// 5-tab navigation: Chats | Status | [Mini Apps] | Calls | Profile.
// Mini Apps sits in the CENTER as a prominent raised/glowing button. Alerts
// stays a hidden route (href: null), reached from the Chats header.
// U5: vector icons (Ionicons) instead of emoji + Aurora design tokens.

import { Tabs } from 'expo-router';
import React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Aurora, SPACING } from '../../constants/theme';
import { AppText } from '../../components/ui/Text';
import { useUnreadTotal } from '../../lib/unreadStore';

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
  return (
    <View style={styles.centerWrap} pointerEvents="none">
      <View style={[styles.centerBtn, focused && styles.centerBtnActive]}>
        <Ionicons name="grid" size={24} color="#fff" />
      </View>
      <AppText variant="tiny" color={focused ? Aurora.primary : Aurora.textDim} style={styles.centerLabel}>Apps</AppText>
    </View>
  );
}

function TabIcon({ tab, label, focused }: { tab: keyof typeof ICONS; label: string; focused: boolean }) {
  const g = ICONS[tab];
  const color = focused ? Aurora.primary : Aurora.textDim;
  const unread = useUnreadTotal();
  const badge = tab === 'chats' && unread > 0;
  return (
    <View style={styles.tabIconWrap}>
      <View>
        <Ionicons name={focused ? g.on : g.off} size={22} color={color} />
        {badge && (
          <View style={styles.badge}>
            <AppText variant="tiny" color="#fff" style={styles.badgeTxt}>{unread > 99 ? '99+' : unread}</AppText>
          </View>
        )}
      </View>
      <AppText variant="tiny" color={color} style={styles.tabLabel}>{label}</AppText>
    </View>
  );
}

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: styles.tabBar,
        tabBarShowLabel: false,
        tabBarActiveTintColor: Aurora.primary,
        tabBarInactiveTintColor: Aurora.textDim,
      }}
    >
      <Tabs.Screen name="chats"   options={{ title: 'Chats',   tabBarIcon: ({ focused }) => <TabIcon tab="chats"   label="Chats"   focused={focused} /> }} />
      <Tabs.Screen name="status"  options={{ title: 'Status',  tabBarIcon: ({ focused }) => <TabIcon tab="status"  label="Status"  focused={focused} /> }} />
      {/* Center: Mini Apps — prominent raised button */}
      <Tabs.Screen name="mini"    options={{ title: 'Apps',    tabBarIcon: ({ focused }) => <MiniCenterIcon focused={focused} /> }} />
      <Tabs.Screen name="calls"   options={{ title: 'Calls',   tabBarIcon: ({ focused }) => <TabIcon tab="calls"   label="Calls"   focused={focused} /> }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarIcon: ({ focused }) => <TabIcon tab="profile" label="Profile" focused={focused} /> }} />
      {/* Routable but hidden from the bar — opened from the Chats header */}
      <Tabs.Screen name="alerts"  options={{ href: null }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: Aurora.surfaceSolid,
    borderTopWidth: 1,
    borderTopColor: Aurora.border,
    height: Platform.OS === 'ios' ? 85 : 65,
    paddingTop: SPACING.sm,
    paddingBottom: Platform.OS === 'ios' ? 24 : SPACING.sm,
    elevation: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  tabIconWrap: { alignItems: 'center', justifyContent: 'center', gap: 3, width: 64 },
  tabLabel: { marginTop: 1 },
  // Raised, glowing center button for Mini Apps.
  centerWrap: { alignItems: 'center', justifyContent: 'center', width: 64 },
  centerBtn: {
    width: 54, height: 54, borderRadius: 27,
    backgroundColor: Aurora.primary,
    alignItems: 'center', justifyContent: 'center',
    marginTop: -22,                       // pop above the bar
    borderWidth: 4, borderColor: Aurora.surfaceSolid,
    shadowColor: Aurora.primary, shadowOpacity: 0.55, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
    elevation: 10,
  },
  centerBtnActive: { transform: [{ scale: 1.06 }] },
  centerLabel: { marginTop: 3, fontWeight: '700' },
  badge: {
    position: 'absolute', top: -5, right: -10, minWidth: 18, height: 18, borderRadius: 9,
    backgroundColor: Aurora.danger, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4,
  },
  badgeTxt: { fontSize: 10, fontWeight: '800', lineHeight: 14 },
});
