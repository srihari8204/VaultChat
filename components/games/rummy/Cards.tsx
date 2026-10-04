// components/games/rummy/Cards.tsx — the cards and where they go: a group tray,
// the piles, the faces and backs, and the hand's draggable card.
// Split out of components/games/Rummy.tsx; behaviour unchanged apart from the
// screen-reader fixes on the hand card (see HandCard).

import React, { useEffect, useRef } from 'react';
import { Pressable, Text, View, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Defs, RadialGradient, Stop, Rect, G, Text as SvgText } from 'react-native-svg';
import Animated, {
  useSharedValue, useAnimatedStyle, withSpring, withTiming, withRepeat,
  Easing, cancelAnimation, runOnJS,
} from 'react-native-reanimated';
import type { MeldType } from '../../../lib/games/meldHint';
import { rummyCardName, rummyCardLabel } from '../../../lib/games/boardLabels';
import { C, R, S, white } from '../../../lib/games/theme';
import { CARD, CARD_SHADOW, INK as INK_ON_FELT, MELD_INK, onFelt } from '../../../lib/games/rummyGlass';
import { RED, SUIT_GLYPH, type Card, type Zone } from './shared';

/* ── a drop zone ────────────────────────────────────────────────────── */

export function GroupZone({
  index, loose, verdict, onMeasure, minW, overlap, height, children,
}: {
  index: number;
  loose: boolean;
  verdict?: { type: MeldType; label: string };
  onMeasure: (i: number, z: Zone) => void;
  minW: number;
  overlap: number;
  /** The band's full height, so every tray is the same height as its siblings. */
  height: number;
  children: React.ReactNode;
}) {
  // NAME ON TOP. The verdict used to be a badge under the cards and nothing
  // else, so reading the hand meant decoding thirteen ranks — the one thing a
  // glance should not have to do. "SEQUENCE" over the cards is what a player
  // actually scans for; the points underneath are the consequence.
  const good = verdict && (verdict.type === 'pure' || verdict.type === 'impure' || verdict.type === 'set');
  const tone = loose ? white(0.75) : verdict?.type === 'pure' ? C.good : good ? C.gold2 : MELD_INK.bad;
  const title = loose ? 'UNGROUPED'
    : verdict?.type === 'pure' ? 'SEQUENCE'
    : verdict?.type === 'impure' ? 'SEQUENCE'
    : verdict?.type === 'set' ? 'SET'
    : verdict?.type === 'invalid' ? 'GROUP' : '';
  const ref = useRef<View>(null);
  return (
    <View
      ref={ref}
      // measureInWindow rather than the layout event's own x/y: the row sits
      // inside a horizontal ScrollView, so its parent-relative position says
      // nothing about where a finger actually lands on the glass. Re-fires on
      // every relayout, which is what keeps drop targets correct after a
      // rotation.
      onLayout={() => {
        ref.current?.measureInWindow((x, y, w, h) => onMeasure(index, { x, y, w, h }));
      }}
      accessibilityLabel={loose ? 'Ungrouped cards' : `Group ${index + 1}${verdict?.label ? `, ${verdict.label}` : ''}`}
      style={{
        minWidth: minW,
        height,
        justifyContent: 'space-between',
        borderRadius: R[2],
        borderWidth: 1,
        borderStyle: loose ? 'dashed' : 'solid',
        // LIGHT trays, not dark ones, and this is the one place on the felt
        // that breaks the dark-glass rule on purpose: cards are cream, and a
        // dark holder behind cream muddies their edges until the group stops
        // reading as a unit — which is the whole job of the tray. A valid meld
        // takes a green edge, so the badge under it is a confirmation rather
        // than the only signal.
        borderColor: loose ? white(0.35)
          : verdict && (verdict.type === 'pure' || verdict.type === 'impure' || verdict.type === 'set')
            ? 'rgba(99,230,160,0.55)'
            : white(0.55),
        backgroundColor: loose ? white(0.08) : white(0.22),
        boxShadow: `inset 0 1px 0 ${white(0.22)}`,
        paddingHorizontal: S[2], paddingTop: S[1], paddingBottom: 2,
        gap: 2,
      }}
    >
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.8}
        style={{ color: tone, fontSize: 9.5, fontWeight: '800', letterSpacing: 0.6, textAlign: 'center' }}
      >{title}</Text>

      {/* Cards overlap into a fan the way a held hand does — five groups of
          three at full width do not fit any phone.

          THE TUCK IS A NEGATIVE MARGIN, NOT A NEGATIVE GAP. `gap` is a Yoga
          gutter and, exactly as in CSS, may not be negative: the value is
          invalid and resolves to 0. So a negative gutter silently discarded the
          fan that fanFor() had computed and the hand laid out fully spread
          whatever the maths chose. Measured on the Redmi in landscape: cards
          stepped 149px against a 148px card — no overlap at all — where the
          model believed it had tucked 30px per card, and the thirteenth card
          sat outside the scroller. The model was right; the render threw it
          away. marginLeft is honoured, so the fan now actually happens. */}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', minHeight: 10 }}>
        {React.Children.map(children, (child, i) =>
          i === 0 ? child : <View style={{ marginLeft: -overlap }}>{child}</View>,
        )}
      </View>
      <View style={{ height: 14, justifyContent: 'center' }}>
        <MeldBadge verdict={verdict} loose={loose} />
      </View>
    </View>
  );
}

