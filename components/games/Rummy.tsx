/**
 * Rummy — native, server-refereed.
 *
 * The server holds the deck, deals, and validates every meld. It sends the
 * public table in `game` and THIS player's cards in a separate top-level
 * `hand` — the other players are only ever a `handCount`, which is what keeps
 * the game honest: nobody's cards are ever on another device to be read out of
 * a debugger. See docs/GAMES_PROTOCOL.md.
 *
 * So there is no meld validation here, no scoring, no wild-card substitution
 * logic. `declare` sends the player's grouping and the SERVER decides whether
 * it is a valid hand. A client-side "is this a valid sequence" check would be
 * a second rulebook, and the disagreement would land on the player as a
 * declaration that looked fine and lost them the round.
 *
 * Card: { id, suit: 'S'|'H'|'D'|'C'|'JOKER', rank } — id is unique per physical
 * card because two decks are in play and duplicates genuinely exist.
 *
 * Visuals ported from games-web/rummy.css: a green baize oval with a gold rim,
 * seats around it, and real card faces with corner indices.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions, type ViewStyle } from 'react-native';
import Svg, { Defs, RadialGradient, Stop, Rect, Ellipse, Line } from 'react-native-svg';
import Animated, {
  useSharedValue, useAnimatedStyle, withSpring, withTiming, withRepeat, withSequence,
  Easing, cancelAnimation,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useGameSocket, type AutoStart } from '../../lib/games/useGameSocket';
import * as ScreenOrientation from 'expo-screen-orientation';
import { TableBackground, Panel, Btn, Banner, PlayerRow, Chip, useType, useLandscape } from './ui';
import { C, S, R, D3, mix, goldLine } from '../../lib/games/theme';
import { playSfx, preloadSfx, soundEnabled, setSoundEnabled } from '../../lib/games/sfx';
import { Toasts, Confetti, Sheet, SettingRow, VoiceBar } from './feedback';
import { useTableVoice } from '../../lib/games/useTableVoice';
import { inviteToTable, shareResult } from '../../lib/games/invite';
import { reconcile, groupUp, ungroup, sortLoose, sameGroups, type Groups } from '../../lib/games/handGroups';

type Card = { id: string; suit: string; rank: string };

const SUIT_GLYPH: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣', JOKER: '★' };
const SUIT_NAME: Record<string, string> = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs', JOKER: 'joker' };
const RED = new Set(['H', 'D']);

/** Baize, from rummy.css --felt / --felt-2 / --felt-3. */
const FELT = ['#1c9257', '#0a4c2c', '#073a20'];
const CARD_FACE = '#fffdf6';
const CARD_EDGE = '#caa44a';
const CARD_RED = '#d8213f';
const CARD_INK = '#16181f';
const JOKER_PURPLE = '#7c3aed';

function label(c: Card): string {
  if (c.suit === 'JOKER' || !c.rank) return '★';
  return `${c.rank}${SUIT_GLYPH[c.suit] ?? ''}`;
}

function spoken(c: Card): string {
  if (c.suit === 'JOKER' || !c.rank) return 'joker';
  return `${c.rank} of ${SUIT_NAME[c.suit] ?? c.suit}`;
}

