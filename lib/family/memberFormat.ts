// lib/family/memberFormat.ts — how a circle member is drawn and dated, shared by
// the hub (app/family.tsx) and the member screen (app/family-member.tsx), which
// used to carry their own copies (and their own wording for "just now").
//
// Pure — no react-native imports — so the selftest runs under tsx.

/** Avatar fills. Saturated on purpose: identity colours, the same in both themes. */
export const AVATAR_COLORS = ['#4A9FFF', '#EC4899', '#22C55E', '#F59E0B', '#A855F7', '#EF4444', '#14B8A6', '#F97316'];

/** A member's colour, stable for their id on every screen and every device. */
export const colorFor = (id: string): string =>
  AVATAR_COLORS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length];

/** "just now" / "5m ago" / "3h ago" / "2d ago". Future timestamps read as now. */
export function ago(ts: number, now: number = Date.now()): string {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
