// lib/readerSettings.ts — Chat Reader typography preferences.
//
// Exactly the controls the design specifies (docs/design/mobile/m20-reader-settings):
// theme, font, text size, line spacing, margins, layout. Same shape as
// lib/mediaPrefs.ts: a cached value for synchronous first paint, AsyncStorage
// behind it. These are display preferences, not content, so they are not sealed.

import AsyncStorage from '@react-native-async-storage/async-storage';

export type ReaderTheme   = 'dark' | 'light' | 'sepia' | 'oled';
export type ReaderFont    = 'serif' | 'sans' | 'mono';
export type ReaderMargins = 'narrow' | 'comfortable' | 'wide';
export type ReaderLayout  = 'scroll' | 'pages';

export interface ReaderSettings {
  theme:   ReaderTheme;
  font:    ReaderFont;
  size:    number;   // px, the design's default is 18
  spacing: number;   // line-height multiplier, default 1.6
  margins: ReaderMargins;
  layout:  ReaderLayout;
}

export const READER_DEFAULTS: ReaderSettings = {
  theme: 'dark', font: 'serif', size: 18, spacing: 1.6, margins: 'comfortable', layout: 'scroll',
};

export const SIZE_MIN = 14;
export const SIZE_MAX = 26;
export const SPACING_MIN = 1.2;
export const SPACING_MAX = 2.2;

const KEY = 'vc_reader_settings_v1';

let cached: ReaderSettings = { ...READER_DEFAULTS };
AsyncStorage.getItem(KEY)
  .then(v => { if (v) cached = coerce(JSON.parse(v)); })
  .catch(() => {});

/** Clamp anything read off disk back into range. A settings blob written by a
 *  newer build (or hand-edited) must not be able to render text at size 400. */
function coerce(v: any): ReaderSettings {
  const d = READER_DEFAULTS;
  const oneOf = <T,>(val: any, allowed: readonly T[], fallback: T): T =>
    allowed.includes(val) ? val as T : fallback;
  const num = (val: any, min: number, max: number, fallback: number) =>
    typeof val === 'number' && Number.isFinite(val) ? Math.min(max, Math.max(min, val)) : fallback;

  return {
    theme:   oneOf(v?.theme, ['dark', 'light', 'sepia', 'oled'] as const, d.theme),
    font:    oneOf(v?.font, ['serif', 'sans', 'mono'] as const, d.font),
    size:    num(v?.size, SIZE_MIN, SIZE_MAX, d.size),
    spacing: num(v?.spacing, SPACING_MIN, SPACING_MAX, d.spacing),
    margins: oneOf(v?.margins, ['narrow', 'comfortable', 'wide'] as const, d.margins),
    layout:  oneOf(v?.layout, ['scroll', 'pages'] as const, d.layout),
  };
}

export function getReaderSettingsCached(): ReaderSettings { return cached; }

export async function getReaderSettings(): Promise<ReaderSettings> {
  try {
    const v = await AsyncStorage.getItem(KEY);
    if (v) { cached = coerce(JSON.parse(v)); }
  } catch {}
  return cached;
}

export async function setReaderSettings(patch: Partial<ReaderSettings>): Promise<ReaderSettings> {
  cached = coerce({ ...cached, ...patch });
  try { await AsyncStorage.setItem(KEY, JSON.stringify(cached)); } catch {}
  return cached;
}

export async function resetReaderSettings(): Promise<ReaderSettings> {
  cached = { ...READER_DEFAULTS };
  try { await AsyncStorage.removeItem(KEY); } catch {}
  return cached;
}

/** Page colours per theme — 'oled' is true black so the pixels are actually off. */
export const READER_THEMES: Record<ReaderTheme, { bg: string; text: string; dim: string }> = {
  dark:  { bg: '#12111C', text: '#EDEBFA', dim: '#A29DC0' },
  light: { bg: '#FFFFFF', text: '#16151F', dim: '#5B5870' },
  sepia: { bg: '#F4ECD8', text: '#3A3226', dim: '#6F6353' },
  oled:  { bg: '#000000', text: '#E6E4F0', dim: '#8C88A6' },
};

export const MARGIN_PX: Record<ReaderMargins, number> = { narrow: 14, comfortable: 26, wide: 44 };

export default {};