export default function Rummy({ tableId = '', auto, autoBot }: { tableId?: string } & AutoStart) {
  const { phase, error, state, events, send, retry } = useGameSocket('rummy', tableId, { auto, autoBot });
  const t = useType();
  const { width } = useWindowDimensions();

  // Selection is local: which cards the player has picked for a discard or a
  // declaration. Nothing about it is game truth, so it never leaves this file
  // except as an explicit intent.
  const [picked, setPicked] = useState<string[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [confirmDeclare, setConfirmDeclare] = useState(false);
  const [sound, setSound] = useState(soundEnabled());
  const voice = useTableVoice('rummy', tableId);

  const L = state.lobby;
  const G = state.game;
  const hand: Card[] = Array.isArray(state.raw?.hand) ? state.raw.hand : [];
  const mine = G?.turnPlayerId === state.you;

  const land = useLandscape();

  /**
   * Rummy is played sideways.
   *
   * Thirteen cards plus the piles do not fit across a portrait phone at a
   * legible card size — the real rummy apps are all landscape for this reason.
   * The app is portrait-locked, so this screen unlocks landscape while it is
   * mounted and puts it back on the way out, the same way the video player
   * does. Restoring on unmount is the part that matters: leaving the whole app
   * unlocked would let every other screen rotate.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);
      } catch {}
    })();
    return () => {
      cancelled = true;
      void (async () => {
        try { await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP); } catch {}
      })();
    };
  }, []);

  // In landscape the felt takes the left half and the hand the right, so
  // thirteen cards stay legible instead of being squeezed to fit a phone width.
  const feltW = land
    ? Math.min(width * 0.52 - S[4], 520)
    : Math.min(width - S[4] * 2, 460);

  useEffect(() => { void preloadSfx(['deal', 'discard', 'select', 'tick', 'win', 'lose']); }, []);

  // The player's arrangement. Cosmetic: the server judges the declaration.
  // It is kept in step with the authoritative hand on every snapshot, because
  // a group holding a card they no longer own produces a rejection whose cause
  // is invisible on screen.
  const [groups, setGroups] = useState<Groups>([[]]);
  const byId = React.useMemo(() => new Map(hand.map(c => [c.id, c])), [hand]);

  useEffect(() => {
    setGroups(prev => {
      const next = reconcile(prev, hand.map(c => c.id));
      return sameGroups(prev, next) ? prev : next;
    });
  }, [hand]);

  // Persist the arrangement so a reconnect does not dump thirteen loose cards
  // back on someone mid-hand. Only on real change: the snapshot arrives
  // constantly and resending would be chatter.
  const sentGroups = useRef<Groups | null>(null);
  useEffect(() => {
    if (!G || groups.flat().length === 0) return;
    if (sentGroups.current && sameGroups(sentGroups.current, groups)) return;
    sentGroups.current = groups;
    send({ t: 'arrange', groups });
  }, [groups, G, send]);

  // A card arriving in the hand is a draw; one leaving is a discard.
  const prevHand = useRef<number | null>(null);
  useEffect(() => {
    const n = hand.length;
    if (prevHand.current != null && n !== prevHand.current) {
      playSfx(n > prevHand.current ? 'deal' : 'discard');
    }
    prevHand.current = n;
  }, [hand.length]);

  const ended = useRef(false);
  useEffect(() => {
    if (G?.phase !== 'finished') { ended.current = false; return; }
    if (ended.current) return;
    ended.current = true;
    playSfx(G.winnerId === state.you ? 'win' : 'lose');
  }, [G?.phase, G?.winnerId, state.you]);

  if (error && phase !== 'connected') {
    return (
      <Center>
        <Text style={{ fontSize: 46 }}>🂡</Text>
        <Text style={{ color: C.text, fontSize: t.lg, fontWeight: '800' }}>Can’t reach the table</Text>
        <Text style={{ color: C.muted, fontSize: t.sm, textAlign: 'center' }}>{error}</Text>
        <Btn label="Try again" kind="gold" onPress={retry} />
      </Center>
    );
  }

  if (phase !== 'connected' || !L) {
    return (
      <Center>
        <Text style={{ fontSize: 46 }}>🂡</Text>
        <Text style={{ color: C.muted, fontSize: t.md }}>
          {phase === 'minting' ? 'Taking your seat…' : 'Joining the table…'}
        </Text>
      </Center>
    );
  }

  const finished = G?.phase === 'finished';

  if (!G || (L.status === 'lobby' && !finished)) {
    const members = L.members ?? [];
    const host = L.hostId === state.you;
    return (
      <TableBackground>
        <ScrollView contentContainerStyle={{ padding: S[4], gap: S[3] }}>
          <Text style={{ color: C.text, fontSize: t.xl, fontWeight: '800' }}>Rummy</Text>
          <Text style={{ color: C.muted, fontSize: t.sm, lineHeight: 19 }}>
            Thirteen cards, two decks. The table deals and judges every declaration — your cards are never sent to another player’s device.
          </Text>
          <Panel style={{ gap: S[2] }}>
            {members.map(m => (
              <PlayerRow
                key={m.vaultId}
                name={m.name}
                tag={m.vaultId === state.you ? 'you' : m.isBot ? 'bot' : undefined}
              />
            ))}
            <Text style={{ color: C.muted, fontSize: t.sm }}>{members.length} seated</Text>
          </Panel>
          <Btn label="Add a bot" icon="🤖" onPress={() => send({ t: 'addbot' })} />
          <Btn label="Invite a friend" icon="🔗" onPress={() => { void inviteToTable('rummy', tableId); }} disabled={!tableId} />
          <Btn label="Deal" kind="gold" onPress={() => send({ t: 'start' })} disabled={!host || members.length < 2} />
        </ScrollView>
        <Toasts events={events} />
      </TableBackground>
    );
  }

  const players: any[] = Array.isArray(G.players) ? G.players : [];
  const others = players.filter(p => (p.id ?? p.vaultId) !== state.you);
  const openTop: Card | null = G.openTop ?? null;
  const closedCount: number = typeof G.closedCount === 'number' ? G.closedCount : 0;
  const wild: Card | null = G.wildJokerCard ?? null;

  const toggle = (id: string) => {
    Haptics.selectionAsync().catch(() => {});
    playSfx('select');
    setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]));
  };

  const draw = (source: 'open' | 'closed') => {
    if (!mine) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    send({ t: 'draw', source });
  };

  const discard = () => {
    if (picked.length !== 1) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    send({ t: 'discard', cardId: picked[0] });
    setPicked([]);
  };

  /**
   * Declaring ends the round whether or not the hand stands up, and an invalid
   * declaration is scored against the player. The web asks first; Declare sits
   * next to Discard, and a mis-tap would otherwise cost a whole round.
   */
  const declare = () => {
    if (picked.length !== 1) return;
    // The server judges the hand. `groups` carries the player's own
    // arrangement, minus the card they are discarding to declare.
    const laid = groups.map(g => g.filter(id => id !== picked[0])).filter(g => g.length > 0);
    send({ t: 'declare', discardId: picked[0], groups: laid });
    setPicked([]);
  };

  return (
    <TableBackground>
      <ScrollView
        contentContainerStyle={{
          padding: S[4], gap: S[3], paddingBottom: S[6],
          alignItems: land ? 'flex-start' : 'center',
          flexDirection: land ? 'row' : 'column',
        }}
      >
        {/* LEFT in landscape: the table. RIGHT: the player's own hand. Split
            this way because thirteen cards need the width more than the felt
            does, and the piles stay reachable with either thumb. */}
        <View style={{ width: feltW, gap: S[3] }}>
          <Felt width={feltW}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: S[3], paddingTop: S[2] }}>
              {others.map(p => (
                <Seat
                  key={p.id ?? p.vaultId}
                  name={p.name}
                  count={p.handCount ?? 0}
                  bot={!!p.isBot}
                  turn={G.turnPlayerId === (p.id ?? p.vaultId)}
                  out={!!p.dropped}
                />
              ))}
            </View>

            <View style={{ flexDirection: 'row', gap: S[5], justifyContent: 'center', alignItems: 'flex-start', paddingVertical: S[3] }}>
              <Pile
                label={`${closedCount} left`}
                live={mine}
                onPress={() => draw('closed')}
                back
              />
              <Pile
                label="Open"
                live={mine && !!openTop}
                onPress={() => draw('open')}
                card={openTop}
              />
              {wild ? (
                <View style={{ alignItems: 'center', gap: 5 }}>
                  <CardFace card={wild} w={44} wild />
                  <Text style={{ color: '#e7f3ea', fontSize: 11, fontWeight: '700' }}>Wild</Text>
                </View>
              ) : null}
            </View>
          </Felt>

        </View>

        <View style={{ flex: land ? 1 : undefined, alignItems: 'center', gap: S[3] }}>
        {finished ? (
          <View style={{ width: feltW }}>
            <Banner
              text={G.winnerId === state.you ? 'You win!' : `${players.find(p => (p.id ?? p.vaultId) === G.winnerId)?.name ?? 'Someone'} wins`}
              tone={G.winnerId === state.you ? 'win' : 'lose'}
            />
          </View>
        ) : (
          <Text style={{ color: mine ? C.gold : C.muted, fontSize: t.md, fontWeight: '700' }}>
            {mine ? 'Your turn — draw, then discard one' : `${players.find(p => (p.id ?? p.vaultId) === G.turnPlayerId)?.name ?? 'Someone'} is playing`}
          </Text>
        )}

        {/* your hand, in the groups the player arranged */}
        <View style={{ width: feltW, gap: S[2] }}>
          {groups.map((g, gi) => {
            const loose = gi === groups.length - 1;
            if (g.length === 0 && !loose) return null;
            return (
              <View
                key={gi}
                accessibilityLabel={loose ? `Ungrouped, ${g.length} cards` : `Group ${gi + 1}, ${g.length} cards`}
                style={{
                  borderRadius: R[2],
                  borderWidth: loose ? 0 : 1,
                  borderColor: goldLine[22],
                  backgroundColor: loose ? 'transparent' : 'rgba(255,255,255,0.04)',
                  paddingVertical: loose ? 0 : S[2],
                  paddingHorizontal: loose ? 0 : S[2],
                }}
              >
                {!loose && (
                  <Text style={{ color: C.muted, fontSize: 11, fontWeight: '800', marginBottom: 2 }}>
                    {`GROUP ${gi + 1}`}
                  </Text>
                )}
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: 6, paddingVertical: S[3], paddingHorizontal: 2 }}
                >
                  {g.map(id => {
                    const c = byId.get(id);
                    return c ? (
                      <HandCard key={id} card={c} selected={picked.includes(id)} onPress={() => toggle(id)} />
                    ) : null;
                  })}
                  {g.length === 0 && (
                    <Text style={{ color: C.muted, fontSize: 12, paddingVertical: S[4] }}>
                      No loose cards — everything is grouped.
                    </Text>
                  )}
                </ScrollView>
              </View>
            );
          })}
        </View>

        {/* arranging */}
        <View style={{ width: feltW, flexDirection: 'row', gap: S[2] }}>
          <Btn
            label="Group"
            compact
            style={{ flex: 1 }}
            onPress={() => { setGroups(g => groupUp(g, picked)); setPicked([]); playSfx('tick'); }}
            disabled={picked.length < 2}
            accessibilityLabel="Put the selected cards into a group"
          />
          <Btn
            label="Ungroup"
            compact
            style={{ flex: 1 }}
            onPress={() => { setGroups(g => ungroup(g, picked)); setPicked([]); playSfx('tick'); }}
            disabled={picked.length === 0}
          />
          <Btn
            label="Sort"
            compact
            style={{ flex: 1 }}
            onPress={() => { setGroups(g => sortLoose(g, id => byId.get(id))); playSfx('tick'); }}
            accessibilityLabel="Sort the ungrouped cards by suit"
          />
        </View>

        {/* playing */}
        <View style={{ width: feltW, flexDirection: 'row', gap: S[2] }}>
          <Btn label="Discard" compact style={{ flex: 1 }} onPress={discard} disabled={!mine || picked.length !== 1} />
          <Btn label="Declare" kind="gold" compact style={{ flex: 1 }} onPress={() => setConfirmDeclare(true)} disabled={!mine || picked.length !== 1} />
          <Btn label="Drop" kind="danger" compact onPress={() => send({ t: 'drop' })} disabled={!mine} />
        </View>

        <Text style={{ color: C.muted, fontSize: 12, textAlign: 'center', width: feltW }}>
          {picked.length === 0
            ? 'Tap cards to select. Two or more can be grouped into a run or a set.'
            : picked.length === 1
              ? 'Discard this card, or Declare with it as your final discard.'
              : `${picked.length} selected — Group them, or pick one card to discard.`}
        </Text>

        <VoiceBar
          width={feltW}
          phase={voice.phase}
          error={voice.error}
          canSpeak={voice.canSpeak}
          muted={voice.muted}
          participants={voice.participants}
          onJoin={voice.join}
          onLeave={voice.leave}
          onToggleMute={voice.toggleMute}
        />

        <View style={{ width: feltW, flexDirection: 'row', gap: S[2] }}>
          <Btn label="Invite" icon="🔗" compact style={{ flex: 1 }} onPress={() => { void inviteToTable('rummy', tableId); }} disabled={!tableId} />
          <Btn label="⚙" compact onPress={() => setShowSettings(true)} accessibilityLabel="Settings" />
        </View>

        {finished && (
          <View style={{ width: feltW, flexDirection: 'row', gap: S[2] }}>
            <Btn label="Deal again" kind="gold" icon="↻" style={{ flex: 1 }} onPress={() => send({ t: 'start' })} />
            <Btn label="Share" icon="📣" onPress={() => { void shareResult('rummy', G.winnerId === state.you); }} />
          </View>
        )}
        </View>
      </ScrollView>

      <Toasts events={events} />
      <Confetti show={!!finished && G.winnerId === state.you} />

      <Sheet visible={confirmDeclare} title="Declare?" onClose={() => setConfirmDeclare(false)}>
        <Text style={{ color: C.muted, fontSize: t.sm, lineHeight: 20 }}>
          This ends the round. The table checks your hand — if the melds do not stand up, the round is scored against you.
        </Text>
        <Btn label="Declare" kind="gold" onPress={() => { setConfirmDeclare(false); declare(); }} />
      </Sheet>

      <Sheet visible={showSettings} title="Table" onClose={() => setShowSettings(false)}>
        <SettingRow
          label="Sound"
          value={sound ? 'On' : 'Off'}
          onPress={() => { const n = !sound; setSound(n); void setSoundEnabled(n); }}
        />
        <SettingRow
          label="Leave table"
          hint="Drops you from this hand"
          value="Leave"
          onPress={() => { setShowSettings(false); send({ t: 'drop' }); }}
        />
      </Sheet>
    </TableBackground>
  );
}

