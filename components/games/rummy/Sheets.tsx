// components/games/rummy/Sheets.tsx — the result of a deal, and the standings
// mid-hand. Split out of components/games/Rummy.tsx; behaviour unchanged apart
// from each row being one screen-reader stop.

import React from 'react';
import { Text, View } from 'react-native';
import { Banner, Btn, RematchBtn, useType } from '../ui';
import { Sheet } from '../feedback';
import type { Rematch } from '../../../lib/games/useRematch';
import type { RummyMatch } from '../../../lib/games/useRummyMatch';
import { variantLabel, standings, progressLabel } from '../../../lib/games/match';
import { ranked, activeCount, pid, type RummyPlayer, type Settlement } from '../../../lib/games/rummyTable';
import { C, S, R, T, mix, goldLine } from '../../../lib/games/theme';

/* ── the result ─────────────────────────────────────────────────────── */

/**
 * The round's standings and what it cost.
 *
 * Every number is the server's: `points` per player, and `settlement[id].delta`
 * for the coins. Ranking order is the server's winner first, then points
 * ascending, because points rummy scores DOWN.
 */
export function ResultSheet({
  visible, players, settlement, winnerId, you, host, tableName, onClose, rematch, onShare, onLobby,
}: {
  visible: boolean;
  players: RummyPlayer[];
  settlement: Settlement;
  winnerId?: string | null;
  you: string;
  host: boolean;
  tableName?: string;
  onClose: () => void;
  rematch: Rematch;
  onShare: () => void;
  onLobby: () => void;
}) {
  const t = useType();
  const order = ranked(players, winnerId);
  const won = winnerId === you;
  const winner = players.find(p => pid(p) === winnerId);

  return (
    <Sheet visible={visible} title={tableName ? `${tableName} — result` : 'Result'} onClose={onClose}>
      <Banner
        text={won ? '🏆 You won this deal' : `${winner?.name ?? 'Someone'} won this deal`}
        tone={won ? 'win' : 'lose'}
      />

      <View style={{ gap: S[1] }}>
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flexDirection: 'row', paddingHorizontal: S[2] }}>
          <Text style={{ width: 26, color: C.muted, fontSize: T.xs, fontWeight: '700' }}>#</Text>
          <Text style={{ flex: 1, color: C.muted, fontSize: T.xs, fontWeight: '700' }}>Player</Text>
          <Text style={{ width: 54, textAlign: 'right', color: C.muted, fontSize: T.xs, fontWeight: '700' }}>Points</Text>
          <Text style={{ width: 66, textAlign: 'right', color: C.muted, fontSize: T.xs, fontWeight: '700' }}>Coins</Text>
        </View>
        {order.map((p, i) => {
          const isYou = pid(p) === you;
          const d = settlement[pid(p)]?.delta;
          return (
            <View
              key={pid(p)}
              accessible
              accessibilityLabel={`${i + 1}. ${p.name}${isYou ? ', you' : ''}, ${p.points} points${d != null ? `, ${d} coins` : ''}`}
              style={{
                flexDirection: 'row', alignItems: 'center',
                paddingVertical: S[2], paddingHorizontal: S[2], borderRadius: R[2],
                backgroundColor: pid(p) === winnerId ? mix(C.gold, 16, C.panel2) : isYou ? C.panel2 : 'transparent',
                borderWidth: isYou ? 1 : 0, borderColor: goldLine[22],
              }}
            >
              <Text style={{ width: 26, color: C.text, fontSize: t.sm, fontWeight: '800' }}>{i + 1}</Text>
              <Text numberOfLines={1} style={{ flex: 1, color: C.text, fontSize: t.sm, fontWeight: isYou ? '800' : '600' }}>
                {p.name}{isYou ? ' (you)' : ''}
              </Text>
              <Text style={{ width: 54, textAlign: 'right', color: C.text, fontSize: t.sm }}>{p.points ?? 0}</Text>
              {/* A zero delta says nothing happened, not that something GOOD
                  happened - `>= 0` put it in the same green "+0" branch as a
                  real win. Ties to the history list's own detailOf fix. */}
              <Text style={{ width: 66, textAlign: 'right', fontSize: t.sm, fontWeight: '700', color: d == null || d === 0 ? C.muted : d > 0 ? C.good : C.bad }}>
                {d == null ? '—' : d === 0 ? '0' : d > 0 ? `+${d}` : `${d}`}
              </Text>
            </View>
          );
        })}
      </View>

      <Text style={{ color: C.muted, fontSize: 11.5, lineHeight: 17 }}>
        {`${activeCount(players)} of ${players.length} players were still in at the end. Coins are play coins — not money.`}
      </Text>

      <View style={{ flexDirection: 'row', gap: S[2] }}>
        {host
          ? <RematchBtn rm={rematch} label="Deal again" />
          : <Text style={{ flex: 1, color: C.muted, fontSize: t.sm, alignSelf: 'center' }}>Waiting for the host to deal again…</Text>}
        <Btn label="Share" icon="share" compact onPress={onShare} />
      </View>
      <Btn label="Back to tables" onPress={onLobby} />
    </Sheet>
  );
}

