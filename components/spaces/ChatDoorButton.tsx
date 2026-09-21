// components/spaces/ChatDoorButton.tsx — the one door back to a group's chat
// thread (chat-map-separation D5), shared by every space header and the
// family screen's own header so a size/label/route change lands once.
//
// Before this it was written twice by hand and already drifting on day one:
// spaceHeader used size 21 and "Open the space chat", family.tsx used size 20
// and "Open the group chat". Both call sites now render exactly this
// component; the two accessibility labels are kept as distinct PROPS (neither
// original wording was wrong), everything else — icon, size, route — is one
// definition.

import { TouchableOpacity } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import type { Palette } from '../../constants/theme';

export interface ChatDoorTarget {
  id: string;
  /** Raw route param — `useLocalSearchParams` can hand back `string[]` or
   *  `undefined`; normalized here so no call site repeats that ternary. */
  name?: unknown;
}

export default function ChatDoorButton({ colors, chat, fallbackTitle, accessibilityLabel = 'Open the group chat' }: {
  colors: Palette;
  chat: ChatDoorTarget;
  /** Used as the chat's title only when `chat.name` isn't a plain string. */
  fallbackTitle?: string;
  accessibilityLabel?: string;
}) {
  const name = typeof chat.name === 'string' ? chat.name : fallbackTitle;
  return (
    <TouchableOpacity
      onPress={() => router.push({ pathname: '/chat', params: { id: chat.id, name } } as any)}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
    >
      <Ionicons name="chatbubble-ellipses-outline" size={20} color={colors.primary} />
    </TouchableOpacity>
  );
}
