// components/shopbook/theme.ts — Shop Book's palette and stylesheet, and the
// switch between the light and dark variants. Moved out of app/shop-book.tsx.

import { StyleSheet } from 'react-native';
// The shared ice-glass system. It lives under finance/ because Vault Finance is
// where it was built; Shop Book is the second consumer, not a fork of it.
// ponytail: left in place rather than renamed to shared/ — a third consumer is
// when the move earns its churn (spec §23 "do not reorganize unnecessarily").
import { FIN, FIN_DARK, FIN_RADIUS, TABULAR } from '../../constants/financeTheme';
import { FIN_GUTTER } from '../../lib/finance/grid';

// ── palette ────────────────────────────────────────────────────────
//
// Shop Book keeps its green+navy identity from the poster, but every neutral
// and every semantic state now comes from the shared ice-glass tokens that
// Vault Finance already runs on. There is ONE glass system in Mini Apps, not
// two — see docs/shopbook-redesign-spec.md.
//
// The key names are unchanged on purpose: ~380 call sites keep working, and the
// restyle happens because two of them now point somewhere else —
//
//   C.bg   = transparent  → the ice gradient in ShopBookScreen shows through
//   C.card = translucent  → all 19 card surfaces become glass panes
//
// That is the whole mechanism. 53 components change appearance without 53
// components being edited.
//
// Three semantic colours also move, and that is a contrast FIX, not taste:
// #DC2626 danger and #D97706 amber do not clear WCAG AA at the 12-13px sizes
// this screen actually uses them at. FIN.bad / FIN.warn do, and read the same.
/** Either ice-glass palette. `typeof FIN` alone is literal-typed ("#05603A"),
 *  so FIN_DARK's different literals would not satisfy it — widen each key to
 *  its kind while keeping contentMax numeric. */

export type Palette = { readonly [K in keyof typeof FIN]: (typeof FIN)[K] extends number ? number : string };

/**
 * Shop Book's token map, derived from whichever ice-glass palette is active.
 *
 * Every colour the screen renders comes through here — no component reads FIN
 * directly — so swapping the palette swaps the whole mini-app. The key names
 * are the original green/navy vocabulary, which is why ~380 call sites did not
 * have to change when this became theme-aware.
 */
export const makeC = (P: Palette) => ({
  // The poster identity. Fixed in light; in dark the accent has to lift OFF a
  // dark ground instead of sitting on white, so it is not the same green.
  green:      P === FIN ? '#0B7A3B' : '#5BD08B',
  greenDark:  P === FIN ? '#075E54' : '#2E9E67',
  greenSoft:  P === FIN ? '#DCFCE7' : '#0C2A1B',
  navy:       P === FIN ? '#1E3A5F' : '#A9C2E0',
  // navy as a FILL under white text. The dark-theme navy above is a light
  // accent for text, so white on it read at under 2:1; a fill needs its own.
  navyFill:   P === FIN ? '#1E3A5F' : '#24456E',

  // The app header is a large FILL, not accent text. One token cannot be both:
  // reusing the accent in dark gives a glaring slab, so the roles are split.
  headerBg:   P === FIN ? '#0B7A3B' : '#0C2A1B',
  headerFg:   P === FIN ? '#FFFFFF' : '#6EDBA0',

  bg:         P.bg,          // transparent — the gradient is the ground
  card:       P.card,        // translucent — the glass pane
  cardSolid:  P.cardSolid,   // when opacity is genuinely required (QR, sheets)
  chip:       P.card2,       // an unselected chip needs a real fill
  border:     P.border,
  line:       P.line,
  text:       P.text,
  sub:        P.sub,

  danger:     P.bad,         // light was #DC2626 — failed AA at 12-13px
  dangerSoft: P.badSoft,
  amber:      P.warn,        // light was #D97706 — failed AA at 12-13px
  warnSoft:   P.warnSoft,
  blue:       P.info,
  infoSoft:   P.infoSoft,
  good:       P.good,
  goodSoft:   P.goodSoft,

  // The ice ground, drawn once by IceGround.
  groundTop:    P.bgTop,
  groundMid:    P.bgMid,
  groundBottom: P.bgBottom,
  contentMax:   P.contentMax,
});

