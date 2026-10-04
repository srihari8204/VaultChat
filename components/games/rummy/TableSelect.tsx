// components/games/rummy/TableSelect.tsx — choosing a rummy table: the server's
// list, its two filters, and joining by a typed code.
// Split out of components/games/Rummy.tsx; behaviour unchanged.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { TableBackground, Panel, Btn, useType } from '../ui';
import { KeyboardSafe } from '../../ui/KeyboardSafe';
import { Toasts } from '../feedback';
import { GAMES_HTTP } from '../../../lib/gamesSocket';
import { playSfx } from '../../../lib/games/sfx';
import {
  normalizeCode, filterBySeats, filterByKind,
  type TableInfo, type SeatFilter, type KindFilter,
} from '../../../lib/games/rummyTable';
import { C, S, R, T, alpha, goldLine, white } from '../../../lib/games/theme';
import { VARIANT, useColumn } from './shared';

/**
 * The table-size filter.
 *
 * "Multi-player" is every table above two seats, NOT exactly six: the server
 * publishes a 2–6 range, so a filter pinned to 6 would hide 3-, 4- and 5-seat
 * tables and look like there were none open. The rule lives in
 * lib/games/rummyTable.ts; this is only its labelling.
 */
const SEAT_FILTERS: { mode: SeatFilter; label: string; a11y: string }[] = [
  { mode: 'all',      label: 'All tables',  a11y: 'Show all tables' },
  { mode: 'heads-up', label: '2 players',   a11y: 'Show head-to-head tables only' },
  { mode: 'multi',    label: 'Multiplayer', a11y: 'Show tables for three or more players' },
];

/**
 * Practice · Free · Bots — what kind of game the player is after.
 *
 * "Free" is the staked tab under its honest name: this server's stakes are PLAY
 * COINS, which cannot be bought and cannot be cashed out (the table list says
 * so in as many words), so calling the other tab "Cash" would be the one piece
 * of wording on this screen that is not true.
 *
 * Bots lists the same tables as Practice, and that is not a duplicate: only a
 * practice table accepts `addbot`, so the SET cannot differ. What differs is
 * what joining does — from Bots the client seats you and asks for a bot in the
 * same breath, so it is one tap from the list to a game against the computer.
 */
const KIND_FILTERS: { mode: KindFilter; label: string; a11y: string }[] = [
  { mode: 'all',      label: 'All',      a11y: 'Show every kind of table' },
  { mode: 'practice', label: 'Practice', a11y: 'Show practice tables, which cost no coins' },
  { mode: 'stakes',   label: 'Free',     a11y: 'Show tables played for play coins' },
  { mode: 'bots',     label: 'Bots',     a11y: 'Show tables you can play against a bot, and seat a bot when you join' },
];

/**
 * One segment of a filter row.
 *
 * Extracted because there are now two rows of these, and the copy that existed
 * carried a bug worth not duplicating: the SELECTED chip asked for
 * `goldLine[40]` and `goldLine[12]`, and goldLine only defines 14/18/22/28/38/55.
 * Both resolved to `undefined`, so the selected chip rendered with no border
 * colour and no fill and the only thing marking the selection was the text
 * weight. `noImplicitAny: false` in tsconfig is why the compiler never said so —
 * an out-of-range index on a plain object is silently `any`.
 */
