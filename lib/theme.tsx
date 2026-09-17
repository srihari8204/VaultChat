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
import { useColorScheme, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PALETTES, AuroraDark, type Palette, type ColorScheme } from '../constants/theme';
import { syncLayoutMetrics } from '../constants/layout';

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

  // THE ONE SUBSCRIPTION TO LIVE WINDOW METRICS.
  //
  // constants/layout.ts holds HEADER_TOP / SCREEN_BOTTOM / TAB_BAR_SPACE /
  // IS_NARROW / IS_SHORT as live module bindings, because 53 screens read them
  // from inside a `StyleSheet.create` object where no hook can be called. Those
  // screens build styles via `useMemo(() => makeStyles(colors), [colors])`, so
  // the way to make them react to a rotation, fold or split-screen change is to
  // give `colors` a new identity — which re-runs every factory, which re-reads
  // the refreshed bindings. This is that single trigger; no screen is touched.
  //
  // syncLayoutMetrics is idempotent and only bumps its generation when a value
  // genuinely moved, so an ordinary re-render does not invalidate every style in
  // the app. Doing it in useMemo (not an effect) matters: the bindings must be
  // current BEFORE children render, or the first frame after a rotation paints
  // with stale insets.
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const layoutGen = useMemo(
    () => syncLayoutMetrics({ top: insets.top, bottom: insets.bottom, width, height }),
    [insets.top, insets.bottom, width, height],
  );

  const value = useMemo<ThemeValue>(() => {
    const scheme: ColorScheme = pref === 'system' ? (system === 'light' ? 'light' : 'dark') : pref;
    // Spread so the identity changes when layoutGen does; the values are the
    // palette's own. `colors` is the memo key all 53 style factories depend on.
    return { scheme, colors: { ...PALETTES[scheme] }, pref, setPref };
  }, [pref, system, layoutGen]);

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
