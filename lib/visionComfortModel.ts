export type VisionProfileKey = 'with-glasses' | 'without-glasses';

export const VISION_COMFORT_STORAGE_KEY = 'vc_vision_comfort_v1';

export function clampVisionLevel(level: number): number {
  return Number.isFinite(level) ? Math.max(0, Math.min(5, Math.round(level))) : 0;
}

export function comfortLevelFromTrack(y: number, height: number): number {
  if (!Number.isFinite(y) || !Number.isFinite(height) || height <= 0) return 0;
  return clampVisionLevel(5 * (1 - Math.max(0, Math.min(height, y)) / height));
}

export type VisionProfile = {
  level: number;
  highContrast: boolean;
  reduceTransparency: boolean;
};

export type VisionComfortState = {
  activeProfile: VisionProfileKey;
  profiles: Record<VisionProfileKey, VisionProfile>;
};

export const DEFAULT_VISION_PROFILE: VisionProfile = {
  level: 0,
  highContrast: false,
  reduceTransparency: false,
};

export function defaultVisionComfortState(): VisionComfortState {
  return {
    activeProfile: 'with-glasses',
    profiles: {
      'with-glasses': { ...DEFAULT_VISION_PROFILE },
      'without-glasses': { ...DEFAULT_VISION_PROFILE },
    },
  };
}

export function isVisionProfile(value: unknown): value is VisionProfile {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<VisionProfile>;
  return Number.isInteger(p.level) && p.level! >= 0 && p.level! <= 5
    && typeof p.highContrast === 'boolean'
    && typeof p.reduceTransparency === 'boolean';
}

export function decodeVisionComfortState(raw: string | null): VisionComfortState {
  if (!raw) return defaultVisionComfortState();
  try {
    const stored = JSON.parse(raw);
    if (stored?.version !== 1 ||
      (stored.activeProfile !== 'with-glasses' && stored.activeProfile !== 'without-glasses') ||
      !isVisionProfile(stored.profiles?.['with-glasses']) ||
      !isVisionProfile(stored.profiles?.['without-glasses'])) {
      return defaultVisionComfortState();
    }
    return { activeProfile: stored.activeProfile, profiles: {
      'with-glasses': { ...stored.profiles['with-glasses'] },
      'without-glasses': { ...stored.profiles['without-glasses'] },
    } };
  } catch {
    return defaultVisionComfortState();
  }
}

export function deriveVisionMetrics(profile: VisionProfile) {
  const level = Number.isFinite(profile.level) ? Math.max(0, Math.min(5, profile.level)) : 0;
  return {
    textScale: 1 + 0.08 * level,
    lineScale: 1 + 0.03 * level,
    spacingScale: 1 + 0.05 * level,
    controlScale: 1 + 0.06 * level,
    bold: level >= 3,
  };
}
