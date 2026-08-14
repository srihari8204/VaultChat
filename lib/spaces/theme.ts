// lib/spaces/theme.ts — which palette a space screen renders with.
//
// Business/office spaces (and cab fleets) get the VaultChat Business design
// system — blue on deep navy, dark-only. Every other space family keeps the
// app-wide theme. The family routing is familyOf() in layout.ts, the same
// decision that already picks the dashboard sections, so the skin and the
// content can never disagree about what kind of space this is.

import { useTheme } from '../theme';
import type { Palette } from '../../constants/theme';
import { BIZ } from '../../constants/businessTheme';
import { usesBusinessTheme } from './layout';

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
export function spaceHeader(colors: Palette, title: string) {
  return {
    headerShown: true,
    title,
    headerStyle: { backgroundColor: colors.bg },
    headerTintColor: colors.text,
    headerShadowVisible: false,
  } as const;
}
