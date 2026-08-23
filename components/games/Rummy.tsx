/**
 * Rummy — native, server-refereed, landscape.
 *
 * The server holds the deck, deals, and validates every meld. It sends the
 * public table in `game` and THIS player's cards in a separate top-level
 * `hand` — the other players are only ever a `handCount`, which is what keeps
 * the game honest: nobody's cards are ever on another device to be read out of
 * a debugger. See docs/GAMES_PROTOCOL.md.
 *
 * There is no meld validation here, no scoring, no wild-card substitution.
 * `declare` sends the player's grouping and the SERVER decides. The badges come
 * from lib/games/meldHint.ts, which is advisory and may never gate an action.
 *
 * Card: { id, suit: 'S'|'H'|'D'|'C'|'JOKER', rank } — id is unique per physical
 * card because two decks are in play and duplicates genuinely exist.
 *
 * LAYOUT: the felt IS the screen. Seats, piles, the hand and the actions all
 * sit on top of it, the way a real table works and the way every cash-rummy app
 * is built. Thirteen cards plus two piles do not fit across a portrait phone at
 * a legible size, so this screen takes landscape while mounted and gives it
 * back on the way out.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Pressable, ScrollView, Text, View, useWindowDimensions, type ViewStyle,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Defs, RadialGradient, Stop, Rect, Line, Ellipse } from 'react-native-svg';
import Animated, {
  useSharedValue, useAnimatedStyle, withSpring, withTiming, withRepeat,
  Easing, cancelAnimation, runOnJS,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import * as ScreenOrientation from 'expo-screen-orientation';
import { useGameSocket, type AutoStart } from '../../lib/games/useGameSocket';
import { TableBackground, Panel, Btn, Banner, PlayerRow, useType } from './ui';
import { Toasts, Confetti, Sheet, SettingRow, VoiceBar } from './feedback';
import { useTableVoice } from '../../lib/games/useTableVoice';
import { playSfx, preloadSfx, soundEnabled, setSoundEnabled } from '../../lib/games/sfx';
import {
  reconcile, groupUp, ungroup, sortLoose, sameGroups, moveCard, autoArrange,
  type Groups,
} from '../../lib/games/handGroups';
import { analyzeHand, type MeldType } from '../../lib/games/meldHint';
import { inviteToTable, shareResult } from '../../lib/games/invite';
import { C, S, R, D3, mix, goldLine } from '../../lib/games/theme';

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

function spoken(c: Card): string {
  if (c.suit === 'JOKER' || !c.rank) return 'joker';
  return `${c.rank} of ${SUIT_NAME[c.suit] ?? c.suit}`;
}

/** A measured drop target, in window coordinates. */
type Zone = { x: number; y: number; w: number; h: number };