/* ── the felt ───────────────────────────────────────────────────────── */

function Felt({ width, children }: { width: number; children: React.ReactNode }) {
  const h = Math.max(268, width * 0.72);
  return (
    <View style={{ width, minHeight: h, padding: 12, justifyContent: 'center' }}>
      <Svg width={width} height={h} style={{ position: 'absolute' }}>
        <Defs>
          <RadialGradient id="baize" cx="50%" cy="12%" rx="72%" ry="60%">
            <Stop offset="0" stopColor={FELT[0]} />
            <Stop offset="0.62" stopColor={FELT[1]} />
            <Stop offset="1" stopColor={FELT[2]} />
          </RadialGradient>
          <RadialGradient id="sheenR" cx="50%" cy="0%" rx="70%" ry="40%">
            <Stop offset="0" stopColor="#ffffff" stopOpacity="0.07" />
            <Stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Rect x="1" y="1" width={width - 2} height={h - 2} rx={Math.min(width, h) * 0.34} fill="url(#baize)" stroke="#a9791b" strokeWidth="2" />
        <Rect x="8" y="8" width={width - 16} height={h - 16} rx={Math.min(width, h) * 0.32} fill="none" stroke="rgba(0,0,0,0.24)" strokeWidth="7" />
        <Rect x="8" y="8" width={width - 16} height={h - 16} rx={Math.min(width, h) * 0.32} fill="url(#sheenR)" />
      </Svg>
      {children}
    </View>
  );
}

