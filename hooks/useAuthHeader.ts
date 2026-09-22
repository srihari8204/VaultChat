// hooks/useAuthHeader.ts — the Authorization header an <Image> or <Avatar> needs
// to fetch an attachment.
//
// WHY THIS EXISTS (audit finding 16)
//
// Seventeen screens each carried the same five lines: a `authHeader` state, a
// `getAccessToken()` folded into their own `Promise.all`, and
// `tok ? \`Bearer ${tok}\` : null`. Identical every time, and it put a token read on
// each screen's first-paint path for no reason other than that the pattern was
// copied forward.
//
// Returns null until the token resolves, and null if there is none. That is the
// contract every caller already coded against: they render initials, a placeholder
// or nothing while the header is absent, and swap in the remote image once it
// arrives. So a screen that adopts this hook behaves exactly as it did before —
// the header simply stops travelling with that screen's data fetch.
//
// Deliberately NOT a context or a store. The value is per-mount and cheap;
// `getAccessToken()` already owns caching and refresh, so a second cache here would
// be a second source of truth for the same token.

import { useEffect, useState } from 'react';
import { getAccessToken } from '../lib/api';

export function useAuthHeader(): string | null {
  const [header, setHeader] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const tok = await getAccessToken();
        if (!cancel) setHeader(tok ? `Bearer ${tok}` : null);
      } catch {
        // Leave it null. Every caller renders its fallback, which is the same
        // thing they showed while the token was still in flight.
      }
    })();
    return () => { cancel = true; };
  }, []);

  return header;
}
