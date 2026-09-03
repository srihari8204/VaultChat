// lib/games/theme.ts — the games design system, ported from games-web/theme.css.
//
// The web client's look is not decoration: a maroon felt table with gold
// hardware is what makes these read as GAMES rather than as another list
// screen in a chat app. The native boards first shipped in VaultChat's own
// app palette and looked like settings pages, so the tokens below are copied
// from theme.css rather than reinterpreted — same hexes, same 4px spacing
// scale, same three elevations.
//
// Kept deliberately close to the source so the two clients can be compared
// side by side. Where CSS has no RN equivalent the substitution is noted.

import { Platform } from 'react-native';

/** 4px base — every control in the web client is already a multiple of 4. */
export const S = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32 } as const;

/** Four steps plus a pill. Anything between these was noise. */
export const R = { 1: 8, 2: 12, 3: 16, 4: 22, pill: 999 } as const;

/**
 * Type ramp. The web uses clamp() against viewport width; RN has no clamp, so
 * the fluid sizes are resolved once against screen width in `typeScale()`.
 */
export const T = { xs: 11, sm: 12.5, md: 15, lg: 18, xl: 24, '2xl': 34 } as const;

/** Resolve the three fluid sizes the way clamp(min, vw, max) would. */
export function typeScale(width: number) {
  const c = (min: number, vw: number, max: number) =>
    Math.round(Math.min(Math.max(min, (vw / 100) * width), max) * 10) / 10;
  return {
    xs: T.xs,
    sm: T.sm,
    md: c(13, 3.4, 15),
    lg: c(16, 4, 18),
    xl: c(19, 4.6, 24),
    '2xl': c(24, 5.6, 34),
  };
}

/**
 * The palette.
 *
 * This is intentionally NOT VaultChat's app palette and does not follow the
 * light/dark theme: a card table is a place, and it looks the same whichever
 * way the rest of the app is set. Mixing the two is what made the first native
 * boards look like a form.
 *
 * NO LONGER A VERBATIM PORT of games-web's theme.css. It used to be, so the two
 * clients could be compared side by side, and the cost of this change is that
 * they now differ until the web client follows. What changed and why:
 *
 * The old tokens painted every PANEL a solid maroon and edged it gold, so a
 * screen was maroon on maroon on maroon with gold on all of it, and nothing
 * could be primary because everything already was. Maroon is now the ROOM —
 * a deep ground the eye reads as unlit space — and surfaces are lifted off it
 * rather than coloured differently from it. Gold survives untouched but is
 * spent once per screen.
 *
 * Tracked as openspec/changes/games-apple-ui.
 */
export const C = {
  /** The room: near-black with maroon in it, not maroon with black in it. */
  bg: '#160607',
  bg2: '#22090A',
  /** Surfaces sit ON the ground rather than being a different colour from it. */
  panel: '#300D0E',
  panel2: '#22090A',
  card: '#300D0E',
  line: '#4a2122',
  text: '#FFF8F1',
  muted: '#CDBBBB',
  gold: '#f3c245',
  gold2: '#ffdd72',
  goldDeep: '#a9791b',
  good: '#63E6A0',
  win: '#63E6A0',
  bad: '#FF7D86',
  lose: '#FF7D86',
  /** Ink for text sitting on gold — gold is a light surface. */
  onGold: '#1a1206',
} as const;

/**
 * color-mix(in srgb, A p%, B) — used constantly by theme.css for the
 * gold-tinted borders, and RN has no such function.
 */
export function mix(a: string, pct: number, b: string): string {
  const hex = (h: string) => {
    const s = h.replace('#', '');
    const n = s.length === 3 ? s.split('').map(c => c + c).join('') : s;
    return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
  };
  const [r1, g1, b1] = hex(a);
  const [r2, g2, b2] = hex(b);
  const t = Math.max(0, Math.min(100, pct)) / 100;
  const ch = (x: number, y: number) => Math.round(x * t + y * (1 - t));
  return `rgb(${ch(r1, r2)}, ${ch(g1, g2)}, ${ch(b1, b2)})`;
}