function Seat({ name, count, bot, turn, out }: { name: string; count: number; bot: boolean; turn: boolean; out: boolean }) {
  const spin = useSharedValue(0);
  useEffect(() => {
    if (turn) {
      spin.value = withRepeat(withTiming(1, { duration: 3400, easing: Easing.linear }), -1, false);
    } else {
      cancelAnimation(spin);
      spin.value = 0;
    }
    return () => cancelAnimation(spin);
  }, [turn, spin]);
  const a = useAnimatedStyle(() => ({ transform: [{ rotate: `${spin.value * 360}deg` }] }));

  const initials = name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();

  return (
    <View style={{ width: 86, alignItems: 'center', opacity: out ? 0.5 : 1 }}
      accessibilityLabel={`${name}, ${count} cards${turn ? ', playing now' : ''}`}>
      <View style={{ width: 50, height: 50, borderRadius: 25, padding: 3, backgroundColor: '#0a1710', justifyContent: 'center' }}>
        {turn && (
          <Animated.View style={[{
            position: 'absolute', inset: 0, borderRadius: 25,
            borderWidth: 3, borderColor: C.gold, borderTopColor: C.gold2, borderBottomColor: C.goldDeep,
          }, a]} />
        )}
        <View style={{
          flex: 1, borderRadius: 24, alignItems: 'center', justifyContent: 'center',
          backgroundColor: bot ? '#6f9bff' : C.gold,
        }}>
          <Text style={{ color: '#2a1c00', fontWeight: '800', fontSize: 17 }}>{bot ? '🤖' : initials}</Text>
        </View>
      </View>
      <Text numberOfLines={1} style={{ color: '#fff', fontWeight: '700', fontSize: 13, marginTop: 3, textShadowColor: 'rgba(0,0,0,0.7)', textShadowRadius: 2, textShadowOffset: { width: 0, height: 1 } }}>
        {name}
      </Text>
      <Text style={{ color: '#e7f3ea', fontSize: 11 }}>{count} cards</Text>
    </View>
  );
}

