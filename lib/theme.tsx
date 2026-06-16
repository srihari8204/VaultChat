// lib/theme.tsx — runtime theming (U3).
//
// Provides the active color palette (dark / light), resolved from the user's
// saved preference ('light' | 'dark' | 'system'); 'system' follows the OS via
// useColorScheme(). The preference is persisted in AsyncStorage.
//
// Adoption: theme-aware code calls useTheme() to read `colors` and re-renders on
// change. Screens still importing the static `Aurora` (the dark palette) keep
// working unchanged — they stay dark until migrated to useTheme(). This is the
// foundation; full light-mode coverage rolls out screen by screen.

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PALETTES, AuroraDark, type Palette, type ColorScheme } from '../constants/theme';

export type ThemePref = 'light' | 'dark' | 'system';
const PREF_KEY = 'vc_theme_pref';

interface ThemeValue {
  scheme: ColorScheme;   // the resolved active scheme
  colors: Palette;       // the active palette
  pref: ThemePref;       // the saved preference
  setPref: (p: ThemePref) => void;
}

// Default = dark, so components rendered outside the provider still work.
const ThemeCtx = createContext<ThemeValue>({
  scheme: 'dark', colors: AuroraDark, pref: 'system', setPref: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme(); // 'light' | 'dark' | null
  const [pref, setPrefState] = useState<ThemePref>('system');

  useEffect(() => {
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(PREF_KEY);
        if (saved === 'light' || saved === 'dark' || saved === 'system') setPrefState(saved);
      } catch { /* keep default */ }
    })();
  }, []);

  const setPref = (p: ThemePref) => {
    setPrefState(p);
    AsyncStorage.setItem(PREF_KEY, p).catch(() => {});
  };

  const value = useMemo<ThemeValue>(() => {
    const scheme: ColorScheme = pref === 'system' ? (system === 'light' ? 'light' : 'dark') : pref;
    return { scheme, colors: PALETTES[scheme], pref, setPref };
  }, [pref, system]);

  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

/** Read the active theme (colors + scheme + preference setter). */
export function useTheme(): ThemeValue {
  return useContext(ThemeCtx);
}

/** Convenience: just the active palette. */
export function useColors(): Palette {
  return useContext(ThemeCtx).colors;
}

export default ThemeProvider;
