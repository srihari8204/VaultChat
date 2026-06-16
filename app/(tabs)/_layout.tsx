// app/(tabs)/_layout.tsx
// 6-tab navigation: Chats | Status | Calls | Mini | Alerts | Profile.
// U5: vector icons (Ionicons) instead of emoji + Aurora design tokens instead of
// the old ad-hoc purple — one consistent, accessible icon language.

import { Tabs } from 'expo-router';
import React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Aurora, SPACING } from '../../constants/theme';
import { AppText } from '../../components/ui/Text';

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

function TabIcon({ tab, label, focused }: { tab: keyof typeof ICONS; label: string; focused: boolean }) {
  const g = ICONS[tab];
  const color = focused ? Aurora.primary : Aurora.textDim;
  return (
    <View style={styles.tabIconWrap}>
      <Ionicons name={focused ? g.on : g.off} size={22} color={color} />
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
      <Tabs.Screen name="calls"   options={{ title: 'Calls',   tabBarIcon: ({ focused }) => <TabIcon tab="calls"   label="Calls"   focused={focused} /> }} />
      <Tabs.Screen name="mini"    options={{ title: 'Mini',    tabBarIcon: ({ focused }) => <TabIcon tab="mini"    label="Mini"    focused={focused} /> }} />
      <Tabs.Screen name="alerts"  options={{ title: 'Alerts',  tabBarIcon: ({ focused }) => <TabIcon tab="alerts"  label="Alerts"  focused={focused} /> }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarIcon: ({ focused }) => <TabIcon tab="profile" label="Profile" focused={focused} /> }} />
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
});