function FilterChip({
  label, a11y, selected, onPress,
}: { label: string; a11y: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={() => { void playSfx('select'); onPress(); }}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={a11y}
      hitSlop={8}
      style={{
        paddingVertical: S[2], paddingHorizontal: S[3], borderRadius: R[2],
        borderWidth: 1,
        borderColor: selected ? goldLine[38] : white(0.16),
        backgroundColor: selected ? alpha(C.gold, 0.12) : white(0.06),
      }}
    >
      <Text style={{
        color: selected ? C.gold : C.muted,
        fontSize: 12.5, fontWeight: selected ? '800' : '600',
      }}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * The seat list.
 *
 * Public tables come from the server (`{t:'lobby'}` → `{t:'tables'}`) with their
 * own names, stakes, seat counts and 2–6 player limits; nothing here invents a
 * table. Below them are the two ways to play someone specific: open a private
 * table with a fresh code, or type the code a friend sent.
 */
export function TableSelect({
  tables, seating, failed, seatedId, onJoin, onBack, feed, kind, onKind,
}: {
  tables: TableInfo[] | null;
  seating: boolean;
  failed: boolean;
  seatedId: string;
  onJoin: (id: string, withBot?: boolean) => void;
  onBack: () => void;
  feed: string[];
  /** Lifted, so the table header's Practice/Free/Bots tabs can pre-set it. */
  kind: KindFilter;
  onKind: (k: KindFilter) => void;
}) {
  const t = useType();
  const column = useColumn();
  const [code, setCode] = useState('');
  const [codeErr, setCodeErr] = useState('');
  const [seats, setSeats] = useState<SeatFilter>('all');
  const setKind = onKind;
  // Both filters compose; neither is allowed to be the only one that applies.
  const shown = useMemo(
    () => filterBySeats(filterByKind(tables ?? [], kind), seats),
    [tables, kind, seats],
  );
  /**
   * Join by a typed code — CHECKED AGAINST THE SERVER'S OWN LIST FIRST.
   *
   * The server does not refuse an id it does not know; it seats you at Practice
   * and says nothing. So a typo, a stale invite, or a code from one of the
   * other three games used to look like it worked, right up until you noticed
   * you were somewhere else on your own. The table list is already on screen —
   * matching against it costs nothing and turns a silent wrong seat into a
   * sentence. Matched on name as well as id, because the invite text and the
   * table card both say "Casual" while the id is lower-case.
   */
  const tryCode = useCallback(() => {
    const want = normalizeCode(code);
    if (!want) return;
    const hit = (tables ?? []).find(tb =>
      tb.id.toLowerCase() === want.toLowerCase() || tb.name.toLowerCase() === want.toLowerCase());
    if (!hit) {
      setCodeErr(`There is no rummy table called "${want}". Rummy has ${(tables ?? []).map(tb => tb.name).join(', ') || 'no open tables right now'}.`);
      return;
    }
    if (hit.players >= hit.maxPlayers) { setCodeErr(`${hit.name} is full (${hit.players}/${hit.maxPlayers}).`); return; }
    setCodeErr('');
    onJoin(hit.id);
  }, [code, tables, onJoin]);

  const [record, setRecord] = useState<{ gamesPlayed: number; totalWon: number } | null>(null);

  // The only record the server exposes. There is no per-match history endpoint,
  // so this is played-and-won rather than a list of games — saying so beats an
  // empty "History" screen that never fills up.
  useEffect(() => {
    let alive = true;
    fetch(`${GAMES_HTTP}/api/me`, { credentials: 'include' })
      .then(r => r.json())
      .then((d: any) => {
        if (!alive || !d?.ok) return;
        setRecord({ gamesPlayed: Number(d.gamesPlayed) || 0, totalWon: Number(d.totalWon) || 0 });
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  if (seating) {
    return (
      <TableBackground style={{ alignItems: 'center', justifyContent: 'center', padding: S[5], gap: S[3] }}>
        <ActivityIndicator color={C.gold} />
        <Text style={{ color: C.muted, fontSize: t.md }}>Taking your seat at {seatedId}…</Text>
      </TableBackground>
    );
  }

  if (failed) {
    return (
      <TableBackground style={{ alignItems: 'center', justifyContent: 'center', padding: S[5], gap: S[3] }}>
        <Text accessibilityElementsHidden importantForAccessibility="no" style={{ fontSize: 40 }}>🪑</Text>
        <Text style={{ color: C.text, fontSize: t.lg, fontWeight: '800' }}>No seat at “{seatedId}”</Text>
        <Text style={{ color: C.muted, fontSize: t.sm, textAlign: 'center', lineHeight: 19 }}>
          {/* NOT "the code may be wrong" any more. A typed code is now checked
              against the server's own table list before we ever try to sit
              down, so by the time we are waiting, the table is real. Naming a
              cause that cannot apply sends the player off to re-read an invite
              that was fine. What is left is the table, or the connection. */}
          The table did not answer. It may be full or finished, or the connection may have dropped.
        </Text>
        <Btn label="Back to tables" kind="gold" onPress={onBack} />
      </TableBackground>
    );
  }

  return (
    <TableBackground>
      {/* KeyboardSafe, not KeyboardAvoidingView (2026-09-18): the old
          `behavior={Platform.OS === 'ios' ? 'padding' : undefined}` resolved to
          undefined on Android, where RN's KeyboardAvoidingView falls through to
          a plain View — zero avoidance on the table-code field. keyboardOnly:
          the ScrollView below already carries the resting padding. */}
      <KeyboardSafe keyboardOnly style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={[column, { gap: S[3] }]}
          keyboardShouldPersistTaps="handled"
        >
          <Text accessibilityRole="header" style={{ color: C.text, fontSize: t.xl, fontWeight: '800' }}>Rummy</Text>
          <Text style={{ color: C.muted, fontSize: t.sm, lineHeight: 19 }}>
            Thirteen cards, two decks, points scoring. The table deals, times every turn and judges every declaration — your cards are never sent to another player’s device.
          </Text>

          {record && (
            <Text style={{ color: C.muted, fontSize: 12 }}>
              {`${record.gamesPlayed} deals played · ${record.totalWon} won`}
            </Text>
          )}

          <Text accessibilityRole="header" style={{ color: C.text, fontSize: t.md, fontWeight: '800', marginTop: S[2] }}>Open tables</Text>

          {/* HEAD-TO-HEAD OR A FULL TABLE IS A CHOICE, NOT A SEARCH.
              The server has always sent maxPlayers per table and the list has
              always rendered it as text — so wanting a 2-player game meant
              reading every card looking for one. */}
          {!!tables?.length && (
            <View style={{ gap: S[2] }}>
              {/* WHAT KIND OF GAME, then HOW MANY SEATS. Two rows rather than
                  one: they are independent questions and a single row of seven
                  chips reads as one list where picking two looks contradictory. */}
              <View style={{ flexDirection: 'row', gap: S[2], flexWrap: 'wrap' }}>
                {KIND_FILTERS.map(f => (
                  <FilterChip
                    key={f.mode}
                    label={f.label}
                    a11y={f.a11y}
                    selected={kind === f.mode}
                    onPress={() => setKind(f.mode)}
                  />
                ))}
              </View>
              <View style={{ flexDirection: 'row', gap: S[2], flexWrap: 'wrap' }}>
                {SEAT_FILTERS.map(f => (
                  <FilterChip
                    key={f.mode}
                    label={f.label}
                    a11y={f.a11y}
                    selected={seats === f.mode}
                    onPress={() => setSeats(f.mode)}
                  />
                ))}
              </View>
            </View>
          )}

          {tables == null ? (
            <Panel style={{ alignItems: 'center', gap: S[2] }}>
              <ActivityIndicator color={C.gold} />
              <Text style={{ color: C.muted, fontSize: t.sm }}>Asking the server which tables are open…</Text>
            </Panel>
          ) : tables.length === 0 ? (
            <Panel>
              <Text style={{ color: C.muted, fontSize: t.sm }}>No public tables are open right now. Start a private one below.</Text>
            </Panel>
          ) : shown.length === 0 ? (
            /* A FILTER THAT EMPTIES THE LIST MUST SAY SO. Rendering nothing here
               is indistinguishable from "the server has no tables", and the way
               out — clearing the filter — would be invisible. */
            <Panel style={{ gap: S[2] }}>
              <Text style={{ color: C.muted, fontSize: t.sm, lineHeight: 19 }}>
                {/* Name the filter that emptied the list. Saying "no
                    head-to-head tables" while the KIND filter is what hid them
                    sends the player to fix the wrong control. */}
                {kind !== 'all'
                  ? kind === 'bots'
                    ? 'No table that accepts a bot is open right now.'
                    : kind === 'practice'
                      ? 'No practice tables are open right now.'
                      : 'No coin tables are open right now.'
                  : seats === 'heads-up'
                    ? 'No head-to-head tables are open right now.'
                    : 'No multi-player tables are open right now.'}
              </Text>
              <Btn label="Show every table" compact onPress={() => { setKind('all'); setSeats('all'); }} />
            </Panel>
          ) : (
            shown.map(tb => (
              <TableCard
                key={tb.id}
                table={tb}
                // From the Bots tab, joining seats you AND asks for a bot — the
                // whole point of the tab, since the table set is the same.
                onJoin={() => onJoin(tb.id, kind === 'bots')}
              />
            ))
          )}

          {/* Every surface that shows a stake says what it is staking. A number
              beside the word "stakes" reads as money unless it says otherwise. */}
          <Text style={{ color: C.muted, fontSize: 11.5, lineHeight: 17 }}>
            Stakes are in play coins. They are not money, cannot be bought, and cannot be cashed out.
          </Text>

          {/* PLAYING A FRIEND, described as it actually works.
              ────────────────────────────────────────────────────────────────
              This used to offer "Open a private table", which minted a code
              like 2YR7QG and joined it. There is no such thing on this server
              and there never was. Probed live: rummy publishes exactly three
              GLOBAL tables — Practice, Casual, Pro — and a join carrying any
              other id is not refused, it is silently answered with a seat at
              Practice. Two friends who shared a minted code were each put at
              Practice on their own, both reading "1/6 seated", which is exactly
              the "private rummy does not connect" report. Extra fields on the
              join (private, password, maxPlayers, name) are ignored, and every
              invented verb — create, createTable, private, invite, host, room,
              new — is dropped without an answer. It is a server feature that
              does not exist, so the button was a promise the app could not keep
              and the table screen had to apologise for afterwards.
              The three tables seat six, so a friend CAN join you — you simply
              cannot keep strangers out. That is what this now says. */}
          <Panel style={{ gap: S[3], marginTop: S[2] }}>
            <Text style={{ color: C.text, fontSize: t.md, fontWeight: '800' }}>Play your friends</Text>
            <Text style={{ color: C.muted, fontSize: t.sm, lineHeight: 18 }}>
              Rummy tables are shared — take a seat at one above, then send your friends the
              invite from the table menu and they will land at the same table. Six seats each,
              first come first served.
            </Text>
            <Text style={{ color: C.muted, fontSize: 11.5, lineHeight: 17 }}>
              There are no private rummy tables on this server. Chess, Ludo and Tic-tac-toe do
              have them.
            </Text>
            <View style={{ flexDirection: 'row', gap: S[2] }}>
              <TextInput
                value={code}
                onChangeText={txt => { setCode(txt); setCodeErr(''); }}
                placeholder="Table name or code"
                placeholderTextColor={C.muted}
                autoCapitalize="characters"
                autoCorrect={false}
                accessibilityLabel="Table name or code from an invite"
                onSubmitEditing={() => tryCode()}
                style={{
                  flex: 1, color: C.text, fontSize: t.md, paddingHorizontal: S[3], paddingVertical: S[3],
                  borderRadius: R[2], borderWidth: 1,
                  borderColor: codeErr ? C.bad : goldLine[18], backgroundColor: C.panel2,
                }}
              />
              <Btn label="Join" onPress={() => tryCode()} disabled={!normalizeCode(code)} />
            </View>
            {!!codeErr && (
              <Text style={{ color: C.bad, fontSize: t.sm, lineHeight: 18 }}>{codeErr}</Text>
            )}
          </Panel>
        </ScrollView>
      </KeyboardSafe>
      <Toasts events={feed} />
    </TableBackground>
  );
}

function TableCard({ table, onJoin }: { table: TableInfo; onJoin: () => void }) {
  const t = useType();
  const full = table.players >= table.maxPlayers;
  return (
    <Pressable
      onPress={full ? undefined : onJoin}
      disabled={full}
      accessibilityRole="button"
      accessibilityLabel={`${table.name}, ${table.stakes}, ${table.players} of ${table.maxPlayers} seated${full ? ', full' : ''}`}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: S[3], padding: S[4],
        borderRadius: R[3], borderWidth: 1, borderColor: white(0.16),
        // The table list sits on the ROOM, so this is light glass — the same
        // card the games hub uses. Only the pills that live on the felt go dark.
        backgroundColor: white(0.075), opacity: full ? 0.55 : 1,
        boxShadow: `inset 0 1px 0 ${white(0.18)}`,
      }}
    >
      <View style={{ flex: 1, gap: 3 }}>
        <Text numberOfLines={1} style={{ color: C.text, fontSize: t.md, fontWeight: '800' }}>{table.name}</Text>
        <Text style={{ color: C.muted, fontSize: T.sm }}>{table.stakes}</Text>
        {/* NAME THE VARIANT, even though there is only one.
            Rummy has three well-known formats (Points, Pool 101/201, Deals),
            and this server plays only Points — the wire protocol carries no
            pool score, no elimination and no deal count. A player arriving from
            another rummy app assumes a format unless told, and finding out from
            the scoreboard reads as the app getting the rules wrong. */}
        <Text style={{ color: C.muted, fontSize: 12 }}>
          {`${VARIANT} · ${table.players}/${table.maxPlayers} seated · ${table.status}`}
        </Text>
      </View>
      <Btn label={full ? 'Full' : 'Join'} kind={full ? 'secondary' : 'gold'} compact disabled={full} onPress={onJoin} />
    </Pressable>
  );
}
