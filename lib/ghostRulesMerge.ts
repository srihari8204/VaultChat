// lib/ghostRulesMerge.ts — fold a reloaded per-contact privacy list
// (app/receipt-control) into what the screen shows, without undoing a toggle
// whose request has not settled. Pure; Node-tested in ghostRulesMerge.selftest.ts.
//
// The screen used to skip the whole reload while ANY toggle was in flight, so a
// pull-to-refresh during one tap silently discarded every other contact's
// fresh rules. Now the server's answer wins everywhere except the exact
// contact+flag pairs still being written, which keep the screen's value (their
// own request, and its rollback, decide them).

export type HideFlag = 'hideRead' | 'hideTyping' | 'hideLastSeen';
export interface GhostRuleLike {
  targetId: string; hideOnline: boolean; hideTyping: boolean; hideRead: boolean; hideLastSeen: boolean;
}

export function mergeReloadedRules<R extends GhostRuleLike>(
  fetched: Record<string, R>,
  current: Record<string, R>,
  busy: Iterable<{ userId: string; flag: HideFlag }>,
): Record<string, R> {
  const out: Record<string, R> = { ...fetched };
  for (const { userId, flag } of busy) {
    const cur = current[userId];
    if (!cur) continue;
    const base = out[userId] ?? ({
      targetId: userId, hideOnline: false, hideTyping: false, hideRead: false, hideLastSeen: false,
    } as R);
    out[userId] = { ...base, [flag]: cur[flag] };
  }
  return out;
}

export default {};
