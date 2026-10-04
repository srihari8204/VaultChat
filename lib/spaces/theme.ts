// lib/spaces/theme.ts — which palette a space screen renders with.
//
// Business/office spaces (and cab fleets) get the crazzychat Business design
// identity — blue accents over the active day/night theme. Other spaces keep the
// app-wide theme. The family routing is familyOf() in layout.ts, the same
// decision that already picks the dashboard sections, so the skin and the
// content can never disagree about what kind of space this is.

import { createElement, useMemo } from 'react';
import { useTheme } from '../theme';
import type { Palette } from '../../constants/theme';
import { businessPalette } from '../../constants/businessTheme';
import { SPACE_GLASS } from '../../constants/spaceTheme';
import { usesBusinessTheme } from './layout';
import ChatDoorButton, { type ChatDoorTarget } from '../../components/spaces/ChatDoorButton';

/**
 * The palette for a space screen. Pass the route's groupType param.
 *
 * Spaces wear the DUSK-GLASS skin here, at the palette layer:
 * every operational screen builds its styles from these six surface tokens,
 * so mapping them onto SPACE_GLASS restyles the whole tier in one place —
 * the same trick financeTheme used ("two token names carry the restyle").
 * The screens draw their theme-aware ground behind these translucent panes.
 * Business/office/cab retain blue identity accents while text and surfaces
 * follow the active scheme, so light Aurora grounds never carry navy's white
 * text. The identity split is pinned by check-space-identity.
 */
export type SpacePalette = Palette & {
  warning: string;
  /** Ink ON a solid `brandOnLight` fill (selected chips, primary buttons, FABs).
   *  brandOnLight is the same deep blue (#1552E0) in both schemes, so this is
   *  white in both: 6.33:1. Not `onPrimary` — that pairs with `primary`, which
   *  is a lighter blue in dark mode. */
  onBrand: string;
};

export function useSpaceColors(groupType?: string | null): SpacePalette {
  const { colors, scheme } = useTheme();
  const biz = usesBusinessTheme(groupType);
  return useMemo(() => {
    const G = SPACE_GLASS[scheme];
    return {
      ...(biz ? businessPalette(colors, scheme) : colors),
      bg: G.bgMid,
      card: G.pane,
      // Ink hairline, not the lit rim: chips, inputs and card outlines all
      // ride `border` here, and a white rim on the light ground is invisible.
      border: G.chipEdge,
      separator: G.line,
      surface: G.paneFaint,
      surfaceSolid: G.sheet,
      warning: G.warnText,
      onBrand: '#FFFFFF',
    };
  }, [biz, colors, scheme]);
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