function Pile({
  label: text, live, onPress, card, back,
}: { label: string; live: boolean; onPress: () => void; card?: Card | null; back?: boolean }) {
  const bob = useSharedValue(0);
  useEffect(() => {
    if (live) {
      bob.value = withRepeat(withTiming(1, { duration: 800, easing: Easing.inOut(Easing.ease) }), -1, true);
    } else {
      cancelAnimation(bob);
      bob.value = withTiming(0, { duration: 160 });
    }
    return () => cancelAnimation(bob);
  }, [live, bob]);
  const a = useAnimatedStyle(() => ({ transform: [{ translateY: -bob.value * 3 }] }));

  return (
    <Pressable
      onPress={live ? onPress : undefined}
      disabled={!live}
      accessibilityRole="button"
      accessibilityLabel={back ? `Closed deck, ${text}` : card ? `${spoken(card)}, ${text}` : text}
      style={{ alignItems: 'center', gap: 5 }}
    >
      <Animated.View style={a}>
        {back ? <CardBack live={live} /> : card ? <CardFace card={card} w={50} glow={live} /> : <EmptySlot />}
      </Animated.View>
      <Text style={{ color: '#e7f3ea', fontSize: 11, fontWeight: '700', textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 2, textShadowOffset: { width: 0, height: 1 } }}>
        {text}
      </Text>
    </Pressable>
  );
}

