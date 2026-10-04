// components/chat/bubbleFillInk.ts — inks for YOUR bubble when it has a custom
// colour (lib/chatBubbleTheme presets): the body text, the time / meta line and
// the read tick. Chosen against that fill by WCAG contrast, not by the app
// theme, so they stay fixed in light and dark like the fill itself.
//
// Pure (no React Native), so lib/chatBubbleTick.selftest.ts runs it on every
// preset: body and meta text >= 4.5:1, the read tick >= 3:1 with a clear hue
// apart from the meta ink the other ticks use.

const DARK_INK = '#0e0e14';
const LIGHT_INK = '#ffffff';
// Read-tick candidates per ink, tried in order: a mint on dark fills (same as
// the theme's tickRead), a navy on light fills.
const READ_ON_LIGHT_INK = ['#7CFFB2', '#FDE68A'];
const READ_ON_DARK_INK = ['#1E3A8A', '#4C1D95'];

function rgb(hex: string): [number, number, number] | null {
  const h = hex.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function luminance([r, g, b]: number[]): number {
  const f = (x: number) => { const c = x / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
/** `fg` at `alpha` laid over `bg`. */
function over(fg: number[], alpha: number, bg: number[]): number[] {
  return fg.map((x, i) => x * alpha + bg[i] * (1 - alpha));
}
export function contrastOn(fg: string, fill: string, alpha = 1): number {
  const f = rgb(fg), b = rgb(fill);
  if (!f || !b) return 1;
  const x = luminance(over(f, alpha, b)), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** Max - min channel: how much hue a colour carries (0 = grey). */
export function chroma(hex: string): number {
  const c = rgb(hex);
  return c ? Math.max(...c) - Math.min(...c) : 0;
}
function rgbaOf(hex: string, alpha: number): string {
  if (alpha >= 1) return hex;
  const [r, g, b] = rgb(hex)!;
  return `rgba(${r},${g},${b},${alpha})`;
}

export interface FillInks {
  /** Body text: whichever of dark / light ink contrasts more. */
  text: string;
  /** Time, edited, delivered/sent ticks: the body ink dimmed only as far as 4.5:1 allows. */
  meta: string;
  /** The read ✓✓: >= 3:1 on the fill and a real hue, so it differs from `meta`. */
  tickRead: string;
}

export function fillInks(fill: string, highContrast = false): FillInks {
  const text = contrastOn(DARK_INK, fill) > contrastOn(LIGHT_INK, fill) ? DARK_INK : LIGHT_INK;
  const alpha = highContrast ? 1 : [0.7, 0.85, 1].find(a => contrastOn(text, fill, a) >= 4.5) ?? 1;
  const reads = text === LIGHT_INK ? READ_ON_LIGHT_INK : READ_ON_DARK_INK;
  const tickRead = reads.find(c => contrastOn(c, fill) >= 3) ?? reads[0];
  return { text, meta: rgbaOf(text, alpha), tickRead };
}
