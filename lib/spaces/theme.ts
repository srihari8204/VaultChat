// lib/spaces/theme.ts — which palette a space screen renders with.
//
// Business/office spaces (and cab fleets) get the VaultChat Business design
// system — blue on deep navy, dark-only. Every other space family keeps the
// app-wide theme. The family routing is familyOf() in layout.ts, the same
// decision that already picks the dashboard sections, so the skin and the
// content can never disagree about what kind of space this is.

import { createElement } from 'react';
import { useTheme } from '../theme';
import type { Palette } from '../../constants/theme';
import { BIZ } from '../../constants/businessTheme';
import { usesBusinessTheme } from './layout';
import ChatDoorButton, { type ChatDoorTarget } from '../../components/spaces/ChatDoorButton';

/** The palette for a space screen. Pass the route's groupType param. */
export function useSpaceColors(groupType?: string | null): Palette {
  const { colors } = useTheme();
  // The decision itself is pure and pinned by layout.ts's self-check plus
  // scripts/check-space-identity.ts: family/school/generic NEVER get BIZ.
  return usesBusinessTheme(groupType) ? BIZ : colors;
}

/**
 * Native-stack header options for a space screen, in the space's palette.
 *
 * The root layout hides headers app-wide; the space module opts back in here
 * because its screens were written for native headers — titles, the back
 * button, and the headerRight add-buttons (visitors, roster, devices, runs)
 * simply did not exist until this. The native header also owns the status-bar
 * inset, which is what kept content off the top of the display.
 */
export function spaceHeader(colors: Palette, title: string, chat?: ChatDoorTarget) {
  return {
    headerShown: true,
    title,
    headerStyle: { backgroundColor: colors.bg },
    headerTintColor: colors.text,
    headerShadowVisible: false,
    // The door back to the group's ONE chat thread (chat-map-separation D5).
    // `chat.name` accepts whatever useLocalSearchParams hands back — the
    // normalization (only a plain string counts) lives in ChatDoorButton, not
    // repeated at each of this function's call sites. createElement, not JSX:
    // this file is .ts and stays that way.
    // Screens that pass their own headerRight (roster, devices, runs-admin,
    // visitors) override this — their action row wins; the chat door for those
    // is the space overview one tap up.
    ...(chat?.id ? {
      headerRight: () =>
        createElement(ChatDoorButton, {
          colors, chat, fallbackTitle: title, accessibilityLabel: 'Open the space chat',
        }),
    } : null),
  } as const;
}