/** The diagonal-stripe card back from rummy.css, drawn as SVG lines. */
function CardBack({ live }: { live: boolean }) {
  const w = 50, h = 70;
  return (
    <View style={{
      width: w, height: h, borderRadius: 8, overflow: 'hidden',
      borderWidth: 1, borderColor: CARD_EDGE,
      boxShadow: live
        ? '0 0 0 2px #f3c245, 0 0 16px rgba(232,194,95,0.55), 0 4px 10px rgba(0,0,0,0.5)'
        : '0 3px 9px rgba(0,0,0,0.55)',
    }}>
      <Svg width={w} height={h}>
        <Rect x="0" y="0" width={w} height={h} fill="#a3163f" />
        {Array.from({ length: 18 }, (_, i) => (
          <Line key={i} x1={-h + i * 10} y1={h} x2={-h + i * 10 + h} y2={0} stroke="#86112f" strokeWidth="5" />
        ))}
        <Rect x="3" y="3" width={w - 6} height={h - 6} rx="5" fill="none" stroke="rgba(247,244,234,0.14)" strokeWidth="3" />
      </Svg>
    </View>
  );
}

function EmptySlot() {
  return (
    <View style={{
      width: 50, height: 70, borderRadius: 8,
      borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.35)',
    }} />
  );
}

