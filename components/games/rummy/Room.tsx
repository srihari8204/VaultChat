// components/games/rummy/Room.tsx — the waiting room: who is seated, the invite,
// Pool & Deals, voice, and the host's deal controls.
// Split out of components/games/Rummy.tsx; behaviour unchanged.

import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { TableBackground, Panel, Btn, PlayerRow, useType } from '../ui';
import { Toasts, VoiceSheet } from '../feedback';
import type { TableVoice } from '../../../lib/games/useTableVoice';
import type { RummyMatch } from '../../../lib/games/useRummyMatch';
import type { GamesMessage } from '../../../lib/gamesSocket';
import { VARIANTS, variantLabel, standings, progressLabel } from '../../../lib/games/match';
import { allowsBots } from '../../../lib/games/rummyTable';
import { openInvite, tableLink } from '../../../lib/games/invite';
import { playSfx } from '../../../lib/games/sfx';
import { C, S, R } from '../../../lib/games/theme';
import { VARIANT, useColumn } from './shared';

/**
 * How long a table with enough players waits before the host's client deals.
 *
 * A minute is long enough for a third or fourth person to sit down and short
 * enough that two people are not left staring at a lobby — which is what
 * happened when dealing needed a tap that nobody made.
 */
const AUTO_DEAL_SECS = 60;

/**
 * Pool and Deals: the score across deals.
 *
 * The games server plays one deal and knows nothing about a match around it, so
 * this panel is crazzychat's half — the running scoreboard, and the way to start
 * a match in the first place. It renders NOTHING at all when there is no match
 * and the table cannot host one, which is also exactly what happens while the
 * backend for it is undeployed.
 *
 * PRACTICE TABLES ONLY, and the reason is money, not preference: a staked table
 * settles coins on EVERY deal, but a pool's stake moves once at the end — so a
 * pool over a staked table charges a player per deal by the games server and
 * again per match. `allowsBots` already tests the same `pointValue === 0`
 * condition for a closely related reason.
 */
function MatchPanel({
  rmatch, table, you, host,
}: {
  rmatch: RummyMatch;
  table?: { name?: string; stakes?: string; pointValue?: number };
  you: string;
  host: boolean;
}) {
  const t = useType();
  const [picking, setPicking] = useState(false);
  const m = rmatch.match;
  const practice = allowsBots(table);

  // Nothing to show and nothing to offer.
  if (!m && (!practice || !host)) return null;

  if (!m) {
    return (
      <Panel style={{ gap: S[2] }}>
        <Text style={{ color: C.text, fontSize: t.md, fontWeight: '800' }}>Pool & Deals</Text>
        {picking ? (
          <>
            {VARIANTS.map(v => (
              <Btn
                key={v.id}
                label={v.label}
                onPress={() => { void playSfx('select'); setPicking(false); rmatch.open(v.id, practice); }}
              />
            ))}
            <Text style={{ color: C.muted, fontSize: 11.5, lineHeight: 17 }}>
              {VARIANTS.map(v => `${v.label}: ${v.blurb}`).join('\n')}
            </Text>
            <Btn label="Not now" compact onPress={() => setPicking(false)} />
          </>
        ) : (
          <>
            <Text style={{ color: C.muted, fontSize: t.sm, lineHeight: 19 }}>
              Play several deals as one match — knocked out at 101 or 201, or the
              best of 2 or 6 deals.
            </Text>
            <Btn label="Start a match" icon="bot" kind="gold" onPress={() => setPicking(true)} />
          </>
        )}
      </Panel>
    );
  }

  const rows = standings(m);
  const done = m.status === 'finished';
  const leader = rows[0];

  return (
    <Panel style={{ gap: S[2] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: S[2] }}>
        <Text style={{ color: C.text, fontSize: t.md, fontWeight: '800', flex: 1 }}>
          {variantLabel(m.variant)}
        </Text>
        <Text style={{ color: C.muted, fontSize: 12 }}>{progressLabel(m)}</Text>
      </View>

      {rows.map(r => {
        const out = r.status === 'out';
        // A pool shows the total against the limit it is racing; a deals match
        // shows chips, which can be negative. Showing one as the other is how a
        // scoreboard reads as nonsense.
        const value = m.poolLimit > 0 ? `${r.points} / ${m.poolLimit}` : `${r.chips >= 0 ? '+' : ''}${r.chips}`;
        return (
          <View
            key={r.vaultId}
            accessible
            accessibilityLabel={`${r.name}, ${value}${out ? ', out' : ''}`}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: S[2],
              paddingVertical: S[2], paddingHorizontal: S[3], borderRadius: R[2],
              backgroundColor: r.vaultId === you ? C.panel2 : 'transparent',
              opacity: out ? 0.5 : 1,
            }}
          >
            <Text style={{ color: C.text, fontSize: t.sm, fontWeight: '700', flex: 1 }} numberOfLines={1}>
              {r.name}{r.vaultId === you ? ' (you)' : ''}
            </Text>
            {out && (
              <Text style={{ color: C.muted, fontSize: 11, fontWeight: '800' }}>OUT</Text>
            )}
            <Text style={{ color: out ? C.muted : C.gold, fontSize: t.sm, fontWeight: '800' }}>
              {value}
            </Text>
          </View>
        );
      })}

      {done ? (
        <Text style={{ color: C.gold, fontSize: t.sm, fontWeight: '800' }}>
          {leader ? `${leader.name} wins the match.` : 'Match over.'}
        </Text>
      ) : (
        <Text style={{ color: C.muted, fontSize: 11.5, lineHeight: 17 }}>
          {m.poolLimit > 0
            ? `Deal again to play the next round. Out at ${m.poolLimit}.`
            : 'Deal again to play the next round.'}
        </Text>
      )}
    </Panel>
  );
}