/**
 * SCORE — the standings, mid-hand.
 *
 * Every number here is the server's and is already on the wire every frame:
 * `players[].points`, `.handCount`, `.status`, plus `closedCount` and the
 * round's wild rank. Nothing is computed, nothing is remembered between frames.
 *
 * It exists because the table could only ever be read at the END of a round.
 * `ResultSheet` shows the settlement once the hand is over and `MatchPanel`
 * lives in the lobby, so a player halfway through a deal had no way to answer
 * "who is winning" — the one question the whole game is about. In points rummy
 * that matters more than in most: the score runs DOWN, and whether to drop is a
 * decision you make against everyone else's totals.
 *
 * Ordered by `ranked`, the same function the result sheet uses, so the standing
 * a player watches during the hand is the standing they see at the end of it.
 */
export function StandingsSheet({
  visible, players, you, turnPlayerId, closedCount, wildRank, rmatch, onClose,
}: {
  visible: boolean;
  players: RummyPlayer[];
  you: string;
  turnPlayerId?: string | null;
  closedCount: number;
  wildRank?: string | null;
  rmatch: RummyMatch;
  onClose: () => void;
}) {
  const ty = useType();
  const order = ranked(players, null);
  const match = rmatch.match;
  const rows = match ? standings(match) : [];

  return (
    <Sheet visible={visible} title="Standings" onClose={onClose}>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flexDirection: 'row', paddingHorizontal: S[2] }}>
        <Text style={{ flex: 1, color: C.muted, fontSize: T.xs, fontWeight: '700' }}>Player</Text>
        <Text style={{ width: 58, textAlign: 'right', color: C.muted, fontSize: T.xs, fontWeight: '700' }}>Cards</Text>
        <Text style={{ width: 58, textAlign: 'right', color: C.muted, fontSize: T.xs, fontWeight: '700' }}>Points</Text>
      </View>

      {order.map(p => {
        const isYou = pid(p) === you;
        const out = p.status !== 'active' && p.status !== 'won';
        return (
          <View
            key={pid(p)}
            accessible
            accessibilityLabel={`${p.name}${isYou ? ', you' : ''}, ${p.handCount ?? 0} cards, ${p.points ?? 0} points${out ? `, ${p.status}` : ''}`}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: S[2],
              paddingVertical: S[2], paddingHorizontal: S[2], borderRadius: R[2],
              backgroundColor: isYou ? C.panel2 : 'transparent',
              borderWidth: isYou ? 1 : 0, borderColor: goldLine[22],
              opacity: out ? 0.55 : 1,
            }}
          >
            <Text numberOfLines={1} style={{ flex: 1, color: C.text, fontSize: ty.sm, fontWeight: isYou ? '800' : '600' }}>
              {p.name}{isYou ? ' (you)' : ''}
              {pid(p) === turnPlayerId ? ' ·' : ''}
            </Text>
            {out
              ? <Text style={{ width: 58, textAlign: 'right', color: C.muted, fontSize: 11, fontWeight: '800' }}>{p.status}</Text>
              : <Text style={{ width: 58, textAlign: 'right', color: C.text, fontSize: ty.sm }}>{p.handCount ?? 0}</Text>}
            <Text style={{ width: 58, textAlign: 'right', color: C.gold, fontSize: ty.sm, fontWeight: '800' }}>{p.points ?? 0}</Text>
          </View>
        );
      })}

      <Text style={{ color: C.muted, fontSize: 11.5, lineHeight: 17 }}>
        {`Points rummy scores down — the winner takes 0 and everyone else carries their deadwood. ${closedCount} cards left in the deck${wildRank ? ` · ${wildRank} is wild` : ''}.`}
      </Text>

      {/* The match across deals, when one is running. Same rows the lobby's
          panel shows — a pool score is not visible anywhere else mid-hand. */}
      {match && rows.length > 0 && (
        <>
          <Text style={{ color: C.text, fontSize: ty.md, fontWeight: '800', marginTop: S[2] }}>
            {variantLabel(match.variant)}
          </Text>
          {rows.map(r => (
            <View
              key={r.vaultId}
              accessible
              accessibilityLabel={`${r.name}${r.vaultId === you ? ', you' : ''}, ${match.poolLimit > 0 ? `${r.points} of ${match.poolLimit}` : `${r.chips} chips`}${r.status === 'out' ? ', out' : ''}`}
              style={{
                flexDirection: 'row', alignItems: 'center', gap: S[2],
                paddingVertical: S[2], paddingHorizontal: S[3], borderRadius: R[2],
                backgroundColor: r.vaultId === you ? C.panel2 : 'transparent',
                opacity: r.status === 'out' ? 0.5 : 1,
              }}
            >
              <Text numberOfLines={1} style={{ flex: 1, color: C.text, fontSize: ty.sm, fontWeight: '700' }}>
                {r.name}{r.vaultId === you ? ' (you)' : ''}
              </Text>
              {r.status === 'out' && <Text style={{ color: C.muted, fontSize: 11, fontWeight: '800' }}>OUT</Text>}
              <Text style={{ color: C.gold, fontSize: ty.sm, fontWeight: '800' }}>
                {match.poolLimit > 0 ? `${r.points} / ${match.poolLimit}` : `${r.chips >= 0 ? '+' : ''}${r.chips}`}
              </Text>
            </View>
          ))}
          <Text style={{ color: C.muted, fontSize: 11.5 }}>{progressLabel(match)}</Text>
        </>
      )}
    </Sheet>
  );
}
