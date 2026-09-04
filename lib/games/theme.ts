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
  /**
   * LIGHTENED FOR GLASS (was #CDBBBB).
   *
   * Not taste — a measured regression from this restyle. `muted` carries every
   * blurb, hint and subtitle at 11.5–12.5dp, and it used to sit on a panel that
   * was maroon at 78% opacity, i.e. nearly as dark as the room. The glass panels
   * that replaced it composite to roughly #7b5665 under the ambient wash, which
   * is far LIGHTER — so the same grey that was comfortable on the old surface
   * fell to a 3.0–3.4 contrast ratio, under the 4.5 WCAG AA needs for text this
   * size. Raising the surface raises the ink with it.
   *
   * #EBE2E2 clears 4.5 on the panel and button surfaces that carry the body
   * copy (4.91 / 4.73) and is still clearly dimmer than `text`, so the
   * hierarchy the two colours exist to express survives. The active player row
   * (the lightest surface in the set) reaches 4.38 — short of AA, but it holds
   * only a one-word subtitle beside a `text`-coloured name.
   */
  muted: '#EBE2E2',
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

/** Translucent white — the substance every glass surface is made of. */
export const white = (a: number) => `rgba(255, 255, 255, ${a})`;

/**
 * The four game accents.
 *
 * These live here rather than beside the menu entries because a game's colour
 * is not a property of its ROW in a list — the board, its pieces, its turn
 * banner and its card in the hub all have to agree, and they did not: the hub
 * called chess #8ca2ad while the board drew its own pieces from a different
 * value entirely.
 *
 * Retuned for glass. The old accents were picked against solid maroon panels
 * and are too dark to read on a translucent surface, where a colour competes
 * with whatever shows through it — #8ca2ad in particular went to mud.
 */
export const ACCENT = {
  chess: '#7FD8FF',
  rummy: '#6EF2A5',
  ludo: '#FFD166',
  // Lifted from #FF8FA3: measured at 2.89 against the glass panel, under the
  // 3.0 that large text and UI edges need. The other three clear it comfortably
  // (3.9-4.4); rose was the only one of the four that did not.
  tictactoe: '#FFA8B7',
} as const;

export type GameAccent = keyof typeof ACCENT;

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

/**
 * The glass primitive: .glass/.panel/.lobby/.tablecard all share this.
 *
 * A surface is now made of LIGHT, not of paint. It used to be maroon at 78%
 * over a maroon room, which is a tint of the ground rather than a thing
 * sitting on it — the panel and the floor were the same colour, so the only
 * thing separating them was a border. Translucent white instead lets the
 * ambient wash below show through and TINT the surface, which is what makes
 * glass read as glass: the panel is a different colour in each corner of the
 * screen because the room behind it is.
 *
 * ponytail: no backdrop blur. expo-blur is installed and BlurView would be the
 * literal implementation, but what sits behind these panels is AMBIENT — three
 * wide radial gradients and a 22px dot grain — and blurring a smooth gradient
 * returns almost the same gradient. The cost is not free: Android's blur is
 * `experimentalBlurMethod="dimezisBlurView"`, it re-renders its backdrop every
 * frame, and these panels sit over boards that animate every piece move. Add
 * BlurView only if a board ever gains detailed content behind a panel (a photo,
 * a video seat) where the blur would actually have something to dissolve.
 */
export const glass = {
  backgroundColor: white(0.075),
  borderWidth: 1,
  borderColor: white(0.16),
  borderRadius: R[3],
  // The inset rim is doing more work than it used to: with no solid fill, the
  // lit top edge is most of what says "this surface has a thickness".
  boxShadow: `${E[3]}, inset 0 1px 0 ${white(0.18)}`,
  ...Platform.select({ android: { elevation: 12 }, default: {} }),
} as const;

/** Gold button fill, as a LinearGradient colour stop list. */
export const GOLD_FILL = [C.gold2, C.gold, C.goldDeep] as const;
export const GOLD_STOPS = [0, 0.55, 1] as const;

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

/**
 * Ambient background wash, from body::before. Four radial glows.
 *
 * STRENGTHENED, and that is load-bearing rather than decorative. A translucent
 * surface has no colour of its own; it shows whatever is behind it. At the old
 * 0.08–0.14 the room was near-black everywhere, so every glass panel resolved
 * to the same dim grey and the whole screen went flat — the glass was working
 * and there was simply nothing for it to pick up. A fourth glow in the lower
 * half matters for the same reason: the boards and the hand sit down there,
 * and without it the bottom third of every screen was unlit.
 */
export const AMBIENT = [
  { color: C.gold,    opacity: 0.30, cx: '50%',  cy: '-8%', rx: '65%', ry: '42%' },
  { color: '#7c3aed', opacity: 0.28, cx: '100%', cy: '18%', rx: '52%', ry: '36%' },
  { color: '#10b981', opacity: 0.18, cx: '0%',   cy: '52%', rx: '48%', ry: '34%' },
  { color: '#e11d48', opacity: 0.20, cx: '78%',  cy: '88%', rx: '55%', ry: '38%' },
] as const;

/** body::after — the 22px dot grain that keeps large felt areas from banding. */
export const GRAIN = { size: 22, dot: 1, color: 'rgba(255,255,255,0.025)', opacity: 0.5 } as const;
