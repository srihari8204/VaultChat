// lib/useReducedMotion.ts — one place to ask "should this animate?".
//
// Two screens already read AccessibilityInfo directly (camera, Rummy) and each
// re-implemented the listener. Reduce Motion is an OS-level accessibility
// setting, not a per-screen preference: a user who turns it on has told the
// whole app something, and honouring it in two places out of a hundred is the
// same as not honouring it.
//
// Returns false until the first async read resolves, so the very first frame
// may animate for a user who asked it not to. That is deliberate: the
// alternative is suppressing motion for everyone during the read, which
// degrades the common case to fix a single frame of the rare one.

import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then(v => { if (alive) setReduced(!!v); })
      .catch(() => { /* setting unavailable — animate normally */ });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', v => setReduced(!!v));
    return () => { alive = false; sub.remove(); };
  }, []);

  return reduced;
}

/**
 * Duration helper: collapses to 0 when the user asked for reduced motion, so a
 * transition still *happens* (state lands where it should) without moving.
 */
export function motionDuration(ms: number, reduced: boolean): number {
  return reduced ? 0 : ms;
}

export default useReducedMotion;