/** The group badge. Colour carries the same meaning as the label. */
function MeldBadge({ verdict, loose }: { verdict?: { type: MeldType; label: string }; loose?: boolean }) {
  if (loose) return <Text style={{ color: white(0.62), fontSize: 10, fontWeight: '700' }}>Ungrouped</Text>;
  if (!verdict || verdict.type === 'empty' || !verdict.label) return null;
  const good = verdict.type === 'pure' || verdict.type === 'impure' || verdict.type === 'set';
  const color = verdict.type === 'pure' ? MELD_INK.pure : good ? C.gold2 : MELD_INK.bad;
  return (
    <Text style={{ color, fontSize: 10, fontWeight: '800' }}>
      {good ? '✓' : '✗'} {verdict.label}
    </Text>
  );
}

/* ── piles ──────────────────────────────────────────────────────────── */

export function Pile({
  label: text, live, onPress, card, back, w, still,
}: { label: string; live: boolean; onPress: () => void; card?: Card | null; back?: boolean; w: number; still: boolean }) {
  const bob = useSharedValue(0);
  useEffect(() => {
    if (live && !still) {
      bob.value = withRepeat(withTiming(1, { duration: 800, easing: Easing.inOut(Easing.ease) }), -1, true);
    } else {
      cancelAnimation(bob);
      bob.value = withTiming(0, { duration: 160 });
    }
    return () => cancelAnimation(bob);
  }, [live, still, bob]);
  const a = useAnimatedStyle(() => ({ transform: [{ translateY: -bob.value * 3 }] }));

  return (
    <Pressable
      onPress={live ? onPress : undefined}
      disabled={!live}
      accessibilityRole="button"
      accessibilityLabel={back ? `Closed deck, ${text}` : card ? `${rummyCardName(card)}, ${text}` : text}
      style={{ alignItems: 'center', gap: 2 }}
    >
      <Animated.View style={a}>
        {back ? <CardBack live={live} w={w} /> : card ? <CardFace card={card} w={w} glow={live} /> : <EmptySlot w={w} />}
      </Animated.View>
      {/* On a navy plate, like DeckLabel: bare on the lit centre of the cloth
          this caption measured 3.3:1, under WCAG AA. On the plate it is 11:1. */}
      <View style={[onFelt('navy', { radius: R.pill, lift: 0 }), { paddingHorizontal: S[1] + 2 }]}>
        <Text style={{ color: INK_ON_FELT, fontSize: 10, fontWeight: '700' }}>{text}</Text>
      </View>
    </Pressable>
  );
}

/**
 * The open pile — draw source, and the one place a card may be dragged OUT of
 * the hand.
 *
 * It publishes its window rect so the drag can hit-test against it. `armed`
 * (you owe a discard) is what turns the outline gold; a card dropped here at
 * any other time springs back with a reason rather than being thrown away.
 */
export function DiscardPile({
  card, live, armed, w, onPress, onMeasure, still,
}: {
  card: Card | null;
  live: boolean;
  armed: boolean;
  w: number;
  onPress: () => void;
  onMeasure: (z: Zone) => void;
  still: boolean;
}) {
  const ref = useRef<View>(null);
  return (
    <View
      ref={ref}
      onLayout={() => { ref.current?.measureInWindow((x, y, wd, h) => onMeasure({ x, y, w: wd, h })); }}
      style={{
        borderRadius: R[2], padding: 3,
        borderWidth: armed ? 2 : 1,
        borderStyle: armed ? 'dashed' : 'solid',
        borderColor: armed ? C.gold : 'transparent',
      }}
    >
      <Pile
        label={armed ? 'Drop to discard' : 'Open'}
        live={live}
        onPress={onPress}
        card={card}
        w={w}
        still={still}
      />
    </View>
  );
}

