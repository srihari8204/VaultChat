// components/games/LeaderboardSheet.tsx — the standings, in one place.
//
// MOVED OUT OF app/games.tsx, unchanged apart from the `scope` prop below.
// Chess grew a Stats control of its own (2026-09-06) and the alternative was a
// second copy of this sheet — the exact defect gamesNative.selftest already
// guards against for VoiceSheet ("a second copy for chess is a second thing to
// fix when the mesh changes"). The hub renders it the same way it always did.

import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { Btn, useType } from './ui';
import { Sheet } from './feedback';
import { C, S, R, white, alpha } from '../../lib/games/theme';
import { getMyProfile } from '../../lib/chatService';
import { useLeaderboard } from '../../lib/games/useLeaderboard';
import { headline, medal, detail, type LeaderScope } from '../../lib/games/leaderboard';

/* ── leaderboard ────────────────────────────────────────────────────── */

const SCOPES: { key: LeaderScope; label: string }[] = [
  { key: 'all', label: 'Overall' },
  { key: 'chess', label: 'Chess' },
  { key: 'rummy', label: 'Rummy' },
  { key: 'ludo', label: 'Ludo' },
  { key: 'tictactoe', label: 'Tic-Tac-Toe' },
];

/**
 * The server's standings, its ordering, its cut.
 *
 * `Overall` and a single game are different tables, not a filter over one:
 * overall ranks by coins and sends no rating, a game ranks by Elo. `headline`
 * is what keeps each tab printing the number it actually has — see
 * lib/games/leaderboard.ts.
 *
 * Ten rows is the server's limit, not a page size; it ignores `?limit=`, so
 * there is nothing to page through and no "show more" to offer.
 */
export default function LeaderboardSheet({
  visible, onClose, initialScope = 'all',
}: {
  visible: boolean;
  onClose: () => void;
  /** Which tab to open on. The hub wants Overall; a board wants its own game,
   *  because a player who taps Stats from the chess table is asking about
   *  chess. Every tab is still one tap away either way. */
  initialScope?: LeaderScope;
}) {
  const [scope, setScope] = React.useState<LeaderScope>(initialScope);
  // Reopening from a different board must land on THAT board's table, not on
  // whichever tab was last looked at inside a sheet that never unmounts.
  React.useEffect(() => { if (visible) setScope(initialScope); }, [visible, initialScope]);
  const { rows, loading, error, refresh } = useLeaderboard(scope);
  const t = useType();

  // Which row is ME. The server returns ten rows and no rank for anyone else,
  // so this can highlight a place in the table but must NOT invent a position
  // for a player who is not on it — "not in the top ten" is the whole truth we
  // have, and claiming a number would be claiming a standing the server never
  // sent (the same rule the rest of this screen follows).
  const [meVault, setMeVault] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!visible || meVault) return;
    getMyProfile().then(p => setMeVault(p.vaultId ?? null)).catch(() => {});
  }, [visible, meVault]);
  const myIndex = meVault ? rows.findIndex(r => r.vaultId === meVault) : -1;

  return (
    <Sheet visible={visible} title="Leaderboard" onClose={onClose}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: S[1], paddingBottom: S[1] }}
      >
        {SCOPES.map(sc => (
          <Pressable
            key={sc.key}
            onPress={() => setScope(sc.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: scope === sc.key }}
            // 8dp of padding either side of ~15dp of text is a 31dp target, and
            // there are five of them in a row. minHeight takes it to the 44dp
            // floor the rest of the games already hold (Btn's `inner`, the ludo
            // token's computed hitSlop, rummy's IconBtn).
            style={{
              paddingHorizontal: S[3], paddingVertical: S[2], borderRadius: R[3],
              minHeight: 44, justifyContent: 'center',
              borderWidth: 1,
              borderColor: white(scope === sc.key ? 0.30 : 0.12),
              backgroundColor: scope === sc.key ? white(0.13) : 'transparent',
            }}
          >
            <Text style={{
              color: scope === sc.key ? C.text : C.muted,
              fontSize: t.sm, fontWeight: '700',
            }}>
              {sc.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {loading && rows.length === 0 ? (
        <View style={{ paddingVertical: S[5], alignItems: 'center' }}>
          <ActivityIndicator color={C.gold} />
        </View>
      ) : error ? (
        <View style={{ gap: S[2], paddingVertical: S[2] }}>
          <Text style={{ color: C.bad, fontSize: t.sm }}>{error}</Text>
          <Btn label="Try again" compact onPress={refresh} />
        </View>
      ) : rows.length === 0 ? (
        <Text style={{ color: C.muted, fontSize: t.sm, lineHeight: 19, paddingVertical: S[2] }}>
          Nobody has finished a game here yet. Win one and this is where you show up.
        </Text>
      ) : (
        <View style={{ gap: 2 }}>
          {rows.map((r, i) => {
            const h = headline(r, scope);
            return (
              <View
                key={r.vaultId}
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: S[2],
                  paddingVertical: S[2], paddingHorizontal: S[2], borderRadius: R[1],
                  backgroundColor: i === myIndex ? alpha(C.gold, 0.16)
                    : i < 3 ? white(0.07) : 'transparent',
                  borderWidth: i === myIndex ? 1 : 0, borderColor: alpha(C.gold, 0.45),
                }}
              >
                <Text style={{ width: 26, textAlign: 'center', color: C.muted, fontSize: t.sm, fontWeight: '800' }}>
                  {medal(i)}
                </Text>
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={{ color: C.text, fontSize: t.sm, fontWeight: '700' }}>{r.name}</Text>
                  <Text numberOfLines={1} style={{ color: C.muted, fontSize: 11.5 }}>{detail(r)}</Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={{ color: C.gold, fontSize: t.sm, fontWeight: '800' }}>{h.value}</Text>
                  <Text style={{ color: C.muted, fontSize: 10.5 }}>{h.label}</Text>
                </View>
              </View>
            );
          })}
        </View>
      )}

      <Text style={{ color: C.muted, fontSize: 11.5, lineHeight: 17 }}>
        {myIndex >= 0
          ? `You are ${medal(myIndex)} in this table. Top ten, ranked by the games server.`
          : rows.length > 0
            ? 'You are not in the top ten. The server ranks and cuts this table; it does not send a position for anyone below it.'
            : 'Top ten, ranked by the games server.'}
        {' '}Coins are demo coins — they are not money and cannot be cashed out.
      </Text>
    </Sheet>
  );
}
