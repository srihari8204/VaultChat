import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  DEFAULT_VISION_PROFILE,
  VISION_COMFORT_STORAGE_KEY,
  decodeVisionComfortState,
  defaultVisionComfortState,
  deriveVisionMetrics,
  isVisionProfile,
  type VisionComfortState,
  type VisionProfile,
  type VisionProfileKey,
} from './visionComfortModel';

export { deriveVisionMetrics } from './visionComfortModel';
export type { VisionProfile, VisionProfileKey } from './visionComfortModel';

type VisionComfortValue = VisionComfortState & {
  profile: VisionProfile;
  metrics: ReturnType<typeof deriveVisionMetrics>;
  ready: boolean;
  error: string | null;
  saveProfile: (key: VisionProfileKey, profile: VisionProfile) => Promise<void>;
  setActiveProfile: (key: VisionProfileKey) => Promise<void>;
  resetProfile: (key: VisionProfileKey) => Promise<void>;
  clearError: () => void;
};

const VisionComfortContext = createContext<VisionComfortValue | null>(null);

export function VisionComfortProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState(defaultVisionComfortState);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef(state);
  const queue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let mounted = true;
    AsyncStorage.getItem(VISION_COMFORT_STORAGE_KEY)
      .then(raw => {
        if (!mounted) return;
        const loaded = decodeVisionComfortState(raw);
        stateRef.current = loaded;
        setState(loaded);
      })
      .catch(() => { if (mounted) setError('Could not load Vision Comfort settings.'); })
      .finally(() => { if (mounted) setReady(true); });
    return () => { mounted = false; };
  }, []);

  const commit = useCallback((update: (current: VisionComfortState) => VisionComfortState) => {
    if (!ready) return Promise.reject(new Error('Vision Comfort is still loading.'));
    const pending = queue.current.catch(() => {}).then(async () => {
      const next = update(stateRef.current);
      await AsyncStorage.setItem(VISION_COMFORT_STORAGE_KEY, JSON.stringify({ version: 1, ...next }));
      stateRef.current = next;
      setState(next);
      setError(null);
    }).catch((cause: unknown) => {
      setError('Could not save Vision Comfort settings. Please try again.');
      throw cause;
    });
    queue.current = pending;
    return pending;
  }, [ready]);

  const saveProfile = useCallback((key: VisionProfileKey, profile: VisionProfile) => {
    if ((key !== 'with-glasses' && key !== 'without-glasses') || !isVisionProfile(profile)) {
      return Promise.reject(new Error('Invalid Vision Comfort profile.'));
    }
    return commit(current => ({ ...current, profiles: { ...current.profiles, [key]: { ...profile } } }));
  }, [commit]);

  const setActiveProfile = useCallback((key: VisionProfileKey) => {
    if (key !== 'with-glasses' && key !== 'without-glasses') {
      return Promise.reject(new Error('Invalid Vision Comfort profile.'));
    }
    return commit(current => ({ ...current, activeProfile: key }));
  }, [commit]);

  const resetProfile = useCallback((key: VisionProfileKey) => {
    if (key !== 'with-glasses' && key !== 'without-glasses') {
      return Promise.reject(new Error('Invalid Vision Comfort profile.'));
    }
    return commit(current => ({ ...current, profiles: {
      ...current.profiles, [key]: { ...DEFAULT_VISION_PROFILE },
    } }));
  }, [commit]);

  const value = useMemo<VisionComfortValue>(() => ({
    ...state,
    profile: state.profiles[state.activeProfile],
    metrics: deriveVisionMetrics(state.profiles[state.activeProfile]),
    ready,
    error,
    saveProfile,
    setActiveProfile,
    resetProfile,
    clearError: () => setError(null),
  }), [state, ready, error, saveProfile, setActiveProfile, resetProfile]);

  return <VisionComfortContext.Provider value={value}>{children}</VisionComfortContext.Provider>;
}

export function useVisionComfort(): VisionComfortValue {
  const value = useContext(VisionComfortContext);
  if (!value) throw new Error('VisionComfortProvider is missing.');
  return value;
}
