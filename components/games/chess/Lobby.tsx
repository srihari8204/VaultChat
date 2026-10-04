// components/games/chess/Lobby.tsx — the chess lobby and the connecting screen.
// Split out of components/games/Chess.tsx; behaviour unchanged apart from the
// bot-strength choice now announcing which one is selected.

import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { TableBackground, Btn, Panel, PlayerRow, useType } from '../ui';
import { RulesSheet, useFirstTimeRules } from '../rules';
import { Toasts, VoiceBar } from '../feedback';
import type { GameState } from '../../../lib/games/useGameSocket';
import type { TableVoice } from '../../../lib/games/useTableVoice';
import { C, S } from '../../../lib/games/theme';
import { CR, CR_AMBIENT, CR_BOKEH, CR_VIGNETTE } from '../../../lib/games/chessRoom';
import { useAddBot, ADD_BOT_STALLED } from '../../../lib/games/useAddBot';
import { startBlockedReason } from '../../../lib/games/startHint';
import { openInvite } from '../../../lib/games/invite';

export function Lobby({
  state, events, onAddBot, onStart, botLevel, onBotLevel, voice, code,
}: {
  state: GameState; events: string[]; onAddBot: () => void; onStart: () => void;
  botLevel: number; onBotLevel: (n: number) => void; voice: TableVoice; code: string;
}) {
  const t = useType();
  const members = state.lobby?.members ?? [];
  const host = state.lobby?.hostId === state.you;
  // Offered once, in the lobby — before a move is ever required.
  const rules = useFirstTimeRules('chess');
  // The server can accept `addbot` and never seat one. The payload stays the
  // caller's (chess sends a level); this only watches whether a seat appeared.
  const bot = useAddBot(() => onAddBot(), members.length);
  return (
    <TableBackground bg={CR.bg} ambient={CR_AMBIENT} bokeh={CR_BOKEH} vignette={CR_VIGNETTE}>
      <ScrollView contentContainerStyle={{ padding: S[4], gap: S[3] }}>
        <Text accessibilityRole="header" style={{ color: CR.gold2, fontSize: t.xl, fontWeight: '800', letterSpacing: 0.4 }}>Chess</Text>
        <Text style={{ color: CR.muted, fontSize: t.sm, lineHeight: 19 }}>
          Every move is validated by the table, and your legal moves arrive from it — so the board you see is exactly the board your opponent sees.
        </Text>
        <Panel style={{ gap: S[2] }}>
          {members.map(m => (
            <PlayerRow
              key={m.vaultId}
              name={m.name}
              tag={m.vaultId === state.you ? 'you' : m.isBot ? 'bot' : undefined}
              subtitle={typeof m.wins === 'number' ? `${m.wins} wins` : undefined}
            />
          ))}
          {members.length < 2 && (
            <Text style={{ color: C.muted, fontSize: t.sm }}>Two players minimum — add a bot to start now.</Text>
          )}
        </Panel>
        <View style={{ flexDirection: 'row', gap: S[2], alignItems: 'center' }}>
          <Text style={{ flex: 1, color: C.muted, fontSize: t.sm }}>Bot strength</Text>
          {[1, 2, 3].map(n => (
            <Btn
              key={n}
              label={['Easy', 'Even', 'Hard'][n - 1]}
              compact
              kind={botLevel === n ? 'gold' : 'secondary'}
              selected={botLevel === n}
              accessibilityLabel={`Bot strength ${['easy', 'even', 'hard'][n - 1]}`}
              onPress={() => onBotLevel(n)}
            />
          ))}
        </View>
        {!!code && (
          <Text style={{ color: C.muted, fontSize: t.sm }} selectable>
            Room code: <Text style={{ color: CR.gold2, fontWeight: '800' }}>{code}</Text>
          </Text>
        )}
        {/* Voice while you WAIT, not only once the game is running. A private
            room is two people arriving at the same table; that is the moment
            they want to talk. */}
        <VoiceBar
          phase={voice.phase}
          error={voice.error}
          canSpeak={voice.canSpeak}
          muted={voice.muted}
          participants={voice.participants}
          onJoin={voice.join}
          onLeave={voice.leave}
          onToggleMute={voice.toggleMute}
        />
        <Btn label="How to play" icon="rules" onPress={rules.open} />
        {/* Inviting belongs HERE, not only on the board. Chess had its invite
            behind the first move — you could only ask someone to join a game
            that had already started, which is the wrong moment and the reason
            an empty chess lobby had no way out except a bot. */}
        <Btn label="Invite a friend" icon="link" onPress={() => { void openInvite('chess', code); }} disabled={!code} />
        <Btn label="Add a bot" icon="bot" onPress={() => bot.addBot()} />
        {/* Seen on a device: the tap lands, no error comes back, and no bot
            ever arrives — so "Start game" stays disabled forever and the
            button is simply dead. There is no ack for `addbot`, so absence is
            the only evidence we have; saying nothing is the real bug. */}
        {bot.stalled && (
          <Text style={{ color: CR.bad, fontSize: t.sm, lineHeight: 18 }}>{ADD_BOT_STALLED}</Text>
        )}
        <Btn label="Start game" kind="gold" onPress={onStart} disabled={!host || members.length < 2} />
        {!!startBlockedReason(host, members.length) && (
          <Text style={{ color: CR.muted, fontSize: t.sm, lineHeight: 18, textAlign: 'center' }}>{startBlockedReason(host, members.length)}</Text>
        )}
      </ScrollView>
      <Toasts events={events} />
      <RulesSheet game="chess" visible={rules.visible} onClose={rules.close} />
    </TableBackground>
  );
}

export function Connecting({ phase, error, onRetry }: { phase: string; error: string | null; onRetry: () => void }) {
  const t = useType();
  return (
    <TableBackground bg={CR.bg} ambient={CR_AMBIENT} bokeh={CR_BOKEH} vignette={CR_VIGNETTE} style={{ alignItems: 'center', justifyContent: 'center', padding: S[5], gap: S[3] }}>
      <Text accessibilityElementsHidden importantForAccessibility="no" style={{ fontSize: 46 }}>♚</Text>
      <Text style={{ color: C.text, fontSize: t.lg, fontWeight: '800' }}>
        {error ? 'Could not reach the table' : 'Connecting…'}
      </Text>
      {error ? <Text style={{ color: C.muted, fontSize: t.sm, textAlign: 'center' }}>{error}</Text> : null}
      {error ? <Btn label="Try again" kind="gold" onPress={onRetry} /> : null}
    </TableBackground>
  );
}
