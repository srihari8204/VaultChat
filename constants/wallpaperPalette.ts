// constants/wallpaperPalette.ts — the chat wallpaper presets (app/chat-wallpaper.tsx).
//
// WHY THESE COLOURS ARE FIXED
// These are wallpaper CONTENT, not UI colour: a user who picks "Night" or
// "Dawn" gets that exact backdrop in both the light and dark app themes, the
// same way a photo wallpaper does not change with the theme. So they are not
// theme tokens. A preset's colours are also COPIED into the saved choice
// (WallpaperConfig.value for a solid, WallpaperConfig.colors for a gradient),
// so changing a hex here does not repaint wallpapers already saved; renaming a
// gradient id makes saved ones show "Gradient" as their name.
//
// WHAT IS DRAWN ON THEM
// The picker draws a check mark on the selected tile. It is not in a theme
// colour (the theme's primary blue is under 3:1 on several dark presets): it
// uses wallpaperInk(), the dark or light ink with the higher contrast across
// every stop of that preset. constants/wallpaperPalette.selftest.ts asserts
// that ink reaches AA text contrast (4.5:1) on every stop of every preset.
// The chat itself draws its bubbles (own fill and ink) over the wallpaper.

import { contrastOn, fillInks } from '../components/chat/bubbleFillInk';

/** Solid wallpapers — a bright row then a dark row. `name` is what a screen reader announces. */
export const SOLID_WALLPAPERS: readonly { hex: string; name: string }[] = [
  { hex: '#ECE5DD', name: 'Classic beige' }, { hex: '#E4DDD3', name: 'Sand' },
  { hex: '#DCEAF5', name: 'Pale blue' },     { hex: '#EAF2E9', name: 'Mint' },
  { hex: '#F5E6E8', name: 'Blush' },         { hex: '#E8EAF0', name: 'Cloud grey' },
  { hex: '#F0E6D8', name: 'Cream' },         { hex: '#E6EEF5', name: 'Ice blue' },
  { hex: '#FFFFFF', name: 'White' },         { hex: '#F6F7F9', name: 'Off-white' },
  { hex: '#0B141A', name: 'Night' },         { hex: '#1F2C34', name: 'Slate' },
  { hex: '#131C21', name: 'Charcoal' },      { hex: '#17212B', name: 'Ink blue' },
  { hex: '#202C33', name: 'Graphite' },      { hex: '#0A0A0F', name: 'Black' },
  { hex: '#102027', name: 'Deep teal' },     { hex: '#1A1A2E', name: 'Midnight blue' },
  { hex: '#0B3D2E', name: 'Forest green' },  { hex: '#075E54', name: 'Teal green' },
];

/** Gradient wallpapers. `id` is stored in the saved choice; keep it stable. */
export const GRADIENT_WALLPAPERS: readonly { id: string; name: string; colors: string[] }[] = [
  { id: 'midnight',  name: 'Midnight',  colors: ['#0a0a2e', '#1a1a4e'] },
  { id: 'ocean',     name: 'Ocean',     colors: ['#001427', '#003459'] },
  { id: 'forest',    name: 'Forest',    colors: ['#0b1a0b', '#1a3a1a'] },
  { id: 'teal',      name: 'Teal',      colors: ['#053b34', '#0b6b5b'] },
  { id: 'sunset',    name: 'Sunset',    colors: ['#1a0a2e', '#2d1b4e', '#4a1942'] },
  { id: 'arctic',    name: 'Arctic',    colors: ['#0a1628', '#0d2137'] },
  { id: 'ember',     name: 'Ember',     colors: ['#1a0a00', '#2a1500'] },
  { id: 'steel',     name: 'Steel',     colors: ['#0e1117', '#1a1e25'] },
  { id: 'dawn',      name: 'Dawn',      colors: ['#dfe9f3', '#ffffff'] },
];

/**
 * Ink for a mark drawn on a preset tile: of the dark and light inks
 * (components/chat/bubbleFillInk), the one whose WORST contrast across the
 * preset's stops is highest, so it reads on every part of a gradient.
 */
export function wallpaperInk(stops: readonly string[]): string {
  const inks = [...new Set(stops.map(s => fillInks(s).text))];
  const worst = (ink: string) => Math.min(...stops.map(s => contrastOn(ink, s)));
  return inks.reduce((a, b) => (worst(b) > worst(a) ? b : a));
}