// ── styles ─────────────────────────────────────────────────────────
/**
 * The stylesheet, over a palette. Both variants are built ONCE at module load —
 * StyleSheet.create is not something to run per render — and the active one is
 * chosen by applyScheme() below.
 */
export const makeStyles = (C: ReturnType<typeof makeC>) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.groundMid },
  header: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: C.headerBg,
    paddingBottom: 14, paddingHorizontal: 14, gap: 6,
  },
  hBtn: { width: 38, height: 38, borderRadius: 19, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { color: C.headerFg, fontSize: 20, fontWeight: '800' },
  headerSub: { color: '#DCFCE7', fontSize: 12, marginTop: 1 },   // theme-exempt: pale green ON the green header bar, a fixed pair in both themes
  modeRow: { flexDirection: 'row', backgroundColor: C.greenDark, padding: 6, gap: 6 },
  modeBtn: {
    flex: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6,
    paddingVertical: 9, borderRadius: 10, backgroundColor: C.cardSolid,
  },
  modeBtnActive: { backgroundColor: C.navyFill },
  modeText: { color: C.green, fontWeight: '700', fontSize: 13 },
  modeTextActive: { color: '#fff' },

  subHeader: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: C.card,
    paddingTop: 12, paddingBottom: 12, paddingHorizontal: 8,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  subHeaderTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700', color: C.text },
  cartBadge: {
    position: 'absolute', top: 2, right: 2, backgroundColor: C.danger,
    borderRadius: 9, minWidth: 18, height: 18, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 4,
  },
  cartBadgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },

  // Every screen's content container. The cap is the responsive change with
  // the widest reach in the file: without it a khata list stretches a customer
  // name and their balance to opposite edges of a 1200dp window, which is
  // unreadable and looks broken. Same 632dp reading column Vault Finance uses.
  body: {
    padding: FIN_GUTTER, paddingBottom: 32,
    width: '100%', maxWidth: C.contentMax, alignSelf: 'center',
  },

  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.card,
    borderRadius: 12, paddingHorizontal: 12, borderWidth: 1, borderColor: C.border, marginBottom: 4,
  },
  searchInput: { flex: 1, paddingVertical: 11, color: C.text, fontSize: 14 },
  hint: { color: C.sub, fontSize: 12.5, marginVertical: 8, lineHeight: 18 },
  error: { color: C.danger, textAlign: 'center', marginTop: 16 },

  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: C.card,
    borderRadius: 20, paddingHorizontal: 12, paddingVertical: 7, marginRight: 8,
    borderWidth: 1, borderColor: C.border,
  },
  chipActive: { backgroundColor: C.green, borderColor: C.green },
  chipText: { color: C.text, fontSize: 12.5, fontWeight: '600' },

  card: {
    flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.card,
    borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: C.border,
  },
  shopIcon: {
    width: 46, height: 46, borderRadius: 12, backgroundColor: C.greenSoft,
    justifyContent: 'center', alignItems: 'center',
  },
  cardTitle: { color: C.text, fontSize: 15, fontWeight: '700' },
  cardSub: { color: C.sub, fontSize: 12.5, marginTop: 2 },
  price: { color: C.text, fontSize: 13.5, fontWeight: '700', marginTop: 4, ...TABULAR },

  badge: { alignSelf: 'flex-start', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2, marginTop: 6 },
  badgeDist: { backgroundColor: C.greenSoft, borderWidth: 1, borderColor: 'rgba(34,197,94,0.16)' },
  // Warn/danger washes come from the palette's soft tokens, which are chosen
  // to clear AA against their own foreground in BOTH themes — the old fixed
  // amber/brown pair was unreadable on the dark ground.
  locBanner: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.warnSoft, borderWidth: 1, borderColor: C.amber, borderRadius: 12, padding: 12, marginBottom: 12 },
  locBannerTitle: { fontSize: 14, fontWeight: '700', color: C.amber },
  locBannerSub: { fontSize: 12, color: C.text, marginTop: 2, lineHeight: 16 },
  badgeOpen: { backgroundColor: C.greenSoft },
  badgeSoon: { backgroundColor: C.warnSoft },
  badgeClosed: { backgroundColor: C.dangerSoft },
  badgeText: { fontSize: 11, fontWeight: '700', color: C.green },

  addBtn: { backgroundColor: C.green, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 9 },
  addBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },

  panel: { backgroundColor: C.card, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: C.border, marginVertical: 8, gap: 8 },
  panelTitle: { color: C.text, fontSize: 14, fontWeight: '700' },
  sectionLabel: { color: C.text, fontSize: 15, fontWeight: '800', marginTop: 14, marginBottom: 8 },

  input: {
    backgroundColor: C.card, borderRadius: 10, borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 12, paddingVertical: 11, color: C.text, fontSize: 14, marginBottom: 8,
  },
  fieldLabel: { color: C.sub, fontSize: 12.5, fontWeight: '600', marginBottom: 4 },

  primaryBtn: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8,
    backgroundColor: C.green, borderRadius: 12, paddingVertical: 14, marginTop: 8,
  },
  primaryBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  outlineBtn: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8,
    borderRadius: 12, paddingVertical: 13, marginTop: 8, borderWidth: 1.5, borderColor: C.green,
  },
  outlineBtnText: { color: C.green, fontWeight: '700', fontSize: 14 },
  dangerBtn: { alignItems: 'center', paddingVertical: 13, marginTop: 8 },
  dangerBtnText: { color: C.danger, fontWeight: '700', fontSize: 14 },

  smallGreen: { backgroundColor: C.green, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
  smallGreenText: { color: '#fff', fontWeight: '700', fontSize: 12 },
  smallOutline: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1, borderColor: C.border },
  smallOutlineText: { color: C.text, fontWeight: '600', fontSize: 12 },

  stickyCart: {
    flexDirection: 'row', justifyContent: 'space-between', backgroundColor: C.navyFill,
    borderRadius: 12, paddingVertical: 14, paddingHorizontal: 18, marginTop: 12,
  },
  stickyCartText: { color: '#fff', fontWeight: '800', fontSize: 15 },

  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  qtyBtn: { width: 30, height: 30, borderRadius: 8, backgroundColor: C.greenSoft, justifyContent: 'center', alignItems: 'center' },
  qtyBtnText: { color: C.green, fontSize: 18, fontWeight: '800' },
  qtyInput: {
    minWidth: 44, textAlign: 'center', fontSize: 15, fontWeight: '700',
    color: C.text, paddingVertical: 2, paddingHorizontal: 4,
  },
  qtyUnit: { fontSize: 12, color: C.sub, marginHorizontal: 2 },
  qtyText: { minWidth: 22, textAlign: 'center', fontSize: 15, fontWeight: '700', color: C.text },

  totalRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: C.card, borderRadius: 12, padding: 14, marginTop: 8, borderWidth: 1, borderColor: C.border,
  },
  totalLabel: { color: C.sub, fontSize: 14, fontWeight: '600' },
  totalValue: { color: C.text, fontSize: 18, fontWeight: '800', ...TABULAR },


  banner: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: FIN_RADIUS.md, borderWidth: 1, borderLeftWidth: 3,
    paddingVertical: 12, paddingHorizontal: 14, marginVertical: 8,
  },
  bannerText: { fontWeight: '700', fontSize: 13.5, lineHeight: 19 },
  bannerSub: { color: C.sub, fontSize: 12, lineHeight: 17, marginTop: 3 },

  infoRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.card,
    borderRadius: 10, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: C.border,
  },
  infoLabel: { color: C.sub, fontSize: 13, width: 74 },
  infoValue: { flex: 1, color: C.text, fontSize: 13.5, fontWeight: '600' },

  toggleRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: C.card, borderRadius: 10, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: C.border,
  },
  toggleLabel: { color: C.text, fontSize: 14, flex: 1 },

  statusBtn: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  statusBtnActive: { backgroundColor: C.green, borderColor: C.green },
  statusBtnText: { fontSize: 12.5, fontWeight: '700', color: C.text },

  filterBar: { backgroundColor: C.card, borderBottomWidth: 1, borderBottomColor: C.border, maxHeight: 50 },
  filterChip: { paddingHorizontal: 14, paddingVertical: 8, marginVertical: 7, marginRight: 8, borderRadius: 18, backgroundColor: C.chip },
  filterChipActive: { backgroundColor: C.green },
  filterChipText: { color: C.sub, fontWeight: '700', fontSize: 13 },
  filterChipTextActive: { color: '#fff' },

  stepper: { flexDirection: 'row', marginVertical: 10 },
  stepDot: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: C.border, backgroundColor: C.card, justifyContent: 'center', alignItems: 'center' },
  stepDotDone: { backgroundColor: C.green, borderColor: C.green },
  stepLabel: { fontSize: 9.5, color: C.sub, marginTop: 4, textAlign: 'center' },

  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, marginTop: 6 },
  pillDot: { width: 7, height: 7, borderRadius: 4 },
  pillText: { fontSize: 12, fontWeight: '700' },
  availTag: { fontSize: 12.5, fontWeight: '600', marginTop: 4 },


  tabBar: {
    flexDirection: 'row', backgroundColor: C.card, borderTopWidth: 1, borderTopColor: C.border,
    paddingTop: 8,   // paddingBottom comes from the safe-area inset in TabBar
  },
  tab: { flex: 1, alignItems: 'center', gap: 2, minHeight: 44, justifyContent: 'center' },
  tabLabel: { fontSize: 11, color: C.sub },

  // ── Phase 2 ────────────────────────────────────────
  favCard: {
    width: 120, backgroundColor: C.card, borderRadius: 12, padding: 12, marginRight: 10,
    borderWidth: 1, borderColor: C.border, alignItems: 'center', gap: 4,
  },
  favName: { color: C.text, fontSize: 12.5, fontWeight: '700', textAlign: 'center' },
  favRating: { color: C.amber, fontSize: 11 },

  offerCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.greenSoft,
    borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: 'rgba(34,197,94,0.16)',
  },
  offerText: { color: C.green, fontSize: 13.5, fontWeight: '700' },
  couponCode: {
    backgroundColor: C.green, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6,
    borderStyle: 'dashed', borderWidth: 1, borderColor: '#166534',
  },
  couponCodeText: { color: '#fff', fontSize: 12.5, fontWeight: '800', letterSpacing: 1 },

  stars: { color: C.amber, fontSize: 15, letterSpacing: 2 },
  reviewName: { color: C.sub, fontSize: 12, marginTop: 4, fontStyle: 'italic' },

  loyaltyCard: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: C.navyFill, borderRadius: 16,
    padding: 18, marginTop: 10,
  },
  loyaltyPoints: { color: '#fff', fontSize: 28, fontWeight: '800' },
  loyaltyTier: { color: '#93C5FD', fontSize: 13, fontWeight: '700', marginTop: 2 },
  loyaltySub: { color: C.sub, fontSize: 12, marginTop: 2 },

  ledgerItemLine: { color: C.sub, fontSize: 12, marginTop: 2 },
  amountNote: { color: C.sub, fontSize: 11, fontWeight: '600', marginTop: -3 },
  staleWarn: { color: C.amber, fontSize: 12, fontWeight: '600', marginTop: 2 },

  // ── Phase 2b ───────────────────────────────────────
  row: { flexDirection: 'row', alignItems: 'center' },
  planTag: { borderRadius: 5, paddingHorizontal: 6, paddingVertical: 1 },
  planFree: { backgroundColor: C.border },
  planPro: { backgroundColor: C.navyFill },
  planTagText: { fontSize: 9.5, fontWeight: '800', color: C.sub, letterSpacing: .5 },

  planCard: { backgroundColor: C.card, borderRadius: 16, padding: 18, marginBottom: 12, borderWidth: 1, borderColor: C.border },
  planCardPro: { borderColor: C.navy, borderWidth: 1.5 },
  planCardActive: { borderColor: C.green, borderWidth: 2 },
  planName: { fontSize: 18, fontWeight: '800', color: C.green, flex: 1 },
  planPer: { fontSize: 12, fontWeight: '600', color: C.sub },
  planFeat: { color: C.text, fontSize: 13, marginTop: 7 },
  btn2Tag: { marginTop: 12, backgroundColor: C.greenSoft, borderRadius: 10, paddingVertical: 11, alignItems: 'center' },
  btn2TagText: { color: C.green, fontWeight: '800', fontSize: 13 },

  barTrack: { height: 8, borderRadius: 4, backgroundColor: C.border, marginTop: 5, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4, backgroundColor: C.green },
  rankDot: { width: 26, height: 26, borderRadius: 13, backgroundColor: C.greenSoft, justifyContent: 'center', alignItems: 'center' },
  rankDotText: { color: C.green, fontWeight: '800', fontSize: 12 },

  // ── Phase 2c ───────────────────────────────────────
  micBtn: {
    width: 44, height: 44, borderRadius: 10, borderWidth: 1.5, borderColor: C.green,
    justifyContent: 'center', alignItems: 'center', backgroundColor: C.card,
  },
  micBtnOn: { backgroundColor: C.green, borderColor: C.green },
  findProductBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.greenSoft,
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, marginTop: 8,
    borderWidth: 1, borderColor: 'rgba(34,197,94,0.16)',
  },
  findProductText: { color: C.green, fontWeight: '700', fontSize: 13.5 },
  modalWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 26 },
  // The scroller inside a KeyboardSafe-wrapped modalWrap (2026-09-18). Centring
  // alone is not enough: "Add an item" is a title + 3 inputs + 2 buttons, which
  // needs ~430dp at OS font scale 1.5 — more than a 320dp-wide phone leaves once
  // the keyboard is up. flexGrow keeps the card centred while it fits and lets
  // it scroll the moment it does not, so the submit button is always reachable.
  modalScroll: { flexGrow: 1, justifyContent: 'center' },
  // Solid, not glass: this sits over a 55% black scrim, where a translucent
  // pane would let the dark through and drop the text under AA.
  modalCard: { backgroundColor: C.cardSolid, borderRadius: 18, padding: 20 },
  modalTitle: { color: C.text, fontSize: 18, fontWeight: '800', textAlign: 'center' },
});

