// app/group-chat.tsx — redirect shim for old deep links only.
//
// The standalone Firestore group-chat screen is superseded by the shared,
// Postgres-backed /chat screen, which renders both direct and group chats.
// Nothing in the app links here (lib/orphanRoutes.selftest.ts pins that); it
// exists so an old `/group-chat?chatId=…` link still opens the chat.
//
// <Redirect> replaces the route as it mounts and renders nothing: no spinner to
// flash, nothing for a screen reader to announce. A link without an id has no
// chat to open, so it lands on the chat list, not on a Back that a cold-start
// deep link has nowhere to go.

import { Redirect, useLocalSearchParams } from 'expo-router';

export default function GroupChatRedirect() {
  const params = useLocalSearchParams<{ chatId?: string; id?: string; groupName?: string }>();
  const id = String(params.chatId ?? params.id ?? '');
  if (!id) return <Redirect href={'/(tabs)/chats' as any} />;
  return <Redirect href={{ pathname: '/chat', params: { id, name: String(params.groupName ?? '') } } as any} />;
}
