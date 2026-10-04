// components/games/ludo/Chrome.tsx — the seat cards and the turn indicator.
// Split out of components/games/Ludo.tsx; each seat is now one screen-reader
// stop and the turn is announced.

import React from 'react';
import { Text, View, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useType, useAnnounce } from '../ui';
import { S, R, D3, white } from '../../../lib/games/theme';
import { LR, SEAT, COLOR_NAMES, SHAPE, LG, seatA } from '../../../lib/games/ludoGlass';
import { HOME_STEP, type LPlayer } from '../../../lib/games/ludoBoard';
import { initialOf } from '../../../lib/format';

/* ── chrome ─────────────────────────────────────────────────────────── */

/**
 * A seat: who, what they are doing, and how close they are to finishing.
 *
 * Laid out two to a row rather than four stacked, because four full-width rows
 * cost about 100dp of the board's height to carry information that is two words
 * wide — and the board is the thing this screen is for.
 *
 * THE AVATAR IS A MONOGRAM, NOT A PHOTO, and that is a protocol fact rather
 * than a style choice: `GameLobby.members` is `{vaultId, name, isBot, wins}`
 * and `G.players` carries no image anywhere, so a photo would need a server
 * change. A lit ring in the seat's own colour identifies the player just as
 * well and costs nothing.
 *
 * Every field is live. `status` is derived from the same `turnPlayerId` the
 * board reads; `done` counts tokens at HOME_STEP. Nothing here is placeholder.
 */
export function SeatCard({ player, you, active, status }: { player: LPlayer; you: boolean; active: boolean; status: string }) {
  const t = useType();
  const { fontScale } = useWindowDimensions();
  const avatarSize = Math.max(32, Math.ceil(14 * fontScale + 12));
  const tokens = player.tokens ?? [];
  const done = tokens.filter(s => s >= HOME_STEP).length;
  const total = tokens.length || 4;
  const pct = tokens.length
    ? Math.round((tokens.reduce((n, s) => n + Math.max(0, Math.min(s, HOME_STEP)), 0) / (tokens.length * HOME_STEP)) * 100)
    : 0;
  const seat = SEAT[player.seat] ?? SEAT[0];

  return (
    <View
      // One stop per seat; without `accessible` iOS ignores this label.
      accessible
      accessibilityLabel={`${player.name}${you ? ', you' : ''}${player.isBot ? ', bot' : ''}, ${COLOR_NAMES[player.seat] ?? ''}, ${status}, ${done} of ${total} home`}
      style={{
        flex: 1, minWidth: 0, gap: S[2],
        paddingVertical: S[2], paddingHorizontal: S[3],
        borderRadius: R[4], borderWidth: 1,
        borderColor: active ? seatA(player.seat, 'base', 0.85) : white(0.14),
        backgroundColor: white(active ? LG.cardActive : LG.card),
        boxShadow: active
          ? `0 0 16px ${seatA(player.seat, 'base', 0.45)}, inset 0 1px 0 ${white(0.22)}`
          : `${D3.lift1}, inset 0 1px 0 ${white(0.14)}`,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: S[2] }}>
      {/* avatar: monogram over a seat-tinted disc, ringed and lit when active */}
      <View style={{
        width: avatarSize, height: avatarSize, borderRadius: avatarSize / 2,
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: seatA(player.seat, 'deep', 0.55),
        borderWidth: 1.5, borderColor: seatA(player.seat, 'light', active ? 0.95 : 0.6),
        boxShadow: active ? `0 0 10px ${seatA(player.seat, 'base', 0.7)}` : undefined,
      }}>
        {player.isBot
          ? <Ionicons name="hardware-chip-outline" size={16} color={LR.text} />
          : <Text style={{ color: LR.text, fontSize: 14, fontWeight: '800' }}>
              {initialOf(player.name)}
            </Text>}
        {/* The shape marker rides the avatar. The colourblind fallback has to be
            on the CARD as well as on the pawn, or a red/green pair is
            distinguishable on the board and not in the roster. */}
        <Text style={{
          position: 'absolute', right: -3, bottom: -4, fontSize: 9,
          color: seat.light, textShadowColor: LR.bg, textShadowRadius: 2,
        }}>{SHAPE[player.seat]}</Text>
      </View>

      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text style={{ color: LR.text, fontSize: t.sm, fontWeight: '700' }}>
          {player.name}{you ? ' (you)' : ''}
        </Text>
      </View>
      </View>

      {/* Home counter. The house keeps the number from being a bare figure, and
          the bar underneath is the same `pct` the old row showed. */}
      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: S[1] }}>
        <Text style={{ flexGrow: 1, flexShrink: 1, color: active ? LR.ok : LR.muted, fontSize: 11, fontWeight: active ? '700' : '400' }}>
          {status}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
          <Ionicons name="home" size={11} color={LR.muted} />
          <Text style={{ color: done > 0 ? seat.light : LR.text, fontSize: 12, fontWeight: '800' }}>
            {done}/{total}
          </Text>
        </View>
      </View>
        <View style={{ width: '100%', height: 3, borderRadius: 2, backgroundColor: 'rgba(0,0,0,0.34)', overflow: 'hidden' }}>
          <View style={{ width: `${pct}%`, height: '100%', backgroundColor: seat.base }} />
        </View>
    </View>
  );
}

/**
 * The turn indicator.
 *
 * This is the status line that already lived under the die, given a surface. It
 * says exactly what `mine` / `canMove` / `die` already decide and never implies
 * a tap that is not allowed — `tone` only chooses the colour of a state the
 * caller has already worked out.
 */
export function TurnIndicator({ title, sub, tone }: { title: string; sub?: string; tone: 'you' | 'wait' | 'act' }) {
  const t = useType();
  // iOS hears the turn change here; Android through the live region below.
  useAnnounce(sub ? `${title}. ${sub}` : title);
  const edge = tone === 'you' ? LR.ok : tone === 'act' ? SEAT[2].base : white(0.14);
  return (
    <View
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={sub ? `${title}. ${sub}` : title}
      style={{
        alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: S[3],
        paddingVertical: S[2], paddingHorizontal: S[3],
        borderRadius: R[3], borderWidth: 1,
        borderColor: tone === 'wait' ? white(0.14) : edge,
        backgroundColor: white(0.08),
        boxShadow: tone === 'wait'
          ? `inset 0 1px 0 ${white(0.16)}`
          : `0 0 18px ${tone === 'you' ? 'rgba(62,232,155,0.22)' : seatA(2, 'base', 0.22)}, inset 0 1px 0 ${white(0.20)}`,
      }}
    >
      <View style={{
        width: 34, height: 34, borderRadius: R[2],
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: white(0.12), borderWidth: 1, borderColor: white(0.2),
      }}>
        <Ionicons name="dice-outline" size={19} color={tone === 'wait' ? LR.muted : LR.text} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: LR.text, fontSize: t.md, fontWeight: '800' }}>{title}</Text>
        {sub ? <Text style={{ color: LR.muted, fontSize: 11.5 }}>{sub}</Text> : null}
      </View>
    </View>
  );
}
