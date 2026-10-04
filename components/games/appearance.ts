import { createContext, useContext } from 'react';
import type { Palette } from '../../constants/theme';
import { C } from '../../lib/games/theme';
import { LIGHT_HUB } from '../../constants/gamesPalette';

type GamePalette = Record<keyof typeof C, string> & { light?: boolean };

// Only the launcher opts in. Playing boards retain the original room palette.
export const GamePaletteContext = createContext<GamePalette | null>(null);
export const useGamePalette = (): GamePalette => useContext(GamePaletteContext) ?? C;
export const lightHubPalette = (p: Palette): GamePalette => ({
  ...C, light: true,
  bg: p.bg, bg2: p.surfaceSolid, panel: p.card, panel2: p.surfaceSolid,
  card: p.card, line: p.glassStroke, text: p.text, muted: p.textDim,
  gold: LIGHT_HUB.gold, gold2: LIGHT_HUB.gold, goldDeep: LIGHT_HUB.gold,
  good: p.success, win: p.success, bad: p.danger, lose: p.danger,
});
