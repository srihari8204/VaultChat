/**
 * constants/glass.selftest.ts
 *   run with: npx tsx constants/glass.selftest.ts
 *
 * The glass recipes are a BUDGET as much as a look. The failure that matters
 * is not a wrong radius — it is a future edit that quietly flips `card` or
 * `chip` to blur-by-default, at which point every settings group and every
 * filter chip takes its own backdrop pass and the chat list stops scrolling
 * at 60fps. Nothing crashes; the app just gets slower on the phones that can
 * least afford it. So the load-bearing assertion is the blur budget.
 */
import assert from 'node:assert/strict';
import { GLASS, GLOW, glassCss, lipGradient, lipPeak, type GlassKind } from './glass';
import { RADIUS } from './theme';

let n = 0;
const ok = (label: string, cond: boolean) => { assert.ok(cond, label); n++; };

const kinds: GlassKind[] = ['chrome', 'card', 'chip', 'sheet'];
for (const k of kinds) {
  const r = GLASS[k];
  ok(`${k}: intensity within expo-blur's 0-100`, r.intensity > 0 && r.intensity <= 100);
  ok(`${k}: lip is a visible but translucent alpha`, r.lip > 0 && r.lip < 1);
  ok(`${k}: radius is positive`, r.radius > 0);
  ok(`${k}: shadow carries an Android elevation`, typeof r.shadow.elevation === 'number' && r.shadow.elevation > 0);
  ok(`${k}: shadow carries an iOS radius`, typeof r.shadow.shadowRadius === 'number');
}

// ── The blur budget ──────────────────────────────────────────────────
ok('only floating chrome and sheets blur by default',
  GLASS.chrome.blur && GLASS.sheet.blur && !GLASS.card.blur && !GLASS.chip.blur);
ok('intensity ranks chip < card < chrome < sheet',
  GLASS.chip.intensity < GLASS.card.intensity &&
  GLASS.card.intensity < GLASS.chrome.intensity &&
  GLASS.chrome.intensity < GLASS.sheet.intensity);

// ── Geometry that other code relies on ───────────────────────────────
ok('sheet shadow casts upward (it sits at the bottom edge)', (GLASS.sheet.shadow.shadowOffset?.height ?? 0) < 0);
ok('chip radius is the pill', GLASS.chip.radius === RADIUS.pill);
ok('chrome radius matches the 66pt tab bar (height / 2 + 3)', GLASS.chrome.radius === 30);

// ── The lip ──────────────────────────────────────────────────────────
const g = lipGradient(0.28);
ok('lip gradient is clear → white → clear', g[0] === 'rgba(255,255,255,0)' && g[1] === 'rgba(255,255,255,0.28)' && g[2] === 'rgba(255,255,255,0)');
ok('lip peak clamps above', lipGradient(2)[1] === 'rgba(255,255,255,1)');
ok('lip peak clamps below', lipGradient(-1)[1] === 'rgba(255,255,255,0)');
for (const k of kinds) ok(`${k}: lip is stronger on the light ground`, lipPeak(k, 'light') > lipPeak(k, 'dark'));

// ── Glows are saturated, never a neutral (themeCoverage's own rule) ──
const chroma = (hex: string) => {
  const h = hex.replace('#', '');
  const c = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  return Math.max(...c) - Math.min(...c);
};
for (const [name, glow] of Object.entries(GLOW)) {
  ok(`GLOW.${name} is a saturated colour`, chroma(glow.shadowColor) >= 42);
  ok(`GLOW.${name} is translucent`, glow.shadowOpacity > 0 && glow.shadowOpacity < 1);
}

// ── The CSS twin stays a real backdrop recipe ────────────────────────
for (const k of kinds) {
  const css = glassCss(k);
  ok(`${k}: css has backdrop-filter`, css.includes('backdrop-filter: blur('));
  ok(`${k}: css has the -webkit- twin`, css.includes('-webkit-backdrop-filter'));
  ok(`${k}: css carries the radius`, css.includes(`border-radius: ${GLASS[k].radius}px`));
}

console.log(`glass.selftest: ${n} assertions passed`);
