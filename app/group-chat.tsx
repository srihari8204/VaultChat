// app/group-chat.tsx — legacy redirect.
//
// The standalone Firestore group-chat screen is superseded by the shared,
// Postgres-backed /chat screen, which renders both direct and group chats
// (members, polls, reactions, disappearing messages, the lot). This module
// now just forwards any old navigation here to /chat so there is one chat
// surface and no remaining Firebase dependency.

import React, { useEffect } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Aurora } from '../constants/theme';

export default function GroupChatRedirect() {
  const router = useRouter();
  const params = useLocalSearchParams<{ chatId?: string; id?: string; groupName?: string }>();
  const id = String(params.chatId ?? params.id ?? '');

  useEffect(() => {
    if (id) router.replace({ pathname: '/chat', params: { id, name: params.groupName ?? '' } } as any);
    else router.back();
  }, [id]);

  return (
    <View style={s.center}>
      <Stack.Screen options={{ headerShown: false }} />
      <ActivityIndicator color={Aurora.primary} size="large" />
    </View>
  );
}

const s = StyleSheet.create({
  center: { flex: 1, backgroundColor: Aurora.bg, justifyContent: 'center', alignItems: 'center' },
});