export default function Rummy({ tableId = '', auto, autoBot }: { tableId?: string } & AutoStart) {
  const { phase, error, state, events, send, retry } = useGameSocket('rummy', tableId, { auto, autoBot });
  const t = useType();
  const { width, height } = useWindowDimensions();

  const [picked, setPicked] = useState<string[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [confirmDeclare, setConfirmDeclare] = useState(false);
  const [sound, setSound] = useState(soundEnabled());
  const voice = useTableVoice('rummy', tableId);

  const L = state.lobby;
  const G = state.game;
  const hand: Card[] = Array.isArray(state.raw?.hand) ? state.raw.hand : [];
  const mine = G?.turnPlayerId === state.you;

  /**
   * Take landscape while this table is open, and give it back on the way out.
   * Restoring is the part that matters: the app is portrait-locked, and leaving
   * it unlocked would let every other screen rotate.
   */
  useEffect(() => {
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
    return () => { void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {}); };
  }, []);

  useEffect(() => { void preloadSfx(['deal', 'discard', 'select', 'tick', 'win', 'lose']); }, []);

  // ── the player's arrangement ───────────────────────────────────────
  const [groups, setGroups] = useState<Groups>([[]]);
  const byId = React.useMemo(() => new Map(hand.map(c => [c.id, c])), [hand]);

  // A new deal arrives pre-arranged into candidate melds, the way every native
  // rummy app does it. Arranging thirteen loose cards from scratch each hand is
  // the tedious part of the game, not the interesting one — and the player can
  // drag anything they disagree with.
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
        return autoArrange(hand, c => c.suit === 'JOKER' || (!!G?.wildRank && c.rank === G.wildRank));
      }
      const next = reconcile(prev, hand.map(c => c.id));
      return sameGroups(prev, next) ? prev : next;
    });
  }, [hand, G?.wildRank]);

  const sentGroups = useRef<Groups | null>(null);
  useEffect(() => {
    if (!G || groups.flat().length === 0) return;
    if (sentGroups.current && sameGroups(sentGroups.current, groups)) return;
    sentGroups.current = groups;
    send({ t: 'arrange', groups });
  }, [groups, G, send]);

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

  /** ADVISORY ONLY — the server judges the declaration. */
  const hint = React.useMemo(
    () => analyzeHand(groups, id => byId.get(id), G?.wildRank ?? null),
    [groups, byId, G?.wildRank],
  );

  // ── drag and drop ──────────────────────────────────────────────────
  //
  // Group rows publish their WINDOW rect on layout, so the gesture's
  // absoluteX/absoluteY can be compared directly with no parent offset to keep
  // in step as the layout shifts.
  const zones = useRef<Zone[]>([]);
  const setZone = (i: number, z: Zone) => { zones.current[i] = z; };

  const dropAt = (cardId: string, x: number, y: number) => {
    const hit = zones.current.findIndex(
      z => z && x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h,
    );
    setGroups(g => moveCard(g, cardId, hit));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    playSfx('tick');
  };

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

  const declare = () => {
    if (picked.length !== 1) return;
    const laid = groups.map(g => g.filter(id => id !== picked[0])).filter(g => g.length > 0);
    send({ t: 'declare', discardId: picked[0], groups: laid });
    setPicked([]);
  };

  // ── connection / lobby ─────────────────────────────────────────────
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
              <PlayerRow key={m.vaultId} name={m.name} tag={m.vaultId === state.you ? 'you' : m.isBot ? 'bot' : undefined} />
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

  // ── the table ──────────────────────────────────────────────────────
  const players: any[] = Array.isArray(G.players) ? G.players : [];
  const others = players.filter(p => (p.id ?? p.vaultId) !== state.you);
  const openTop: Card | null = G.openTop ?? null;
  const closedCount: number = typeof G.closedCount === 'number' ? G.closedCount : 0;
  const wild: Card | null = G.wildJokerCard ?? null;

  // Thirteen cards plus gaps and group padding have to fit across the strip.
  // Cards inside a group OVERLAP, so the width each one costs after the first
  // is only FAN of its own width — which is what keeps five groups on screen.
  const cardW = Math.max(40, Math.min(58, Math.floor((width - S[4] * 2) / 13)));
  // The cloth takes the top share; the hand and controls take the rest.
  const tableH = Math.max(150, Math.min(height * 0.42, 260));

  return (
    <View style={{ flex: 1 }}>
      <Baize width={width} height={height} />

      {/* The table itself — an oval with a gold rail, inset from the screen so
          it reads as an object you are sitting at rather than a green
          background. Seats sit ON its far edge; the hand is outside it, in
          front of the player, as at a real table. */}
      <View style={{ height: tableH, marginHorizontal: S[4], marginTop: S[2] }}>
        <TableTop width={width - S[4] * 2} height={tableH} />

        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, alignItems: 'center', paddingTop: S[1] }}>
          <View style={{ flexDirection: 'row', gap: S[5], justifyContent: 'center' }}>
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
        </View>

        <View style={{ position: 'absolute', top: S[2], right: S[3] }}>
          <Btn label="⚙" compact onPress={() => setShowSettings(true)} accessibilityLabel="Table settings" />
        </View>

        {/* piles, in the middle of the cloth */}
        <View style={{
          position: 'absolute', left: 0, right: 0, bottom: S[2],
          flexDirection: 'row', gap: S[5], justifyContent: 'center', alignItems: 'center',
        }}>
          <Pile label={`${closedCount} left`} live={mine} onPress={() => draw('closed')} back w={cardW} />
          <Pile label="Open" live={mine && !!openTop} onPress={() => draw('open')} card={openTop} w={cardW} />
          {wild ? (
            <View style={{ alignItems: 'center', gap: 3 }}>
              <CardFace card={wild} w={cardW} wild />
              <Text style={{ color: '#e7f3ea', fontSize: 10, fontWeight: '700' }}>Wild</Text>
            </View>
          ) : null}
        </View>
      </View>

      {/* status strip */}
      <View style={{ paddingHorizontal: S[4], alignItems: 'center', paddingTop: S[1] }}>
        {finished ? (
          <Banner
            text={G.winnerId === state.you ? 'You win!' : `${players.find(p => (p.id ?? p.vaultId) === G.winnerId)?.name ?? 'Someone'} wins`}
            tone={G.winnerId === state.you ? 'win' : 'lose'}
          />
        ) : (
          <View style={{
            flexDirection: 'row', alignItems: 'center', gap: S[3],
            paddingHorizontal: S[4], paddingVertical: S[1], borderRadius: 999,
            backgroundColor: 'rgba(4,26,14,0.55)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
          }}>
            <Text style={{ color: mine ? '#ffdd72' : '#cfe8d8', fontSize: t.sm, fontWeight: '800' }}>
              {mine ? 'Your turn — draw, then discard' : `${players.find(p => (p.id ?? p.vaultId) === G.turnPlayerId)?.name ?? 'Someone'} is playing`}
            </Text>
            <Text style={{ color: hint.valid ? '#5fe08c' : '#cfa0a0', fontSize: 12, fontWeight: '700' }}>
              {hint.valid ? '✓ valid hand'
                : !hint.hasPure ? 'no pure sequence'
                : !hint.hasTwoSeq ? 'needs 2nd sequence'
                : `${hint.fullCount} pts`}
            </Text>
          </View>
        )}
      </View>

      {/* the hand — each group is a drop target */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: S[4], gap: S[5], alignItems: 'flex-end', paddingVertical: S[2] }}
        style={{ flexGrow: 0 }}
      >
        {groups.map((g, gi) => (
          <GroupZone
            key={gi}
            index={gi}
            loose={gi === groups.length - 1}
            verdict={hint.groups[gi]}
            onMeasure={setZone}
            minW={cardW * 1.6}
            overlap={Math.round(cardW * 0.42)}
          >
            {g.map(id => {
              const c = byId.get(id);
              return c ? (
                <HandCard
                  key={id}
                  card={c}
                  w={cardW}
                  selected={picked.includes(id)}
                  onPress={() => toggle(id)}
                  onDrop={dropAt}
                />
              ) : null;
            })}
            {g.length === 0 && (
              <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 11, paddingHorizontal: S[3], paddingVertical: S[4] }}>
                Drop cards here
              </Text>
            )}
          </GroupZone>
        ))}
      </ScrollView>

      {/* actions */}
      <View style={{ flexDirection: 'row', gap: S[2], paddingHorizontal: S[4], alignItems: 'center' }}>
        <Btn label="Group" compact onPress={() => { setGroups(g => groupUp(g, picked)); setPicked([]); playSfx('tick'); }} disabled={picked.length < 2} />
        <Btn label="Ungroup" compact onPress={() => { setGroups(g => ungroup(g, picked)); setPicked([]); playSfx('tick'); }} disabled={picked.length === 0} />
        <Btn
          label="Auto sort"
          compact
          icon="⚡"
          accessibilityLabel="Rearrange the whole hand into melds"
          onPress={() => {
            setGroups(autoArrange(hand, c => c.suit === 'JOKER' || (!!G?.wildRank && c.rank === G.wildRank)));
            setPicked([]);
            playSfx('tick');
          }}
        />
        <View style={{ flex: 1 }} />
        <Btn label="Discard" compact onPress={discard} disabled={!mine || picked.length !== 1} />
        <Btn label="Declare" kind="gold" compact onPress={() => setConfirmDeclare(true)} disabled={!mine || picked.length !== 1} />
        <Btn label="Drop" kind="danger" compact onPress={() => send({ t: 'drop' })} disabled={!mine} />
      </View>

      {finished && (
        <View style={{ flexDirection: 'row', gap: S[2], paddingHorizontal: S[4], paddingTop: S[2] }}>
          <Btn label="Deal again" kind="gold" icon="↻" style={{ flex: 1 }} onPress={() => send({ t: 'start' })} />
          <Btn label="Share" icon="📣" onPress={() => { void shareResult('rummy', G.winnerId === state.you); }} />
        </View>
      )}

      <View style={{ paddingHorizontal: S[4], paddingTop: S[2], paddingBottom: S[2] }}>
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
      </View>

      <Toasts events={events} />
      <Confetti show={!!finished && G.winnerId === state.you} />

      <Sheet visible={confirmDeclare} title="Declare?" onClose={() => setConfirmDeclare(false)}>
        <Text style={{ color: C.muted, fontSize: t.sm, lineHeight: 20 }}>
          This ends the round. The table checks your hand — if the melds do not stand up, the round is scored against you.
        </Text>
        <Text style={{ color: hint.valid ? C.good : C.bad, fontSize: t.md, fontWeight: '800' }}>
          {hint.valid
            ? '✓ This looks like a winning hand.'
            : `✗ This does not look valid${hint.hasPure ? '' : ' — no pure sequence'}. Declaring now scores ${hint.fullCount} points against you.`}
        </Text>
        <Btn
          label={hint.valid ? 'Declare & win' : 'Declare anyway'}
          kind={hint.valid ? 'gold' : 'danger'}
          onPress={() => { setConfirmDeclare(false); declare(); }}
        />
      </Sheet>

      <Sheet visible={showSettings} title="Table" onClose={() => setShowSettings(false)}>
        <SettingRow label="Sound" value={sound ? 'On' : 'Off'} onPress={() => { const n = !sound; setSound(n); void setSoundEnabled(n); }} />
        <SettingRow label="Invite a friend" hint="Share this table" value="Share" onPress={() => { setShowSettings(false); void inviteToTable('rummy', tableId); }} />
        <SettingRow label="Leave table" hint="Drops you from this hand" value="Leave" onPress={() => { setShowSettings(false); send({ t: 'drop' }); }} />
      </Sheet>
    </View>
  );
}

