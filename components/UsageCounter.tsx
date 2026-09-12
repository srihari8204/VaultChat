// components/UsageCounter.tsx — the one place a screen open is observed.
//
// AUDIT F9. Renders nothing. It exists so counting happens in ONE file instead
// of a call at the top of 195 screens — which would be 195 chances to forget,
// 195 chances to pass the wrong name, and 195 files to edit the day the rule
// changes.
//
// It reads the router's current path and nothing else. There is no way for a
// screen to hand it anything extra, which is the point: the instrument cannot
// grow into a logger by accident, because the call site has nothing to give it.

import { usePathname } from 'expo-router';
import { useEffect } from 'react';

import { countScreen } from '../lib/usageCounter';

export function UsageCounter(): null {
  const path = usePathname();

  useEffect(() => {
    // usePathname gives "/shop-book", "/(tabs)/chats", "/chat". The group
    // segment is routing structure, not a screen anyone would decide to keep or
    // cut, so it is stripped here rather than taught to the server.
    const name = String(path ?? '').replace(/^\/?\(tabs\)\//, '').replace(/^\//, '');
    if (name) countScreen(name);
  }, [path]);

  return null;
}

export default UsageCounter;
