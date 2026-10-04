// components/games/rummy/useHand.ts — the player's own hand: how it is
// arranged into groups, what is selected, and the turn actions that act on it
// (draw, discard, declare, drop-to-discard, sort).
//
// Moved out of components/games/Rummy.tsx (2026-10 round 4) with no change in
// behaviour. The server still decides everything: `declare` sends the grouping
// and the server judges it; the meld hint below is advisory and never gates a
// send (lib/games/gamesNative.selftest.ts).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ScrollView } from 'react-native';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { playSfx } from '../../../lib/games/sfx';
import {
  reconcile, sameGroups, moveCard, sortHand, isSortMode, type Groups, type SortMode,
} from '../../../lib/games/handGroups';
import { analyzeHand } from '../../../lib/games/meldHint';
import type { Card, Zone } from './shared';

/* ── the remembered sort mode ───────────────────────────────────────── */
//
// Module-level and read back once, the same shape sfx.ts uses for the mute
// preference: it has to be readable synchronously during the first render, and
// a hand that re-sorts itself a beat after it appears looks broken. It lives
// here rather than in handGroups.ts because that module is exercised by a
// Node-run self-check and must stay free of native modules.

const SORT_KEY = 'vc_rummy_sort';
// SUIT, not 'smart'. Sorting in a rummy app means one cluster per suit, in rank
// order, so a player can see at a glance which sequences they are one card
// away from — that is the whole point of the button, and it is what every
// reference client does. 'smart' pulls completed melds to the front and leaves
// the rest in one mixed group, which reads as "it did something else". It is
// still available in Table settings for players who prefer it, along with
// by-rank and manual.
let sortModePref: SortMode = 'suit';
AsyncStorage.getItem(SORT_KEY)
  .then(v => { if (isSortMode(v)) sortModePref = v; })
  .catch(() => {});