/* ── the felt, full screen ──────────────────────────────────────────── */

/**
 * The cloth.
 *
 * A green screen is not a table. The oval, its gold rail and the shadow under
 * it are what make the piles read as sitting ON something — and give the other
 * players somewhere to be.
 */
function TableTop({ width, height }: { width: number; height: number }) {
  const rx = width / 2 - 2;
  const ry = height / 2 - 2;
  return (
    <Svg width={width} height={height} style={{ position: 'absolute' }} pointerEvents="none">
      <Defs>
        <RadialGradient id="cloth" cx="50%" cy="30%" rx="70%" ry="75%">
          <Stop offset="0" stopColor="#1c9257" />
          <Stop offset="0.65" stopColor="#0a4c2c" />
          <Stop offset="1" stopColor="#073a20" />
        </RadialGradient>
        <RadialGradient id="rail" cx="50%" cy="0%" rx="70%" ry="90%">
          <Stop offset="0" stopColor="#ffe89a" />
          <Stop offset="0.45" stopColor="#a9791b" />
          <Stop offset="1" stopColor="#5f4110" />
        </RadialGradient>
      </Defs>
      <Ellipse cx={width / 2} cy={height / 2} rx={rx} ry={ry} fill="url(#rail)" />
      <Ellipse cx={width / 2} cy={height / 2} rx={rx - 9} ry={ry - 9} fill="url(#cloth)" />
      <Ellipse
        cx={width / 2} cy={height / 2} rx={rx - 9} ry={ry - 9}
        fill="none" stroke="rgba(0,0,0,0.30)" strokeWidth="6"
      />
    </Svg>
  );
}

