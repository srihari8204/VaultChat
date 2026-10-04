// components/SafetyNavBar.tsx — the bottom bar shared by Alerts & Safety
// (app/notifications.tsx) and the Security Hub (app/dashboard.tsx).
//
// It was copied into both screens and pushed a new screen on every tap, so
// hopping between the two piled up the stack. dismissTo pops back to the
// destination when it is already in the history and otherwise replaces this
// screen, so the bar behaves like tabs.
import { Ionicons } from '@expo/vector-icons';
import { useRouter, type Href } from 'expo-router';
import { useMemo, type ComponentProps } from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { SCREEN_BOTTOM } from '../constants/layout';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { AppText as Text } from './ui/Text';

export type SafetyNavId = 'chats' | 'shield' | 'community' | 'vault' | 'alerts';

const NAV: { id: SafetyNavId; icon: ComponentProps<typeof Ionicons>['name']; label: string; route: Href }[] = [
  { id: 'chats', icon: 'chatbubbles-outline', label: 'Chats', route: '/(tabs)/chats' },
  { id: 'shield', icon: 'shield-checkmark-outline', label: 'Shield', route: '/dashboard' },
  { id: 'community', icon: 'people-outline', label: 'Community', route: '/communities' },
  { id: 'vault', icon: 'file-tray-full-outline', label: 'Vault', route: '/filevault' },
  { id: 'alerts', icon: 'notifications-outline', label: 'Alerts', route: '/notifications' },
];

export function SafetyNavBar({ current }: { current: SafetyNavId }) {
  const { colors } = useTheme();
  const S = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  return (
    <View style={S.navBar} accessibilityRole="tablist">
      {NAV.map(item => {
        const on = item.id === current;
        return (
          <TouchableOpacity
            key={item.id}
            accessibilityRole="tab"
            accessibilityLabel={item.label}
            accessibilityState={{ selected: on }}
            onPress={() => { if (!on) router.dismissTo(item.route); }}
            style={[S.navItem, on && S.navItemActive]}
          >
            <Ionicons name={item.icon} size={22} color={on ? colors.primary : colors.textDim} />
            <Text style={[S.navLabel, { color: on ? colors.primary : colors.textDim }]}>{item.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  navBar: { marginHorizontal: 14, marginBottom: SCREEN_BOTTOM, backgroundColor: c.glass, borderRadius: 24, borderWidth: 1, borderColor: c.glassStroke, paddingVertical: 8, paddingHorizontal: 4, flexDirection: 'row', alignItems: 'stretch' },
  navItem: { flex: 1, minWidth: 0, minHeight: 44, alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 2, borderRadius: 18, borderWidth: 1, borderColor: 'transparent' },
  navItemActive: { backgroundColor: c.glassSoft, borderColor: c.glassStroke },
  navLabel: { fontSize: 11, fontWeight: '600', textAlign: 'center' },
});
