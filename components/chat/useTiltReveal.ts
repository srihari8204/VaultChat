// components/chat/useTiltReveal.ts — Invisible Ink's tilt-to-reveal. Moved
// out of app/chat.tsx unchanged: one DeviceMotion subscription for the whole
// thread, live only while an Invisible Ink message is loaded.

import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { DeviceMotion } from 'expo-sensors';
import type { DisplayMessage } from './chatStyles';

export function useTiltReveal(messages: DisplayMessage[]): boolean {
  // Global "tilt revealed" state — flips true when the gyro reports any
  // axis past ~45° (~0.78 rad). Shared by every invisible-ink bubble on
  // screen, so a single tilt reveals all of them at once.
  const [tiltRevealed, setTiltRevealed] = useState(false);

  // ── Invisible Ink: tilt-to-reveal subscription ────────────
  // Subscribe to DeviceMotion at ~100 ms cadence whenever an
  // invisible-ink message is on screen. Flip `tiltRevealed` true when
  // beta (front-back) or gamma (left-right) exceeds ~45° (0.78 rad).
  // We don't need the rotation history — just the current pose. Skipped
  // entirely on web (the API isn't available).
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const hasAny = messages.some(m => m.meta?.invisibleInk);
    if (!hasAny) {
      if (tiltRevealed) setTiltRevealed(false);
      return;
    }
    let sub: { remove(): void } | null = null;
    let alive = true;
    (async () => {
      const ok = await DeviceMotion.isAvailableAsync().catch(() => false);
      if (!alive || !ok) return;
      DeviceMotion.setUpdateInterval(100);
      sub = DeviceMotion.addListener(({ rotation }) => {
        if (!rotation) return;
        const REVEAL_RAD = 0.78; // ~45°
        const revealed =
          Math.abs(rotation.beta  ?? 0) > REVEAL_RAD ||
          Math.abs(rotation.gamma ?? 0) > REVEAL_RAD;
        setTiltRevealed(prev => prev === revealed ? prev : revealed);
      });
    })();
    return () => { alive = false; sub?.remove(); };
  // intentional: only re-evaluate when the *presence* of invisible-ink
  // messages changes, not on every messages-array mutation
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.some(m => m.meta?.invisibleInk)]);

  return tiltRevealed;
}
