// lib/tintColor.ts — a palette colour at a given opacity.
//
// Screens used to tint tokens by string concatenation (`colors.primary + '1a'`),
// which silently breaks the moment a token is not a 6-digit hex (several palette
// roles are already rgba()). This accepts #rgb, #rrggbb and rgb()/rgba() and
// returns rgba() with the requested alpha. Pure, so the selftest runs under tsx.

/** `color` with its alpha replaced by `a` (0..1). Unparseable input is returned unchanged. */
export function tint(color: string, a: number): string {
  const alpha = Math.max(0, Math.min(1, a));
  const c = (color ?? '').trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const fn = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/i.exec(c);
  if (fn) return `rgba(${fn[1]}, ${fn[2]}, ${fn[3]}, ${alpha})`;
  return c;
}