export function useHand({ hand, wildRank, live, send, mustDraw, mustDiscard, act, notify }: {
  hand: Card[];
  /** This round's wild rank, off the game frame. */
  wildRank: string | null | undefined;
  /** A game frame exists (the arrangement is only sent to a running hand). */
  live: boolean;
  send: (m: any) => void;
  mustDraw: boolean;
  mustDiscard: boolean;
  /** The one-action-at-a-time lock from the board. */
  act: (key: string, msg: Record<string, unknown>) => void;
  notify: (msg: string) => void;
}) {
  /* ── the player's arrangement ────────────────────────────────────── */

  // SELECTION IS BY CARD ID, AND AN ID CAN OUTLIVE THE CARD.
  //
  // A selection made in one deal survived into the next: nothing cleared it
  // when a new hand arrived (the deal effect below resets `groups` and
  // `dealtFor` and never touched this), so you finished a hand with a card
  // selected — the usual case, since you were about to discard it — and after
  // the re-deal DISCARD lit up on `picked.length === 1`, sent a cardId you no
  // longer held, and came back as a bare "⚠" while the turn clock ran.
  //
  // Clearing it on a new deal would fix that one path and leave the others: the
  // server auto-discards for a player who times out, and a reconnect can hand
  // back a different hand entirely — both leave an id behind that names no card.
  // So the selection is FILTERED BY THE HAND on the way out instead. An id that
  // is not in `byId` is not a card you can act on, wherever it came from, and
  // every read below — the buttons, their enablement, discard, declare — goes
  // through the filtered value.
  const [pickedRaw, setPicked] = useState<string[]>([]);
  const [groups, setGroups] = useState<Groups>([[]]);
  const [sortMode, setSortMode] = useState<SortMode>(sortModePref);
  const byId = useMemo(() => new Map(hand.map(c => [c.id, c])), [hand]);
  const picked = useMemo(() => pickedRaw.filter(id => byId.has(id)), [pickedRaw, byId]);

  const isJoker = useCallback(
    (c: { suit: string; rank: string }) => c.suit === 'JOKER' || (!!wildRank && c.rank === wildRank),
    [wildRank],
  );

  // A new deal arrives pre-arranged, the way every native rummy app does it —
  // unless the player asked for `manual`, in which case an auto-arrangement
  // would be undoing work they intend to do themselves.
  const dealtFor = useRef<string>('');
  useEffect(() => {
    if (hand.length === 0) return;
    const fingerprint = hand.map(c => c.id).sort().join('|');

    setGroups(prev => {
      const held = prev.flat();
      // A hand that shares nothing with the arrangement is a fresh deal.
      const fresh = held.length === 0 || !held.some(id => hand.some(c => c.id === id));
      if (fresh && dealtFor.current !== fingerprint) {
        dealtFor.current = fingerprint;
        return sortMode === 'manual'
          ? reconcile(prev, hand.map(c => c.id))
          : sortHand(sortMode, hand, isJoker, prev);
      }
      const next = reconcile(prev, hand.map(c => c.id));
      return sameGroups(prev, next) ? prev : next;
    });
  }, [hand, sortMode, isJoker]);

  // Arrangement is persisted per seat by the server, so a reconnecting player
  // gets their groups back rather than thirteen loose cards mid-hand.
  const sentGroups = useRef<Groups | null>(null);
  useEffect(() => {
    if (!live || groups.flat().length === 0) return;
    if (sentGroups.current && sameGroups(sentGroups.current, groups)) return;
    sentGroups.current = groups;
    send({ t: 'arrange', groups: groups.filter(g => g.length > 0) });
  }, [groups, live, send]);

  const prevHand = useRef<number | null>(null);
  useEffect(() => {
    const n = hand.length;
    if (prevHand.current != null && n !== prevHand.current) {
      playSfx(n > prevHand.current ? 'deal' : 'discard');
    }
    prevHand.current = n;
  }, [hand.length]);

  /** ADVISORY ONLY — the server judges the declaration. */
  const hint = useMemo(
    () => analyzeHand(groups, id => byId.get(id), wildRank ?? null),
    [groups, byId, wildRank],
  );

  /* ── drag and drop ───────────────────────────────────────────────── */
  //
  // Group rows and the discard pile publish their WINDOW rect on layout, so the
  // gesture's absoluteX/absoluteY can be compared directly with no parent
  // offset to keep in step as the layout shifts — which it does on every
  // rotation.

  const zones = useRef<Zone[]>([]);
  const discardZone = useRef<Zone | null>(null);
  const tableScrollY = useRef(0);
  const handScrollX = useRef(0);
  const mountTableScroll = useCallback((node: ScrollView | null) => {
    // The lobby can unmount this viewport without unmounting Rummy. A new
    // viewport starts at zero, before its children measure their drop targets.
    if (node) { tableScrollY.current = 0; handScrollX.current = 0; }
  }, []);
  const setZone = useCallback((i: number, z: Zone) => { zones.current[i] = z; }, []);

  const discard = useCallback((cardId: string) => {
    if (!mustDiscard) { notify('Take a card from a pile first.'); playSfx('error'); return; }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    act('discard', { t: 'discard', cardId });
    setPicked([]);
  }, [mustDiscard, act, notify]);

  /**
   * Where a released card lands.
   *
   * The discard pile is checked first and is the only drop that leaves the
   * hand. It is gated on `mustDiscard`, so a card dragged there before drawing
   * springs back with a reason rather than being thrown away — the invalid drop
   * restores, it never commits.
   */
  const dropAt = useCallback((cardId: string, x: number, y: number) => {
    const inside = (z: Zone | null) => !!z && x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h;

    if (inside(discardZone.current)) {
      if (mustDiscard) { discard(cardId); return; }
      notify('Take a card from a pile before discarding.');
      playSfx('error');
      return;
    }

    const hit = zones.current.findIndex(z => inside(z));
    setGroups(g => moveCard(g, cardId, hit));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    playSfx('tick');
  }, [mustDiscard, discard, notify]);

  const toggle = useCallback((id: string) => {
    Haptics.selectionAsync().catch(() => {});
    playSfx('select');
    setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]));
  }, []);

  const draw = useCallback((source: 'open' | 'closed') => {
    if (!mustDraw) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    act(`draw:${source}`, { t: 'draw', source });
  }, [mustDraw, act]);

  const declare = useCallback(() => {
    // The same guard `discard` opens with, and for a sharper reason: the
    // confirm sheet stays open across state changes, so the turn can pass (or
    // the server can auto-discard for you) while "Declare?" is on screen. The
    // button's `disabled` prop was the ONLY gate, and a sheet that is already
    // open does not re-read it — this was the one path in the UI that could
    // emit an action out of turn.
    if (!mustDiscard) { notify('It is not your turn.'); playSfx('error'); return; }
    if (picked.length !== 1) return;
    const laid = groups.map(g => g.filter(id => id !== picked[0])).filter(g => g.length > 0);
    act('declare', { t: 'declare', discardId: picked[0], groups: laid });
    setPicked([]);
  }, [mustDiscard, picked, groups, act, notify]);

  /** Lay the hand out now, without touching the remembered preference. */
  const sortNow = useCallback((mode: SortMode) => {
    if (mode === 'manual') return;
    setGroups(g => sortHand(mode, hand, isJoker, g));
    setPicked([]);
    playSfx('tick');
  }, [hand, isJoker]);

  /**
   * Change the remembered preference, and apply it.
   *
   * Separate from sortNow because the Sort BUTTON must not silently convert a
   * player who chose `manual` into a `smart` player for every future deal —
   * they asked once, not forever.
   */
  const applySort = useCallback((mode: SortMode) => {
    setSortMode(mode);
    sortModePref = mode;
    void AsyncStorage.setItem(SORT_KEY, mode).catch(() => {});
    sortNow(mode);
  }, [sortNow]);

  return {
    picked, setPicked, groups, setGroups, sortMode, byId, isJoker, hint,
    zones, discardZone, tableScrollY, handScrollX, mountTableScroll, setZone,
    discard, dropAt, toggle, draw, declare, sortNow, applySort,
  };
}