function Baize({ width, height }: { width: number; height: number }) {
  return (
    <Svg width={width} height={height} style={{ position: 'absolute', top: 0, left: 0 }} pointerEvents="none">
      <Defs>
        <RadialGradient id="rbaize" cx="50%" cy="18%" rx="80%" ry="85%">
          <Stop offset="0" stopColor={FELT[0]} />
          <Stop offset="0.62" stopColor={FELT[1]} />
          <Stop offset="1" stopColor={FELT[2]} />
        </RadialGradient>
      </Defs>
      <Rect x="0" y="0" width={width} height={height} fill="url(#rbaize)" />
      <Rect x="0" y="0" width={width} height="3" fill="#a9791b" opacity="0.8" />
    </Svg>
  );
}

/* ── a drop zone ────────────────────────────────────────────────────── */

function GroupZone({
  index, loose, verdict, onMeasure, minW, overlap, children,
}: {
  index: number;
  loose: boolean;
  verdict?: { type: MeldType; label: string };
  onMeasure: (i: number, z: Zone) => void;
  minW: number;
  overlap: number;
  children: React.ReactNode;
}) {
  const ref = useRef<View>(null);
  return (
    <View
      ref={ref}
      // measureInWindow rather than the layout event's own x/y: the row sits
      // inside a horizontal ScrollView, so its parent-relative position says
      // nothing about where a finger actually lands on the glass.
      onLayout={() => {
        ref.current?.measureInWindow((x, y, w, h) => onMeasure(index, { x, y, w, h }));
      }}
      accessibilityLabel={loose ? 'Ungrouped cards' : `Group ${index + 1}${verdict?.label ? `, ${verdict.label}` : ''}`}
      style={{
        minWidth: minW,
        borderRadius: R[2],
        borderWidth: 1,
        borderStyle: loose ? 'dashed' : 'solid',
        borderColor: loose ? 'rgba(255,255,255,0.30)' : goldLine[38],
        backgroundColor: loose ? 'rgba(0,0,0,0.14)' : 'rgba(0,0,0,0.26)',
        paddingHorizontal: S[2], paddingTop: S[2], paddingBottom: S[1],
        gap: 3,
      }}
    >
      {/* Cards overlap into a fan the way a held hand does. gap is NEGATIVE:
          five groups of three at full width would not fit any phone. */}
      <View style={{ flexDirection: 'row', gap: -overlap, alignItems: 'flex-end', minHeight: 10, paddingRight: overlap }}>
        {children}
      </View>
      <View style={{ height: 15, justifyContent: 'center' }}>
        <MeldBadge verdict={verdict} loose={loose} />
      </View>
    </View>
  );
}

