// lib/i18n/engine.ts — the translation engine, extracted so there is one of it.
//
// AUDIT F8. Every string in the app outside Shop Book is hard-coded English
// across 195 screens, with no framework to write new ones against. The audit's
// advice was to adopt one NOW even with a single locale, because extracting
// existing strings can be gradual but the decision cannot: a screen written
// today without a translation layer is a screen somebody retrofits later.
//
// NO NEW DEPENDENCY. Shop Book already had a working, dependency-free
// implementation — six languages, device-locale default, persisted override,
// per-key English fallback, a tiny external store so components re-render on a
// language change. It has been in production and it works. Adding i18n-js or
// react-i18next beside it would mean two systems, two mental models, and a
// migration nobody asked for.
//
// So the ENGINE moved here and both catalogs use it: Shop Book's domain
// catalog (lib/shopbookI18n.ts) and the app-wide one (lib/i18n/index.ts). One
// implementation, two vocabularies — which is the honest shape, since a shop's
// "Khata" and the messenger's "Forwarded" have nothing to say to each other.
//
// DIRECTION IS PART OF A LANGUAGE, not an afterthought. Every language declares
// its own, so the day an RTL locale is added the layout question is already
// answerable in code rather than being discovered in a screenshot. None of the
// launch languages are RTL; this exists so that is a fact the code knows rather
// than an assumption it makes.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules, Platform } from 'react-native';
import { useSyncExternalStore } from 'react';

export type Catalog = Record<string, string>;
export type Direction = 'ltr' | 'rtl';

export interface LanguageMeta {
  id: string;
  /** English name, for a settings list read by someone who does not read it. */
  label: string;
  /** The language's own name, which is what a speaker actually looks for. */
  native: string;
  dir?: Direction;
}

export interface I18nOptions<L extends string> {
  catalogs: Record<L, Catalog>;
  /** The reference catalog. Every key exists here; others fall back per key. */
  fallback: L;
  /** AsyncStorage key for the persisted override. */
  storeKey: string;
  languages: LanguageMeta[];
}

export interface I18n<L extends string> {
  /** Translate. An unknown key returns the KEY, never a blank. */
  t: (key: string, params?: Record<string, string | number>) => string;
  getLang: () => L;
  setLang: (lang: L) => Promise<void>;
  /** Re-renders the component when the language changes. */
  useLang: () => L;
  /** Load the persisted choice, or the device default. Idempotent. */
  init: () => Promise<L>;
  languages: LanguageMeta[];
  dir: () => Direction;
}

/**
 * The device's language, as a bare two-letter code.
 *
 * Reads the native settings directly rather than pulling in expo-localization:
 * this is the one fact needed, it is two property reads, and it already worked
 * in Shop Book. Falls back to the reference language on anything unexpected —
 * a device whose locale cannot be read must still get a working app.
 */
function deviceLang<L extends string>(known: Record<string, Catalog>, fallback: L): L {
  try {
    const tag: string =
      Platform.OS === 'ios'
        ? NativeModules.SettingsManager?.settings?.AppleLocale ??
          NativeModules.SettingsManager?.settings?.AppleLanguages?.[0] ?? fallback
        : NativeModules.I18nManager?.localeIdentifier ?? fallback;
    const code = String(tag).slice(0, 2).toLowerCase();
    return known[code] ? (code as L) : fallback;
  } catch {
    return fallback;
  }
}

export function createI18n<L extends string>(opts: I18nOptions<L>): I18n<L> {
  const { catalogs, fallback, storeKey, languages } = opts;
  const known = catalogs as Record<string, Catalog>;

  let current: L = fallback;
  let loaded = false;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());

  const dirOf = (lang: L): Direction =>
    languages.find((m) => m.id === lang)?.dir ?? 'ltr';

  return {
    languages,
    getLang: () => current,
    dir: () => dirOf(current),

    t(key, params) {
      const raw = known[current]?.[key] ?? known[fallback]?.[key] ?? key;
      if (!params) return raw;
      // {name}-style holes. Deliberately not a template engine: anything more
      // expressive becomes a place to put logic, and logic in a translation
      // catalog is logic no translator can review.
      return raw.replace(/\{(\w+)\}/g, (whole, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole);
    },

    async setLang(lang) {
      current = known[lang] ? lang : fallback;
      notify();
      try {
        await AsyncStorage.setItem(storeKey, current);
      } catch {
        // Persistence is best-effort; the in-memory choice still applies to
        // this session, which is what the user just asked for.
      }
    },

    async init() {
      if (loaded) return current;
      loaded = true;
      try {
        const saved = await AsyncStorage.getItem(storeKey);
        current = saved && known[saved] ? (saved as L) : deviceLang(known, fallback);
      } catch {
        current = deviceLang(known, fallback);
      }
      notify();
      return current;
    },

    useLang() {
      return useSyncExternalStore(
        (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
        () => current,
        () => current,   // server/initial snapshot — same value, no hydration gap
      );
    },
  };
}