/** A card face with corner indices and a centre pip, as in rummy.css. */
function CardFace({ card, w, glow, wild }: { card: Card; w: number; glow?: boolean; wild?: boolean }) {
  const h = Math.round(w * 1.385);
  const joker = card.suit === 'JOKER';
  const color = joker ? JOKER_PURPLE : RED.has(card.suit) ? CARD_RED : CARD_INK;
  const idx = Math.round(w * 0.27);

  return (
    <View style={{
      width: w, height: h, borderRadius: 8,
      backgroundColor: joker ? '#f6efff' : CARD_FACE,
      borderWidth: 1, borderColor: wild ? C.gold : CARD_EDGE,
      boxShadow: glow
        ? '0 0 0 2px #f3c245, 0 3px 8px rgba(0,0,0,0.4)'
        : wild
          ? '0 0 0 2px #f3c245, 0 3px 8px rgba(0,0,0,0.4)'
          : '0 2px 6px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.8)',
      overflow: 'hidden',
    }}>
      <Text style={{ position: 'absolute', top: 3, left: 4, fontSize: idx, lineHeight: idx * 1.1, fontWeight: '800', color }}>
        {joker ? '★' : card.rank}
      </Text>
      {!joker && (
        <Text style={{ position: 'absolute', top: 3 + idx * 1.05, left: 4, fontSize: idx * 0.78, lineHeight: idx * 0.85, color }}>
          {SUIT_GLYPH[card.suit]}
        </Text>
      )}
      <Text style={{
        position: 'absolute', left: 0, right: 0, top: h / 2 - w * 0.31,
        textAlign: 'center', fontSize: w * 0.5, lineHeight: w * 0.62, color, opacity: 0.9,
      }}>
        {joker ? '★' : SUIT_GLYPH[card.suit]}
      </Text>
    </View>
  );
}

/**
 * A card in the player's hand.
 *
 * Selection lifts the card 12px with a gold rim — the same affordance the web
 * client uses, and the reason a discard never needs a confirm step: the card
 * you are about to lose is visibly out of the fan.
 */
function HandCard({ card, selected, onPress }: { card: Card; selected: boolean; onPress: () => void }) {
  const lift = useSharedValue(selected ? 1 : 0);
  const pop = useSharedValue(0);
  const first = useRef(true);

  useEffect(() => {
    lift.value = withSpring(selected ? 1 : 0, { damping: 15, stiffness: 260 });
  }, [selected, lift]);

  // drawPop — a newly arrived card drops in rather than appearing.
  useEffect(() => {
    if (!first.current) return;
    first.current = false;
    pop.value = 1;
    pop.value = withSpring(0, { damping: 11, stiffness: 200 });
  }, [pop]);

  const a = useAnimatedStyle(() => ({
    transform: [
      { translateY: -lift.value * 12 - pop.value * 16 },
      { scale: 1 + pop.value * 0.1 },
    ] as ViewStyle['transform'],
  }));

  return (
    <Animated.View style={a}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={`${spoken(card)}${selected ? ', selected' : ''}`}
        style={selected ? { borderRadius: 9, borderWidth: 2, borderColor: C.gold } : undefined}
      >
        <CardFace card={card} w={52} glow={selected} />
      </Pressable>
    </Animated.View>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <TableBackground>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: S[5], gap: S[3] }}>
        {children}
      </View>
    </TableBackground>
  );
}
