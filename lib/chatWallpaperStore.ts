// lib/chatWallpaperStore.ts — where a chat's wallpaper choice is stored and how
// it resolves (app/chat-wallpaper.tsx edits it, app/chat.tsx paints with it).
// Kept out of the route file so the chat does not import a screen.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { resolveScoped } from './scopedChoice';

export interface WallpaperConfig {
  type: 'solid' | 'gradient' | 'image';
  value: string;         // hex for solid, preset id for gradient, uri for image
  colors?: string[];     // gradient colors
}

/** The all-chats wallpaper. */
export const WALLPAPER_GLOBAL_KEY = 'vc_wallpaper_default';
/** Per-chat key; without a chat id it is the all-chats key. */
export const wallpaperKey = (chatId?: string | null) => `vc_wallpaper_${chatId || 'default'}`;

// Read the saved wallpaper for a chat (falls back to the global default).
// Returns null = "default", so app/chat.tsx paints the theme's chat background.
export async function getWallpaper(chatId: string): Promise<WallpaperConfig | null> {
  try {
    // A per-chat SCOPED_DEFAULT means "app default" even when a global
    // wallpaper is set (lib/scopedChoice.ts).
    const raw = resolveScoped(
      await AsyncStorage.getItem(wallpaperKey(chatId)),
      await AsyncStorage.getItem(WALLPAPER_GLOBAL_KEY),
    );
    return raw ? JSON.parse(raw) as WallpaperConfig : null;
  } catch { return null; }
}