function CardBack({ live, w }: { live: boolean; w: number }) {
  const h = Math.round(w * 1.4);
  return (
    <View style={{
      width: w, height: h, borderRadius: 6, overflow: 'hidden',
      borderWidth: 1, borderColor: CARD.edge,
      boxShadow: live
        ? `0 0 0 2px ${C.gold}, 0 0 16px rgba(232,194,95,0.55), 0 4px 10px rgba(0,0,0,0.5)`
        : '0 3px 9px rgba(0,0,0,0.55)',
    }}>
      <Svg width={w} height={h}>
        <Defs>
          <RadialGradient id="cardback" cx="50%" cy="30%" rx="80%" ry="80%">
            <Stop offset="0" stopColor={CARD.back[0]} />
            <Stop offset="1" stopColor={CARD.back[1]} />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width={w} height={h} fill="url(#cardback)" />
        {/* A crown, not eighteen diagonal lines. The stripes were a texture at
            any size; the mark reads at pile size AND at the 8dp the seat
            capsules draw a held hand at, which is where most backs appear. */}
        <SvgText
          x={w / 2} y={h / 2 + w * 0.16}
          textAnchor="middle" fontSize={Math.round(w * 0.42)} fill={CARD.edge} fillOpacity={0.9}
        >
          ♛
        </SvgText>
        <Rect x="3" y="3" width={Math.max(1, w - 6)} height={Math.max(1, h - 6)} rx="4" fill="none" stroke={CARD.backLine} strokeWidth="1.5" />
      </Svg>
    </View>
  );
}

function EmptySlot({ w }: { w: number }) {
  return (
    <View style={{
      width: w, height: Math.round(w * 1.4), borderRadius: 6,
      borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.35)',
    }} />
  );
}

export function CardFace({ card, w, glow, wild }: { card: Card; w: number; glow?: boolean; wild?: boolean }) {
  const h = Math.round(w * 1.4);
  const joker = card.suit === 'JOKER';
  const color = joker ? CARD.joker : RED.has(card.suit) ? CARD.red : CARD.ink;
  const idx = Math.round(w * 0.37);

  return (
    <View style={{
      width: w, height: h, borderRadius: 6,
      // Warm ivory, not white. A pure-white card on lit emerald reads as a
      // cut-out; card stock is warm and slightly absorbent, and that difference
      // is most of what makes a hand look like objects rather than rectangles.
      backgroundColor: joker ? CARD.jokerFace : CARD.face,
      borderWidth: 1, borderColor: wild ? C.gold : CARD.edge,
      boxShadow: wild ? CARD_SHADOW.wild(C.gold)
        : glow ? CARD_SHADOW.raised : CARD_SHADOW.rest,
      overflow: 'hidden',
    }}>
      {/* The shaded lower half of the paper — one flat overlay rather than a
          gradient library. It is what stops a card reading as a plain swatch,
          and it costs one View. */}
      <View pointerEvents="none" style={{
        position: 'absolute', left: 0, right: 0, bottom: 0, height: h * 0.55,
        backgroundColor: CARD.faceLow, opacity: 0.55,
      }} />
      {/* Card markings scale with the physical card, while HandCard retains its
          full spoken rank/suit. System font scaling must not crop a rank. */}
      <Svg width={w - 2} height={h - 2} viewBox={`0 0 ${w} ${h}`} pointerEvents="none">
        <Rect x="2" y="2" width={w - 4} height={h - 4} rx="4" fill="none" stroke={CARD.edge} strokeOpacity="0.25" />
        {[false, true].map(flipped => (
          <G key={String(flipped)} transform={flipped ? `rotate(180 ${w / 2} ${h / 2})` : undefined}>
            <SvgText x="4" y={idx + 2} fontSize={idx} fontWeight="800" fill={color}>{joker ? '★' : card.rank}</SvgText>
            {!joker && <SvgText x="4" y={idx * 1.72 + 2} fontSize={w * 0.24} fill={color}>{SUIT_GLYPH[card.suit]}</SvgText>}
          </G>
        ))}
        <SvgText x={w / 2} y={h / 2 + w * 0.17} textAnchor="middle" fontSize={w * 0.52} fill={color}>
          {joker ? '★' : SUIT_GLYPH[card.suit]}
        </SvgText>
      </Svg>
    </View>
  );
}

