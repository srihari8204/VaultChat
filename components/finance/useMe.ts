// components/finance/useMe.ts — resolve the current VaultChat user for tagging
// on-device finance rows. Falls back to a stable 'local' id when signed out.

import { useEffect, useState } from 'react';
import { getCurrentUserAsync } from '../../app/(constants)/authService';

export interface Me { id: string; name: string }

export function useMe(): Me | null {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const u = await getCurrentUserAsync().catch(() => null);
      if (alive) setMe({ id: u?.id ?? 'local', name: u?.name ?? u?.email ?? 'You' });
    })();
    return () => { alive = false; };
  }, []);
  return me;
}
