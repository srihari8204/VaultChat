// constants/miniAppPalette.ts — the Mini Apps launcher's tile artwork.
//
// WHY THESE COLOURS ARE FIXED. Each tile gradient is that mini app's own icon,
// the way an app-store icon is the app's artwork: it is the same in light and
// dark, and it is not UI chrome, so no theme token stands in for it. The glyph
// drawn on top is white, except where white fails: on Notes' amber white is
// 2.15:1, so Notes uses the light theme's text ink instead.
//
// constants/miniAppPalette.selftest.ts proves every glyph is at least 3:1
// (WCAG 1.4.11, non-text contrast for a graphic) against BOTH stops of its
// gradient. Change a colour here and run it.
import { AuroraLight } from './theme';

export const MINI_TILE_GLYPH = '#FFFFFF';
export const MINI_TILE_GLYPH_DARK = AuroraLight.text;

export interface MiniTileArt {
  gradient: [string, string];
  glyph: string;
}

const art = (from: string, to: string, glyph = MINI_TILE_GLYPH): MiniTileArt => ({ gradient: [from, to], glyph });

export const MINI_TILE_ART = {
  live:        art('#EF4444', '#B91C1C'),
  navigate:    art('#1777FE', '#1D4ED8'),
  familyspace: art('#7C3AED', '#2563EB'),
  finance:     art('#6D3FA8', '#1552E0'),
  shopbook:    art('#0B7A3B', '#16A34A'),
  notes:       art('#F59E0B', '#D97706', MINI_TILE_GLYPH_DARK),
  scanner:     art('#1777FE', '#1D4ED8'),
  shelf:       art('#B45309', '#D97706'),
  games:       art('#DB2777', '#7C3AED'),
  security:    art('#0E7490', '#164E63'),
} satisfies Record<string, MiniTileArt>;
