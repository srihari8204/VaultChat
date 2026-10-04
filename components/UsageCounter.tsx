// components/UsageCounter.tsx — the one place a screen open is observed.
//
// AUDIT F9. Renders nothing. It exists so counting happens in ONE file instead
// of a call at the top of 195 screens — which would be 195 chances to forget,
// 195 chances to pass the wrong name, and 195 files to edit the day the rule
// changes.
//
// It reads the router's current ROUTE PATTERN and nothing else — `join/[code]`,
// never `join/AB12CD` (lib/routePattern.ts). There is no way for a screen to
// hand it anything extra, which is the point: the instrument cannot grow into
// a logger by accident, because the call site has nothing to give it.

import { useSegments } from 'expo-router';
import { useEffect } from 'react';

import { countScreen } from '../lib/usageCounter';
import { routePatternName } from '../lib/routePattern';

export function UsageCounter(): null {
  const segments = useSegments();
  const name = routePatternName(segments);

  useEffect(() => {
    if (name) countScreen(name);
  }, [name]);

  return null;
}

export default UsageCounter;
