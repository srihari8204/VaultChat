/**
 * Shared styling/theme helpers for the in-app games.
 *
 * Games ship fully native — no WebView, no external server. This module owns the
 * shared palette mapping (games read the active theme via useColors() so they
 * match the Obsidian Aurora design in either light or dark mode) plus a few
 * layout primitives reused across boards (centered fill, card surface, pill
 * button) so each game file can stay focused on its rules.
 */

import { StyleSheet } from "react-native";
import { RADIUS, SPACING, type Palette } from "../../constants/theme";

/**
 * Build a StyleSheet bound to the active palette. Called per-render with the
 * current `colors` so light/dark stays correct without a re-mount — the games
 * read palette values at render time, not from a module-scoped singleton.
 */
export function gameStyles(c: Palette) {
  return StyleSheet.create({
    fill: { flex: 1, backgroundColor: c.bg },
    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: SPACING.lg,
    },
    card: {
      backgroundColor: c.card,
      borderRadius: RADIUS.lg,
      padding: SPACING.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
    },
    pill: {
      borderRadius: RADIUS.pill,
      paddingVertical: SPACING.sm + 2,
      paddingHorizontal: SPACING.lg,
      alignItems: "center",
      justifyContent: "center",
    },
    primaryBtn: {
      backgroundColor: c.primary,
    },
    ghostBtn: {
      backgroundColor: c.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
    },
    btnLabel: {
      color: "#FFFFFF",
      fontSize: 15,
      fontWeight: "700",
    },
    ghostBtnLabel: {
      color: c.text,
      fontSize: 15,
      fontWeight: "600",
    },
    title: {
      color: c.text,
      fontSize: 22,
      fontWeight: "800",
      marginBottom: SPACING.xs,
    },
    subtitle: {
      color: c.textDim,
      fontSize: 14,
      marginBottom: SPACING.lg,
    },
    status: {
      color: c.text,
      fontSize: 16,
      fontWeight: "600",
      textAlign: "center",
      marginBottom: SPACING.md,
    },
    scoreRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      width: "100%",
      maxWidth: 420,
      marginBottom: SPACING.md,
    },
    scoreCell: {
      alignItems: "center",
    },
    scoreName: {
      color: c.textDim,
      fontSize: 12,
      fontWeight: "600",
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    scoreVal: {
      color: c.text,
      fontSize: 20,
      fontWeight: "800",
    },
  });
}

/** A deterministic roll in [1, 6] — used by Ludo so a dice tap is reproducible
 *  across a given seed (keeps the AI honest and the pass-and-play fair). */
export function d6(seed: number): number {
  // xorshift32-ish — cheap, good enough for a game dice.
  let x = seed | 0 || 1;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return (Math.abs(x) % 6) + 1;
}

/** Colourblind-safe per-player token hues used by Ludo and any board game that
 *  needs four distinct players. Hex so React Native can consume directly. */
export const PLAYER_COLORS = {
  red: "#EF4444",
  green: "#22C55E",
  yellow: "#F59E0B",
  blue: "#3B82F6",
} as const;