/* ── a draggable card ───────────────────────────────────────────────── */

/**
 * Tap to select, DRAG to re-group or to discard.
 *
 * Both gestures live on one card, which is why the pan needs a few pixels of
 * movement before it activates — without that threshold every tap becomes a
 * one-pixel drag and selection stops working entirely.
 *
 * The card springs home on release NO MATTER WHAT: its real position comes from
 * the new arrangement, so leaving it under the finger would double the move —
 * and it means an interrupted drag (a rotation, a backgrounded app) can never
 * strand a card off-screen.
 */
/**
 * MEMOISED. Each card owns four shared values, a Pan/Tap gesture pair and an
 * animated style, and rebuilding those is what re-rendering one of these costs
 * — thirteen times over, twice a second, because the turn clock sits at the top
 * of this screen and every tick re-rendered the whole hand to change one digit.
 *
 * `onPress` takes the card id rather than closing over it, which is the whole
 * reason the memo holds: `() => toggle(id)` would be a new function on every
 * render and defeat it. `toggle` and `dropAt` are already stable callbacks, and
 * `card` keeps its identity between server frames via the `byId` map.
 *
 * SCREEN READERS cannot drag, and on Android a double-tap reaches the view as
 * an accessibility action, not as a touch the Tap gesture would see. So the
 * card is one accessible element with an `activate` action (select, the same
 * `onPress` as a tap) and a `discard` action (the same path a drop on the open
 * pile takes, including its "take a card first" refusal). Moving cards between
 * groups already has a tap path: select them, then GROUP or UNGROUP.
 */
const CARD_ACTIONS = [
  { name: 'activate' as const, label: 'Select' },
  { name: 'discard', label: 'Discard this card' },
];

export const HandCard = React.memo(function HandCard({
  card, w, selected, wild, dimmed, group, onPress, onDrop, onDiscard,
}: {
  card: Card;
  w: number;
  selected: boolean;
  /** A printed joker, or a card of this round's wild rank. */
  wild: boolean;
  /** SHOW DEADWOOD is on and this card already melds, so it steps back. */
  dimmed?: boolean;
  /** The tray this card sits in, as spoken ("group 2, pure sequence"). */
  group?: string;
  onPress: (cardId: string) => void;
  onDrop: (cardId: string, x: number, y: number) => void;
  onDiscard: (cardId: string) => void;
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
      dx.value = withSpring(0, { damping: 18, stiffness: 260 });
      dy.value = withSpring(0, { damping: 18, stiffness: 260 });
    })
    .onFinalize(() => {
      dragging.value = 0;
      // Belt and braces: a gesture cancelled by a rotation or a system dialog
      // never reaches onEnd, and without this the card would stay where the
      // finger left it.
      dx.value = withSpring(0, { damping: 18, stiffness: 260 });
      dy.value = withSpring(0, { damping: 18, stiffness: 260 });
    });

  const tap = Gesture.Tap().onEnd((_e, ok) => { if (ok) runOnJS(onPress)(card.id); });
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
        accessible
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={rummyCardLabel(card, { wild, group })}
        accessibilityHint="Double tap to select. Select cards, then use Group, Ungroup, Discard or Declare."
        accessibilityActions={CARD_ACTIONS}
        onAccessibilityAction={e => {
          if (e.nativeEvent.actionName === 'activate') onPress(card.id);
          else if (e.nativeEvent.actionName === 'discard') onDiscard(card.id);
        }}
        style={[a, selected ? { borderRadius: 8, borderWidth: 2, borderColor: C.gold } : null,
          dimmed ? { opacity: 0.34 } : null]}
      >
        {/* A joker is marked ON THE CARD, not only beside the deck. The wild
            indicator by the closed pile says which RANK is wild this round; it
            does not tell you which of your own thirteen cards are the wild
            ones, and a player who cannot see that discards one. Every
            reference client highlights them in the hand. */}
        <CardFace card={card} w={w} glow={selected} wild={wild} />
      </Animated.View>
    </GestureDetector>
  );
});