/** The group badge. Colour carries the same meaning as the label. */
function MeldBadge({ verdict, loose }: { verdict?: { type: MeldType; label: string }; loose?: boolean }) {
  if (loose) return <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 10, fontWeight: '700' }}>Ungrouped</Text>;
  if (!verdict || verdict.type === 'empty' || !verdict.label) return null;
  const good = verdict.type === 'pure' || verdict.type === 'impure' || verdict.type === 'set';
  const color = verdict.type === 'pure' ? '#5fe08c' : good ? '#ffdd72' : '#ff8080';
  return (
    <Text style={{ color, fontSize: 10, fontWeight: '800' }}>
      {good ? '✓' : '✗'} {verdict.label}
    </Text>
  );
}

/* ── piles ──────────────────────────────────────────────────────────── */

function Pile({
  label: text, live, onPress, card, back, w,
}: { label: string; live: boolean; onPress: () => void; card?: Card | null; back?: boolean; w: number }) {
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
      style={{ alignItems: 'center', gap: 3 }}
    >
      <Animated.View style={a}>
        {back ? <CardBack live={live} w={w} /> : card ? <CardFace card={card} w={w} glow={live} /> : <EmptySlot w={w} />}
      </Animated.View>
      <Text style={{ color: '#e7f3ea', fontSize: 10, fontWeight: '700' }}>{text}</Text>
    </Pressable>
  );
}