// ── theme wiring ──────────────────────────────────────────────────
//
// `C` and `s` are module-level LET bindings, not consts. Every one of the ~53
// components dereferences them at RENDER time (`s.card`, `C.green`), never at
// import time, so re-pointing them here re-themes the whole mini-app without
// touching a single component. applyScheme is called during ShopBookScreen's
// render, BEFORE any child renders, and nothing below is memoized — so every
// descendant re-renders with the scheme and reads the palette just installed.
// (Deliberately not keyed on the scheme: see ShopBookScreen.)
//
// ponytail: module-global, so two Shop Book instances could not show different
// themes at once. There is exactly one, and it is a route — revisit only if
// that stops being true.
//
// Now that the components live in their own modules they import `C` and `s`
// from here. ES module imports are LIVE bindings (Babel compiles each use to a
// property read on this module), so a re-point below is seen by every importer.
const LIGHT_C = makeC(FIN);
const DARK_C = makeC(FIN_DARK);
const LIGHT_S = makeStyles(LIGHT_C);
const DARK_S = makeStyles(DARK_C);

export let C = LIGHT_C;
export let s = LIGHT_S;

/** Point the palette + stylesheet at a scheme. Idempotent. */
export function applyScheme(scheme: 'light' | 'dark') {
  const dark = scheme === 'dark';
  C = dark ? DARK_C : LIGHT_C;
  s = dark ? DARK_S : LIGHT_S;
}
