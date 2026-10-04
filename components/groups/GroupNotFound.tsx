// components/groups/GroupNotFound.tsx — the state a group screen shows when it
// was opened without a group id (a stale or malformed link). Without it each
// screen fell through to its empty state ("No members.", "Nothing this month"),
// which reads as a real, empty group.

import React from 'react';
import { TouchableOpacity, View } from 'react-native';
import { Stack, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../lib/theme';
import { AuroraBackground } from '../ui/AuroraBackground';
import { AppText as Text } from '../ui/Text';

export function GroupNotFound({ title, detail }: { title: string; detail?: string }) {
  const { colors } = useTheme();
  const leave = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats' as any));
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
      <AuroraBackground variant="chat" />
      <Stack.Screen options={{
        headerShown: true, headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text,
        headerShadowVisible: false, title, headerTitleAlign: 'center',
      }} />
      <Ionicons name="help-circle-outline" size={32} color={colors.textFaint} />
      <Text accessibilityRole="header" style={{ color: colors.text, fontWeight: '700', fontSize: 15, marginTop: 10 }}>
        Group not found
      </Text>
      <Text style={{ color: colors.textDim, fontSize: 13, textAlign: 'center', marginTop: 6 }}>
        {detail ?? 'This link did not say which group to open.'}
      </Text>
      <TouchableOpacity onPress={leave} accessibilityRole="button" hitSlop={8}
        style={{ marginTop: 18, paddingHorizontal: 22, minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: colors.glassStroke, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: colors.text, fontWeight: '700' }}>Go back</Text>
      </TouchableOpacity>
    </View>
  );
}
