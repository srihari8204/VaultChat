// lib/chatBubbleTheme.ts — the outgoing-bubble colour choice (app/chat-themes.tsx
// edits it, app/chat.tsx paints with it). Storage keys and the resolve rule live
// here, not in the route file, so the chat does not import a screen.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { resolveScoped } from './scopedChoice';
import { fillInks } from './bubbleFillInk';

export const BUBBLE_KEY = 'vc_bubble_color_';
export const GLOBAL_BUBBLE = 'vc_global_bubble';

export interface BubbleTheme { id: string; name: string; color: string | null }

// Bubble content colours: fixed in both app themes, like a wallpaper.
export const BUBBLE_THEMES: BubbleTheme[] = [
  { id: 'default', name: 'Default', color: null },
  { id: 'emerald', name: 'Emerald', color: '#10B981' },
  { id: 'teal',    name: 'Teal',    color: '#0B6E63' },
  { id: 'sky',     name: 'Sky',     color: '#0369A1' },
  { id: 'blue',    name: 'Blue',    color: '#1E40AF' },
  { id: 'indigo',  name: 'Indigo',  color: '#4338CA' },
  { id: 'purple',  name: 'Purple',  color: '#6D28D9' },
  { id: 'magenta', name: 'Magenta', color: '#9D2A6E' },
  { id: 'rose',    name: 'Rose',    color: '#BE123C' },
  { id: 'crimson', name: 'Crimson', color: '#B01E3C' },
  { id: 'sunset',  name: 'Sunset',  color: '#B45309' },
  { id: 'slate',   name: 'Slate',   color: '#334155' },
];

/**
 * Ink for text on a user-picked bubble colour: the dark or light ink with the
 * higher WCAG contrast (lib/bubbleFillInk), chosen against that
 * colour, not the app theme — the same ink the chat paints (chatStyles
 * idealText). A perceived-brightness cut-off put white on Emerald at 2.54:1.
 */
export function idealText(hex: string): string {
  return fillInks(hex).text;
}

// Bubble colors chosen for a chat. Returns null for "Default" so chat.tsx keeps
// the theme's outgoing bubble. (peer is unused by chat.tsx now — received
// bubbles always follow the theme — but kept for the existing call shape.)
export async function getBubbleColors(chatId: string): Promise<{ mine: string; peer: string } | null> {
  try {
    const id = resolveScoped(
      await AsyncStorage.getItem(BUBBLE_KEY + chatId),
      await AsyncStorage.getItem(GLOBAL_BUBBLE),
    );
    const found = BUBBLE_THEMES.find(b => b.id === id);
    if (!found || !found.color) return null;
    return { mine: found.color, peer: found.color };
  } catch { return null; }
}