/* ── the waiting room ───────────────────────────────────────────────── */

/**
 * The lobby: who is here, and the controls only the host has.
 *
 * Bots are offered ONLY at a practice table. A staked table seating a bot would
 * be putting the house in the pot, which is why the server refuses it — and an
 * offer the server refuses reads to a player as a broken button.
 */
export function Room({
  lobby, table, you, code, substituted, voice, voiceOpen, setVoiceOpen, onSend, onLeave, feed, notify, rmatch,
}: {
  rmatch: RummyMatch;
  lobby: { status: string; hostId?: string; members: { vaultId: string; name: string; isBot?: boolean }[]; maxPlayers?: number };
  table?: { name?: string; stakes?: string; pointValue?: number };
  you: string;
  code: string;
  /** The server put us on one of ITS tables instead of the one we asked for. */
  substituted: boolean;
  voice: TableVoice;
  voiceOpen: boolean;
  setVoiceOpen: (v: boolean) => void;
  onSend: (m: GamesMessage) => void;
  onLeave: () => void;
  feed: string[];
  notify: (m: string) => void;
}) {
  const t = useType();
  const column = useColumn();
  const members = lobby.members ?? [];
  const host = lobby.hostId === you;
  const max = lobby.maxPlayers ?? 6;
  const full = members.length >= max;
  const empties = Math.max(0, max - members.length);
  const link = tableLink('rummy', code);

  /**
   * DEAL ON A FULL-ENOUGH TABLE, NOT A FULL ONE.
   *
   * A rummy table only ever dealt when the HOST tapped Deal. Two people could
   * sit at the same table indefinitely — which is exactly what "online rummy
   * does not work" looked like: both seated, neither able to start, because
   * seat one belonged to someone who had wandered off. Six players were never
   * required by the game; they were required by the button.
   *
   * So once there are two, the host's client deals itself after a minute, with
   * the count visible so nobody is surprised by it. Deal still works instantly
   * for anyone who does not want to wait, and the timer stands down the moment
   * the table drops back below two.
   */
  const canDeal = members.length >= 2;
  const [dealIn, setDealIn] = useState<number | null>(null);
  useEffect(() => {
    if (!host || !canDeal) { setDealIn(null); return; }
    setDealIn(AUTO_DEAL_SECS);
    const id = setInterval(() => {
      // TICK, AND NOTHING ELSE. The `start` used to be sent from inside this
      // updater, which is two bugs in one line: React may invoke an updater
      // twice for the same tick (it does in StrictMode), so a dev build dealt
      // the table twice; and a state updater that talks to a socket runs
      // wherever React decides to run it, which is not somewhere a network send
      // belongs. The updater now only counts, and the effect below reacts to it
      // reaching zero.
      setDealIn(prev => (prev == null ? null : prev - 1));
    }, 1000);
    return () => clearInterval(id);
    // members.length is DELIBERATELY not a dependency. It was, and it meant the
    // countdown restarted at sixty every time anyone joined or left — a table
    // that people drift in and out of never reached zero and never dealt, which
    // is the failure this timer exists to prevent. `canDeal` is the part that
    // actually matters (did we cross two players), and it is here.
  }, [host, canDeal]);

  // Zero is the deal. Separate from the tick so the send happens in an effect,
  // once, after the state that triggered it has actually committed.
  useEffect(() => {
    if (dealIn !== 0) return;
    setDealIn(null);
    onSend({ t: 'start' });
  }, [dealIn, onSend]);

  /**
   * ONE LOBBY ACTION AT A TIME — the same lock the action bar already puts on a
   * turn (`act`/`pending` on the board), which these two buttons never had.
   *
   * `start` and `addbot` are both answered by a new snapshot rather than an ack,
   * so a double-tap sent two frames and the server replied to the second with an
   * error the player did nothing to earn: two bots seated from one tap, or
   * "already started". Cleared by the snapshot that arrives — and by a timeout,
   * so a dropped frame cannot wedge the buttons the way it could wedge the bar.
   */
  const [busy, setBusy] = useState(false);
  useEffect(() => { setBusy(false); }, [members.length, lobby.status]);
  useEffect(() => {
    if (!busy) return;
    const id = setTimeout(() => setBusy(false), 6000);
    return () => clearTimeout(id);
  }, [busy]);
  const addBot = useCallback(() => { setBusy(true); onSend({ t: 'addbot' }); }, [onSend]);
  const dealNow = useCallback(() => { setBusy(true); setDealIn(null); onSend({ t: 'start' }); }, [onSend]);

  const copy = async () => {
    await Clipboard.setStringAsync(code).catch(() => {});
    notify('Table code copied.');
  };

  return (
    <TableBackground>
      <ScrollView contentContainerStyle={[column, { gap: S[3] }]}>
        <Text accessibilityRole="header" numberOfLines={1} style={{ color: C.text, fontSize: t.xl, fontWeight: '800' }}>{table?.name || 'Rummy table'}</Text>
        <Text style={{ color: C.muted, fontSize: t.sm }}>
          {[VARIANT, table?.stakes, `${members.length}/${max} seated`].filter(Boolean).join(' · ')}
        </Text>

        <Panel style={{ gap: S[2] }}>
          {members.map(mem => (
            <PlayerRow
              key={mem.vaultId}
              name={mem.name}
              tag={mem.vaultId === you ? 'you' : mem.isBot ? 'bot' : mem.vaultId === lobby.hostId ? 'host' : undefined}
            />
          ))}
          {Array.from({ length: empties }, (_, i) => (
            <Text key={`e${i}`} style={{ color: C.muted, fontSize: t.sm, opacity: 0.6, paddingVertical: S[2] }}>
              Empty seat
            </Text>
          ))}
          {full && <Text style={{ color: C.gold, fontSize: 12, fontWeight: '700' }}>Table full</Text>}
        </Panel>

        {/* A CODE NOBODY CAN JOIN IS WORSE THAN NO CODE.
            The server answers a join for a table it does not know by seating
            you at one of its own and saying nothing, so two people who share a
            code both end up alone on "Practice" — proven on two phones. When we
            can see that happened, say it, and do not offer a code to share. */}
        {substituted ? (
          <Panel style={{ gap: S[2] }}>
            <Text style={{ color: C.gold, fontSize: t.md, fontWeight: '800' }}>This is a public table</Text>
            <Text style={{ color: C.muted, fontSize: t.sm, lineHeight: 19 }}>
              {`The table you asked for is not available on this server, so you are at ${table?.name || 'a public table'}. Anyone can join it from the table list — there is no private code to share for rummy.`}
            </Text>
            <Btn label="Back to tables" onPress={onLeave} />
          </Panel>
        ) : !!code && (
          <Panel style={{ gap: S[2] }}>
            <Text style={{ color: C.text, fontSize: t.md, fontWeight: '800' }}>Invite</Text>
            <Text selectable style={{ color: C.gold, fontSize: t.xl, fontWeight: '800', letterSpacing: 2 }}>{code}</Text>
            <View style={{ flexDirection: 'row', gap: S[2] }}>
              <Btn label="Copy code" icon="copy" compact onPress={() => { void copy(); }} />
              <Btn label="Share link" icon="link" compact onPress={() => { void openInvite('rummy', code); }} disabled={!link} />
            </View>
          </Panel>
        )}

        <MatchPanel rmatch={rmatch} table={table} you={you} host={host} />

        <VoiceRow voice={voice} onExpand={() => setVoiceOpen(true)} />

        {host ? (
          <>
            {allowsBots(table) && (
              <Btn label="Add a bot" icon="bot" onPress={addBot} disabled={full || busy} />
            )}
            <Btn
              label={dealIn != null ? `Deal now — starting in ${dealIn}s` : `Deal (${members.length})`}
              kind="gold"
              onPress={dealNow}
              disabled={!canDeal || busy}
            />
          </>
        ) : (
          <Text style={{ color: C.muted, fontSize: t.sm }}>Waiting for the host to deal…</Text>
        )}

        <Btn label="Leave table" onPress={onLeave} />
      </ScrollView>
      <Toasts events={feed} />
      <VoiceSheet
        visible={voiceOpen}
        voice={voice}
        nameOf={id => members.find(mem => mem.vaultId === id)?.name ?? id}
        onClose={() => setVoiceOpen(false)}
      />
    </TableBackground>
  );
}

/** The lobby's roomier version of the same thing. */
function VoiceRow({ voice, onExpand }: { voice: TableVoice; onExpand: () => void }) {
  const t = useType();
  if (voice.phase === 'unavailable') {
    return <Text style={{ color: C.muted, fontSize: 12 }}>{voice.error ?? 'Voice is not available at this table.'}</Text>;
  }
  if (voice.phase === 'live' || voice.phase === 'waiting') {
    return (
      <Panel style={{ flexDirection: 'row', alignItems: 'center', gap: S[2] }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: voice.phase === 'live' ? C.good : C.gold }} />
        <Text style={{ flex: 1, color: C.text, fontSize: t.sm, fontWeight: '700' }}>
          {voice.phase === 'live' ? `Voice on · ${voice.participants.length}` : 'In voice — waiting for others'}
        </Text>
        <Btn label="Open" compact onPress={onExpand} />
      </Panel>
    );
  }
  return <Btn label="Talk at the table" icon="mic" onPress={voice.join} />;
}
