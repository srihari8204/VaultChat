// lib/vaultcheck/rppg.ts — remote photoplethysmography (heartbeat from video).
//
// Native frame sampling + the public entry point. The signal processing itself
// lives in ./rppgCore, which imports nothing from React Native so it can run
// under `tsx` in the self-test (see rppg.selftest.ts) — the DSP is the part
// worth testing, and it is not testable through the native bridge.
//
// See ./rppgCore for the method, and for what a result does and does not mean.

import { NativeModules } from 'react-native';
import { analyse, type RppgSample, type RppgResult } from './rppgCore';

export { analyse } from './rppgCore';
export type { RppgSample, RppgResult } from './rppgCore';

const Native: any = (NativeModules as any)?.VaultViewMedia ?? null;

export function isRppgAvailable(): boolean { return !!Native?.sampleVideoChannels; }

/**
 * Sample a video's face region. `roi` is normalised (0–1); the default is a
 * centre box, which is where a talking-head video puts the face. Callers with
 * real face detection should pass a tighter box — accuracy depends on it.
 */
export async function sampleVideo(
  uri: string,
  opts: {
    startMs?: number; endMs?: number; frames?: number;
    roi?: { x: number; y: number; w: number; h: number };
  } = {},
): Promise<RppgSample[]> {
  if (!Native?.sampleVideoChannels) return [];
  const roi = opts.roi ?? { x: 0.3, y: 0.15, w: 0.4, h: 0.4 };
  const start = opts.startMs ?? 0;
  const end = opts.endMs ?? 10000;
  const frames = opts.frames ?? 150;
  try {
    const raw = await Native.sampleVideoChannels(
      uri, start, end, frames, roi.x, roi.y, roi.w, roi.h,
    );
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/** Convenience: sample and analyse in one call. */
export async function analyseVideo(
  uri: string,
  opts?: Parameters<typeof sampleVideo>[1],
): Promise<RppgResult> {
  if (!isRppgAvailable()) {
    return { verdict: 'inconclusive', frames: 0, reason: 'frame sampling unavailable in this build' };
  }
  const samples = await sampleVideo(uri, opts);
  return analyse(samples);
}

export default {};