function CardBack({ live, w }: { live: boolean; w: number }) {
  const h = Math.round(w * 1.385);
  return (
    <View style={{
      width: w, height: h, borderRadius: 6, overflow: 'hidden',
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
        <Rect x="3" y="3" width={w - 6} height={h - 6} rx="4" fill="none" stroke="rgba(247,244,234,0.14)" strokeWidth="3" />
      </Svg>
    </View>
  );
}

function EmptySlot({ w }: { w: number }) {
  return (
    <View style={{
      width: w, height: Math.round(w * 1.385), borderRadius: 6,
      borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.35)',
    }} />
  );
}

function CardFace({ card, w, glow, wild }: { card: Card; w: number; glow?: boolean; wild?: boolean }) {
  const h = Math.round(w * 1.385);
  const joker = card.suit === 'JOKER';
  const color = joker ? JOKER_PURPLE : RED.has(card.suit) ? CARD_RED : CARD_INK;
  const idx = Math.round(w * 0.3);

  return (
    <View style={{
      width: w, height: h, borderRadius: 6,
      backgroundColor: joker ? '#f6efff' : CARD_FACE,
      borderWidth: 1, borderColor: wild ? '#f3c245' : CARD_EDGE,
      boxShadow: glow || wild
        ? '0 0 0 2px #f3c245, 0 3px 8px rgba(0,0,0,0.4)'
        : '0 2px 6px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.8)',
      overflow: 'hidden',
    }}>
      <Text style={{ position: 'absolute', top: 2, left: 3, fontSize: idx, lineHeight: idx * 1.1, fontWeight: '800', color }}>
        {joker ? '★' : card.rank}
      </Text>
      <Text style={{
        position: 'absolute', left: 0, right: 0, top: h / 2 - w * 0.3,
        textAlign: 'center', fontSize: w * 0.46, lineHeight: w * 0.6, color, opacity: 0.9,
      }}>
        {joker ? '★' : SUIT_GLYPH[card.suit]}
      </Text>
    </View>
  );
}

/* ── a draggable card ───────────────────────────────────────────────── */

/**
 * Tap to select, DRAG to re-group.
 *
 * Both gestures live on one card, which is why the pan needs a few pixels of
 * movement before it activates — without that threshold every tap becomes a
 * one-pixel drag and selection stops working entirely.
 *
 * The card lifts and follows the finger; on release the drop point is matched
 * against the measured group rects back on the JS thread.
 */
function HandCard({
  card, w, selected, onPress, onDrop,
}: {
  card: Card;
  w: number;
  selected: boolean;
  onPress: () => void;
  onDrop: (cardId: string, x: number, y: number) => void;
}) {
  const dx = useSharedValue(0);
  const dy = useSharedValue(0);
  const lift = useSharedValue(selected ? 1 : 0);
  const dragging = useSharedValue(0);

  useEffect(() => {
    lift.value = withSpring(selected ? 1 : 0, { damping: 15, stiffness: 260 });
  }, [selected, lift]);

  const pan = Gesture.Pan()
    .minDistance(8)
    .onStart(() => { dragging.value = 1; })
    .onUpdate(e => { dx.value = e.translationX; dy.value = e.translationY; })
    .onEnd(e => {
      runOnJS(onDrop)(card.id, e.absoluteX, e.absoluteY);
      // Spring home regardless: the card's real position comes from the new
      // arrangement, so leaving it under the finger would double the move.
      dx.value = withSpring(0, { damping: 18, stiffness: 260 });
      dy.value = withSpring(0, { damping: 18, stiffness: 260 });
    })
    .onFinalize(() => { dragging.value = 0; });

  const tap = Gesture.Tap().onEnd((_e, ok) => { if (ok) runOnJS(onPress)(); });
  const composed = Gesture.Exclusive(pan, tap);

  const a = useAnimatedStyle(() => ({
    transform: [
      { translateX: dx.value },
      { translateY: dy.value - lift.value * 10 - dragging.value * 8 },
      { scale: 1 + dragging.value * 0.08 },
    ] as ViewStyle['transform'],
    zIndex: dragging.value ? 50 : 1,
  }));

  return (
    <GestureDetector gesture={composed}>
      <Animated.View
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={`${spoken(card)}${selected ? ', selected' : ''}. Drag to move between groups.`}
        style={[a, selected ? { borderRadius: 8, borderWidth: 2, borderColor: '#f3c245' } : null]}
      >
        <CardFace card={card} w={w} glow={selected} />
      </Animated.View>
    </GestureDetector>
  );
}

/* ── seats ──────────────────────────────────────────────────────────── */

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
    <View
      style={{ alignItems: 'center', opacity: out ? 0.5 : 1, width: 72 }}
      accessibilityLabel={`${name}, ${count} cards${turn ? ', playing now' : ''}`}
    >
      <View style={{ width: 38, height: 38, borderRadius: 19, padding: 3, backgroundColor: '#0a1710', justifyContent: 'center' }}>
        {turn && (
          <Animated.View style={[{
            position: 'absolute', inset: 0, borderRadius: 19,
            borderWidth: 3, borderColor: '#f3c245', borderTopColor: '#ffdd72', borderBottomColor: '#a9791b',
          }, a]} />
        )}
        <View style={{ flex: 1, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: bot ? '#6f9bff' : '#f3c245' }}>
          <Text style={{ color: '#2a1c00', fontWeight: '800', fontSize: 13 }}>{bot ? '🤖' : initials}</Text>
        </View>
      </View>
      <Text numberOfLines={1} style={{ color: '#fff', fontWeight: '700', fontSize: 11, marginTop: 2 }}>{name}</Text>
      <Text style={{ color: '#e7f3ea', fontSize: 10 }}>{count} cards</Text>
    </View>
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