/** Same hex, with an alpha channel — RN takes rgba() but not #rrggbbaa reliably. */
export function alpha(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** The gold-tinted border used by every panel, at the four strengths in use. */
export const goldLine = {
  14: mix(C.gold, 14, C.line),
  18: mix(C.gold, 18, C.line),
  22: mix(C.gold, 22, C.line),
  28: mix(C.gold, 28, C.line),
  38: mix(C.gold, 38, C.line),
  55: mix(C.gold, 55, C.line),
};

/**
 * Elevation.
 *
 * RN 0.76+ on the New Architecture supports the `boxShadow` string, which is
 * what makes the multi-layer and INSET shadows below possible at all — the
 * legacy shadow* props are single-layer, outset only, and on Android
 * shadowColor is silently ignored in favour of `elevation`. That limitation is
 * why the first attempt at this looked flat.
 *
 * `elevation` is still set alongside as the fallback for old-architecture
 * builds, where it is the only thing Android honours.
 */
export const E = {
  1: '0 2px 6px rgba(0, 0, 0, 0.28)',
  2: '0 8px 22px rgba(0, 0, 0, 0.35), 0 2px 6px rgba(0, 0, 0, 0.25)',
  3: '0 20px 50px rgba(0, 0, 0, 0.5), 0 6px 14px rgba(0, 0, 0, 0.32)',
} as const;

/** depth.css — the physical-object shadows used on tokens, dice and tiles. */
export const D3 = {
  lift1: '0 1px 2px rgba(0, 0, 0, 0.28)',
  lift2: '0 3px 6px rgba(0, 0, 0, 0.34), 0 1px 2px rgba(0, 0, 0, 0.24)',
  lift3: '0 10px 22px rgba(0, 0, 0, 0.42), 0 3px 6px rgba(0, 0, 0, 0.3)',
  /** Top highlight that makes a surface read as raised. */
  rim: 'inset 0 1px 0 rgba(255, 255, 255, 0.55)',
  /** Recessed socket — home squares, card slots, the dice tray. */
  well: 'inset 0 3px 8px rgba(0, 0, 0, 0.35), inset 0 -1px 0 rgba(255, 255, 255, 0.12)',
} as const;

/** The glass primitive: .glass/.panel/.lobby/.tablecard all share this. */
export const glass = {
  // TRANSLUCENT, not solid. A solid fill cancelled the ambient wash and the
  // grain underneath it, so every panel read as a flat rectangle pasted onto
  // the room rather than a surface lifted off it — the depth was being drawn
  // and then painted over. 0.78 is as far as it goes: the panels carry body
  // text, and the ground behind them is near-black, so contrast is the limit
  // rather than taste. The top rim does the rest of the work; at 0.06 it was
  // below the threshold where an edge reads as lit at all.
  backgroundColor: alpha(C.panel, 0.78),
  borderWidth: 1,
  borderColor: goldLine[28],
  borderRadius: R[3],
  boxShadow: `${E[3]}, inset 0 1px 0 rgba(255, 255, 255, 0.10)`,
  ...Platform.select({ android: { elevation: 12 }, default: {} }),
} as const;

/** Header/topbar. The web adds backdrop-filter; expo-blur is the RN stand-in. */
export const topbar = {
  backgroundColor: mix(C.panel, 92, '#ffffff'),
  borderWidth: 1,
  borderColor: goldLine[22],
  boxShadow: '0 10px 30px rgba(0, 0, 0, 0.4)',
  ...Platform.select({ android: { elevation: 8 }, default: {} }),
} as const;

/** Gold button fill, as a LinearGradient colour stop list. */
export const GOLD_FILL = [C.gold2, C.gold, C.goldDeep] as const;
export const GOLD_STOPS = [0, 0.55, 1] as const;

/** Secondary/icon button fill — a soft vertical panel gradient. */
export const PANEL_FILL = [mix(C.panel, 80, '#ffffff'), mix(C.panel2, 88, '#000000')] as const;

/** Danger button fill. */
export const RED_FILL = ['#fb7185', '#e11d48', '#a30f2e'] as const;
export const RED_STOPS = [0, 0.6, 1] as const;

/**
 * Motion. The web client's transitions are all one of these two curves; the
 * numbers are the durations actually used in theme.css so the native boards
 * feel the same speed rather than merely animated.
 */
export const MOTION = {
  /** cubic-bezier(.2,.8,.2,1) — the standard "settle" used on every control. */
  settle: { damping: 18, stiffness: 260, mass: 0.7 },
  press: 140,
  fade: 200,
  /** Token hop, card deal, dice settle — the game-piece movements. */
  piece: { damping: 15, stiffness: 190, mass: 0.9 },
} as const;

/** Ambient background wash, from body::before. Three radial glows. */
export const AMBIENT = [
  { color: C.gold,      opacity: 0.14, cx: '50%',  cy: '-10%', rx: '60%', ry: '40%' },
  { color: '#7c3aed',   opacity: 0.10, cx: '100%', cy: '0%',   rx: '45%', ry: '30%' },
  { color: '#10b981',   opacity: 0.08, cx: '0%',   cy: '10%',  rx: '40%', ry: '28%' },
] as const;

/** body::after — the 22px dot grain that keeps large felt areas from banding. */
export const GRAIN = { size: 22, dot: 1, color: 'rgba(255,255,255,0.025)', opacity: 0.5 } as const;
