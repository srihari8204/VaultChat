// components/games/rummy/Felt.tsx — the table itself and what sits on it: the
// oval and the room behind it, the header's wordmark and kind tabs, the side
// panels, and the opponents' seats.
// Split out of components/games/Rummy.tsx; behaviour unchanged.

import React, { useEffect } from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import Svg, { Defs, RadialGradient, LinearGradient, Stop, Rect, Ellipse, Text as SvgText } from 'react-native-svg';
import Animated, {
  useSharedValue, useAnimatedStyle, withTiming, withRepeat,
  Easing, cancelAnimation,
} from 'react-native-reanimated';
import { playSfx } from '../../../lib/games/sfx';
import { seatContent, SEAT_NAME_LINE, SEAT_DETAIL_LINE, type KindFilter } from '../../../lib/games/rummyTable';
import { C, S, R, alpha, goldLine, white } from '../../../lib/games/theme';
import {
  FELT, RAIL, CARD, CYAN, INK as INK_ON_FELT, INK_DIM, onFelt, ROOM, ROOM_GLOW, TABLE_TOP, SEAT_AVATAR,
} from '../../../lib/games/rummyGlass';

/* ── the felt ───────────────────────────────────────────────────────── */

/**
 * The table.
 *
 * A real card-room table is not a green rectangle: it is cloth stretched INTO a
 * frame, so the eye reads a recess — brass cap, wood under it, a bevel where
 * the cloth drops away, and light falling from above the far seats. Everything
 * here serves that one impression, because depth is what makes the piles look
 * like objects lying ON something rather than stickers floating over a colour.
 *
 * Cheap by construction: one Svg, six shapes, no blur filters (React Native has
 * no cheap gaussian) — the bevel and the vignette are gradients, not shadows.
 */
export function TableTop({ width, height }: { width: number; height: number }) {
  const cx = width / 2;
  const cy = height / 2;
  const rx = Math.max(4, width / 2 - 2);
  const ry = Math.max(4, height / 2 - 2);
  // The rail is proportional, not a fixed 9px: on a small table a thick rail
  // eats the cloth, on a big one a thin one looks like a drawn line.
  const rail = Math.max(6, Math.min(18, Math.round(Math.min(rx, ry) * 0.055)));
  const irx = Math.max(2, rx - rail);
  const iry = Math.max(2, ry - rail);

  return (
    <Svg width={width} height={height} style={{ position: 'absolute' }} pointerEvents="none">
      <Defs>
        {/* Brass, lit from above: a hot cap at the top edge falling to a dark
            underside, which is what tells the eye the rail is round. */}
        <RadialGradient id="rtRail" cx="50%" cy="-10%" rx="75%" ry="110%">
          <Stop offset="0" stopColor={RAIL[0]} />
          <Stop offset="0.38" stopColor={RAIL[1]} />
          <Stop offset="0.74" stopColor={RAIL[2]} />
          <Stop offset="1" stopColor={RAIL[3]} />
        </RadialGradient>
        <LinearGradient id="rtGlass" x1="0%" y1="0%" x2="12%" y2="100%">
          <Stop offset="0" stopColor={TABLE_TOP.glass[0]} />
          <Stop offset="0.38" stopColor={TABLE_TOP.glass[1]} />
          <Stop offset="1" stopColor={TABLE_TOP.glass[2]} />
        </LinearGradient>
        <LinearGradient id="rtSheen" x1="0%" y1="0%" x2="65%" y2="100%">
          <Stop offset="0" stopColor={TABLE_TOP.sheen} stopOpacity="0.19" />
          <Stop offset="0.48" stopColor={TABLE_TOP.sheen} stopOpacity="0" />
          <Stop offset="1" stopColor={TABLE_TOP.sheenLow} stopOpacity="0.3" />
        </LinearGradient>
        {/* Cloth. The light sits high and slightly back, so the near edge —
            where the player's own hand is — falls into shadow and the middle of
            the table, where the piles are, is the brightest thing on screen.
            Reads FELT (above) rather than repeating its three hexes here — this
            was still the old GREEN, the documented "TEAL rather than wine" swap
            had never actually reached the gradient that paints the table. */}
        <RadialGradient id="rtCloth" cx="50%" cy="26%" rx="78%" ry="86%">
          <Stop offset="0" stopColor={FELT[0]} />
          <Stop offset="0.55" stopColor={FELT[1]} />
          <Stop offset="1" stopColor={FELT[2]} />
        </RadialGradient>
        {/* The drop where cloth meets frame: dark at the rim, gone by 12%. */}
        <RadialGradient id="rtBevel" cx="50%" cy="50%" rx="50%" ry="50%">
          <Stop offset="0.86" stopColor={TABLE_TOP.bevel} stopOpacity="0" />
          <Stop offset="1" stopColor={TABLE_TOP.bevel} stopOpacity="0.55" />
        </RadialGradient>
      </Defs>

      <Ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="url(#rtGlass)" stroke={TABLE_TOP.rimLine} strokeOpacity="0.36" />
      <Ellipse cx={cx} cy={cy} rx={rx - rail * 0.48} ry={ry - rail * 0.48} fill="none" stroke="url(#rtRail)" strokeWidth="1.5" opacity="0.8" />
      <Ellipse cx={cx} cy={cy} rx={irx} ry={iry} fill="url(#rtCloth)" />
      <Ellipse cx={cx} cy={cy} rx={irx} ry={iry} fill="url(#rtBevel)" />
      <Ellipse cx={cx} cy={cy} rx={irx} ry={iry} fill="url(#rtSheen)" />
      <Ellipse cx={cx} cy={cy} rx={Math.max(1, irx - rail)} ry={Math.max(1, iry - rail)}
        fill="none" stroke={TABLE_TOP.rimLine} strokeOpacity="0.13" strokeWidth="1" strokeDasharray="2 5" />

      {/* Quiet suit medallions give the cloth a card-room identity without assets. */}
      {['♠', '♥', '♦', '♣'].map((suit, index) => (
        <SvgText key={suit} x={cx + (index - 1.5) * irx * 0.16} y={cy + iry * 0.55}
          textAnchor="middle" fontSize={Math.min(20, iry * 0.22)} fill={TABLE_TOP.suits} fillOpacity="0.14">
          {suit}
        </SvgText>
      ))}

      {/* A single bright hairline along the top of the cloth: the specular line
          every stretched surface has, and the cheapest way to say "taut". */}
      <Ellipse
        cx={cx} cy={cy} rx={irx} ry={iry}
        fill="none" stroke={CYAN} strokeOpacity="0.22" strokeWidth="1.5"
      />

      {/* The house mark, printed into the cloth. Every real card-room table
          carries one and it is always nearly invisible — it sits UNDER the
          cards and must never compete with a rank pip. Low opacity and wide
          tracking do that; a logo you notice mid-hand is a logo in the way. */}
      <SvgText
        x={cx} y={cy - iry * 0.02}
        textAnchor="middle"
        fontSize={Math.max(16, Math.round(irx * 0.15))}
        fontWeight="800"
        fill={TABLE_TOP.houseMark}
        fillOpacity={0.075}
      >
        CRAZZYCHAT
      </SvgText>
      <SvgText
        x={cx} y={cy + Math.max(13, Math.round(irx * 0.105))}
        textAnchor="middle"
        fontSize={Math.max(9, Math.round(irx * 0.06))}
        fontWeight="700"
        fill={TABLE_TOP.houseSub}
        fillOpacity={0.16}
      >
        RUMMY
      </SvgText>
    </Svg>
  );
}

/**
 * The surround behind the table.
 *
 * Deliberately NOT more felt: it is the dark of the room, so the lit table is
 * the only thing the eye lands on. A brass hairline at the very top keeps it
 * tied to the rail rather than reading as a separate black band.
 */
/**
 * AUTO-FIT, not window-sized.
 *
 * This took `win.width`/`win.height` and painted itself at WINDOW size while
 * everything else on the table measures its own container. Those two are not
 * the same number — this file's own notes record a container of 851 against a
 * window of 823 — so the cloth fell short of the box it is meant to fill and
 * left an unpainted strip at one edge, which on a full-bleed surface reads as
 * the table being broken.
 *
 * `absoluteFill` plus percentage rects means it is sized BY its parent instead
 * of guessing at it: no window read, no orientation special case, and it stays
 * correct through a rotation without recomputing anything. Same pattern
 * TableBackground already uses in ui.tsx.
 */
export function Baize() {
  return (
    <Svg style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} pointerEvents="none">
      <Defs>
        {/* The room. Warm, and lit from two sides — see ROOM/ROOM_GLOW. It was a
            flat maroon near-black, which left the cloth as the only lit thing on
            screen and the brass rail with nothing to catch. */}
        <RadialGradient id="rbaize" cx="50%" cy="18%" rx="95%" ry="100%">
          <Stop offset="0" stopColor={ROOM[0]} />
          <Stop offset="0.5" stopColor={ROOM[1]} />
          <Stop offset="1" stopColor={ROOM[2]} />
        </RadialGradient>
        {ROOM_GLOW.map((g, i) => (
          <RadialGradient key={i} id={`rglow${i}`} cx={g.cx} cy={g.cy} rx={g.rx} ry={g.ry}>
            <Stop offset="0" stopColor={g.color} stopOpacity={g.opacity} />
            <Stop offset="1" stopColor={g.color} stopOpacity={0} />
          </RadialGradient>
        ))}
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill="url(#rbaize)" />
      {ROOM_GLOW.map((_, i) => (
        <Rect key={i} x="0" y="0" width="100%" height="100%" fill={`url(#rglow${i})`} />
      ))}
      {/* One gold hairline ties the surround to the rail. Kept thin and at low
          opacity: this is trim, not an accent, and the accent budget belongs to
          the primary action. */}
      <Rect x="0" y="0" width="100%" height="1.5" fill={C.gold} opacity="0.4" />
    </Svg>
  );
}

/** Names a stack the way a table does — small caps on a dark plate. */
export function DeckLabel({ text }: { text: string }) {
  return (
    <View style={[onFelt('navy', { radius: R.pill, lift: 0 }), { paddingHorizontal: S[2], paddingVertical: 2 }]}>
      <Text style={{ color: INK_ON_FELT, fontSize: 9.5, fontWeight: '800', letterSpacing: 0.8 }}>{text}</Text>
    </View>
  );
}

/** The house mark. Small, and the only branding on the screen. */
export function Wordmark() {
  return (
    // Decorative branding: hidden from screen readers, which already hear the
    // game's name from the top bar.
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[onFelt('navy', { radius: 9 }), { paddingHorizontal: S[2], paddingVertical: 2, alignItems: 'center' }]}>
      <Text style={{ color: C.gold2, fontSize: 8, lineHeight: 9 }}>♛</Text>
      <Text style={{ color: INK_ON_FELT, fontSize: 10, fontWeight: '800', letterSpacing: 1 }}>RUMMY</Text>
      <Text style={{ color: C.gold, opacity: 0.8, fontSize: 8, lineHeight: 9.5, fontWeight: '800', letterSpacing: 0.6 }}>PLAY SMART</Text>
    </View>
  );
}

/**
 * Practice · Free · Bots, at the table.
 *
 * These CANNOT switch table by themselves — you are sitting at a hand, and the
 * protocol has no way to move a seated player. So the tab that is not current
 * asks to leave, and carries the choice into the table list. A tab that
 * silently forfeited the round would be worse than no tab at all.
 */
export function KindTabs({ current, onPick }: { current: KindFilter; onPick: (k: KindFilter) => void }) {
  const tabs: { k: KindFilter; label: string }[] = [
    { k: 'practice', label: 'Practice' },
    { k: 'stakes', label: 'Free' },
    { k: 'bots', label: 'Bots' },
  ];
  return (
    <View style={[onFelt('navy', { radius: R.pill, lift: 0 }), { flexDirection: 'row', padding: 2 }]}>
      {tabs.map(t => {
        const on = t.k === current;
        return (
          <Pressable
            key={t.k}
            onPress={() => { void playSfx('select'); onPick(t.k); }}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={on ? `${t.label} table — you are here` : `Leave and find a ${t.label} table`}
            hitSlop={6}
            style={{
              paddingHorizontal: S[3], paddingVertical: 3, borderRadius: R.pill,
              borderWidth: 1, borderColor: on ? goldLine[38] : 'transparent',
              backgroundColor: on ? alpha(C.gold, 0.14) : 'transparent',
            }}
          >
            <Text style={{ color: on ? C.gold2 : INK_DIM, fontSize: 10.5, fontWeight: on ? '800' : '600' }}>
              {t.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The table, in the three facts a player actually asks for.
 *
 * Every one is the server's: the table's own name and stakes string, and the
 * seat count from `players`. Nothing here is computed or guessed.
 */
export function TablePanel({
  name, stakes, seated, max, width,
}: { name?: string; stakes?: string; seated: number; max: number; width: number }) {
  const rows: [string, string][] = [
    ['Table:', name || 'Rummy'],
    ['Players:', `${seated} / ${max}`],
    ['Stakes:', stakes || '—'],
  ];
  return (
    <View style={[
      onFelt('navy', { radius: 14, lift: 2 }),
      { position: 'absolute', left: S[1], top: '28%', width: Math.max(88, width), padding: S[2], gap: 5 },
    ]}>
      {rows.map(([k, v]) => (
        // One stop per fact ("Players: 3 / 6"), not a key and a value read apart.
        <View key={k} accessible accessibilityLabel={`${k} ${v}`}>
          {/* 10.5 where it fits; the shrink floor (8.4) is still above the old 9.5 × 0.8. */}
          <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={{ color: INK_DIM, fontSize: 10.5, fontWeight: '800', letterSpacing: 0.3 }}>{k}</Text>
          <Text numberOfLines={1} style={{ color: INK_ON_FELT, fontSize: 11, fontWeight: '800' }}>{v}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The last thing anyone said, and the way to say something back.
 *
 * The bubbles are the tail of the SAME feed the toasts render — server events
 * and this screen's own refusals — so nothing is stored twice and nothing is
 * invented. The button opens the emote sheet, which sends `emote{emoji}`.
 */
export function EmoteFeed({
  feed, width, left, onOpen,
}: { feed: string[]; width: number; left: number; onOpen: () => void }) {
  const last = feed.slice(-2);
  return (
    <View style={[
      onFelt('navy', { radius: 14, lift: 2 }),
      { position: 'absolute', left, top: '34%', width: Math.max(88, width), padding: S[2], gap: 4 },
    ]}>
      {last.length === 0 ? (
        <Text style={{ color: INK_DIM, fontSize: 9.5 }}>Say hello</Text>
      ) : last.map((msg, i) => (
        <View key={i} style={{ borderRadius: 10, paddingHorizontal: S[2], paddingVertical: 3, backgroundColor: white(0.10) }}>
          <Text numberOfLines={2} style={{ color: INK_ON_FELT, fontSize: 9 }}>{msg}</Text>
        </View>
      ))}
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel="Say something"
        hitSlop={8}
        style={{ alignSelf: 'flex-end', paddingHorizontal: S[2], paddingVertical: 2, borderRadius: R.pill, backgroundColor: white(0.12) }}
      >
        <Text style={{ color: INK_ON_FELT, fontSize: 9, fontWeight: '800' }}>•••</Text>
      </Pressable>
    </View>
  );
}

/* ── seats ──────────────────────────────────────────────────────────── */

/**
 * One opponent, placed by rummyTable.seatSpots.
 *
 * `status` is the server's — 'active' | 'won' | 'dropped' | 'lost' — and it is
 * what says whether this player is still in the hand. Reading a `dropped` flag
 * that the server does not send (as this screen used to) means a player who
 * dropped goes on looking like they are still holding cards.
 */
export function Seat({
  spot, name, count, points, status, bot, host, turn, talking, still, secs,
}: {
  spot?: { x: number; y: number; w: number; h: number };
  name: string;
  count: number;
  points?: number | null;
  status: string;
  bot: boolean;
  /** Whoever deals. The server sends no dealer, so this is the lobby's host. */
  host: boolean;
  turn: boolean;
  talking: boolean;
  still: boolean;
  /** Seconds left on THIS player's turn. Only ever passed to the one playing. */
  secs: number | null;
}) {
  const { fontScale } = useWindowDimensions();
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (turn && !still) {
      pulse.value = withRepeat(withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.ease) }), -1, true);
    } else {
      cancelAnimation(pulse);
      pulse.value = withTiming(0, { duration: 160 });
    }
    return () => cancelAnimation(pulse);
  }, [turn, still, pulse]);
  // The whole capsule breathes rather than a ring spinning around the avatar.
  // A 3.4s rotation on five seats was five continuously-animating views on a
  // screen that also animates thirteen cards; opacity on one border is one
  // interpolation and reads as "live" just as clearly.
  const ring = useAnimatedStyle(() => ({ opacity: 0.55 + pulse.value * 0.45 }));

  if (!spot) return null;
  const out = status !== 'active' && status !== 'won';

  // THE AVATAR IS THE LEFTOVERS, and that is the whole trick. rummyTable owns
  // the budget (SEAT_CHROME_H) and hands back what is left after the padding,
  // the two line boxes and the gaps between them have been paid for. The old
  // seat guessed at this — `Math.min(28, h - 20)` for chrome that cost 30 —
  // and every capsule overflowed its own border by 12 to 18dp, painting the
  // card-back row onto bare felt outside the gold turn ring.
  const layout = seatContent(spot.h, fontScale);
  const av = layout.avatar;
  const initials = name.split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase();

  // The line under the name. The card count is NOT here — it is the badge on
  // the avatar — so this is free to carry the number that actually decides the
  // hand. On a staked table that is points, and the old row-based seat
  // ellipsised them away at every phone width.
  const detail =
    status === 'won' ? 'WON'
    : status === 'dropped' ? 'DROPPED'
    : status === 'lost' ? `${points ?? 0} pts`
    : points != null ? `${points} pts`
    : `${count} cards`;

  const showCount = count > 0 && !out;

  return (
    <Animated.View
      // One stop per seat; without `accessible` iOS ignores this label.
      accessible
      accessibilityLabel={`${name}, ${detail}${showCount ? `, ${count} cards` : ''}${turn ? `, playing now${secs != null ? `, ${secs} seconds left` : ''}` : ''}${talking ? ', talking' : ''}${host ? ', host' : ''}`}
      style={[
        onFelt(turn ? 'gold' : 'navy', { radius: 16, active: turn }),
        {
          position: 'absolute', left: spot.x, top: spot.y, width: spot.w, height: spot.h,
          paddingHorizontal: 6, paddingVertical: 5,
          flexDirection: layout.inline ? 'row' : 'column',
          justifyContent: 'center', alignItems: 'center', opacity: out ? 0.7 : 1,
          backgroundColor: turn ? 'rgba(45,35,11,0.96)' : 'rgba(7,25,36,0.94)',
          borderColor: turn ? C.gold : 'rgba(170,232,213,0.30)',
        },
      ]}
    >
      {turn && (
        <Animated.View
          pointerEvents="none"
          style={[{ position: 'absolute', inset: -1, borderRadius: 17, borderWidth: 1.5, borderColor: C.gold }, ring]}
        />
      )}

      {/* the player */}
      <View style={{ width: av, height: av }}>
        <View style={{
          width: av, height: av, borderRadius: av / 2, alignItems: 'center', justifyContent: 'center',
          backgroundColor: bot ? SEAT_AVATAR.bot : SEAT_AVATAR.human,
          // One ring, three meanings, in priority order: talking beats host,
          // because who is speaking changes second by second and who deals does
          // not. A seat with neither has no ring at all — five glowing avatars
          // is the same as none.
          borderWidth: (talking || host) ? 2 : 1,
          borderColor: talking ? C.good : host ? C.gold2 : 'rgba(199,242,225,0.38)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.20)',
        }}>
          {bot
            ? <Ionicons name="hardware-chip-outline" size={Math.round(av * 0.52)} color={SEAT_AVATAR.botIcon} />
            : <Svg width={av} height={av} pointerEvents="none"><SvgText x={av / 2} y={av * 0.65} textAnchor="middle" fontWeight="800" fontSize={av * 0.38} fill={SEAT_AVATAR.initials}>{initials}</SvgText></Svg>}
        </View>

        {/* HOW MANY CARDS THEY HOLD, as a badge rather than a row.
            It used to be up to five little card backs on a third row, which is
            what pushed the capsule past its own height — and five drawn backs
            cannot show the difference between six cards and thirteen anyway,
            because they capped at five. A number is smaller AND says more. */}
        {showCount && !layout.inline && (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute', right: -5, bottom: -3,
              minWidth: 15, height: 14, borderRadius: 7, paddingHorizontal: 3,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: 'rgba(8,14,26,0.92)',
              borderWidth: 1, borderColor: alpha(CARD.edge, 0.55),
            }}>
            <Svg width={17} height={12}><SvgText x="8.5" y="10" textAnchor="middle" fontSize="10" fontWeight="800" fill={INK_ON_FELT}>{count}</SvgText></Svg>
          </View>
        )}

        {/* Still in the hand, out of it, or the winner. Opposite the count so
            the two badges never sit on each other. */}
        <View
          pointerEvents="none"
          style={{
            position: 'absolute', right: -1, top: -1,
            width: 8, height: 8, borderRadius: 4,
            borderWidth: 1, borderColor: 'rgba(0,0,0,0.45)',
            backgroundColor: out ? SEAT_AVATAR.out : status === 'won' ? C.gold : C.good,
          }}
        />
      </View>

      {/* their name — the FULL width of the capsule, which is the point of
          standing the seat up. It was 22dp on a 732dp table before. */}
      <Text
        numberOfLines={1}
        style={{
          width: layout.inline ? undefined : '100%', flexShrink: 1,
          marginLeft: layout.inline ? 4 : 0, marginTop: layout.inline ? 0 : 3, textAlign: 'center',
          color: SEAT_AVATAR.name, fontWeight: '900', fontSize: 12.5, lineHeight: SEAT_NAME_LINE,
        }}
      >{name}</Text>

      {/* the clock while they are playing, otherwise the server's line.
          DROPPED ENTIRELY on a felt too short to hold it — see seatHasDetail.
          Rendering it anyway is what the old seat did with its third row, and
          the row ended up painted on the cloth below the capsule's border. */}
      {layout.detail && (
        <Text
          numberOfLines={1}
          style={{
            width: '100%', marginTop: 2, textAlign: 'center',
            fontSize: 10, lineHeight: SEAT_DETAIL_LINE, fontWeight: turn ? '800' : '700',
            color: turn && secs != null ? C.gold2 : INK_DIM,
          }}
        >{turn ? (secs != null ? `TURN · ${secs}s` : 'PLAYING') : detail}</Text>
      )}
      {turn && <View pointerEvents="none" style={{ position: 'absolute', bottom: 1, left: '25%', right: '25%', height: 2, borderRadius: 1, backgroundColor: C.gold2 }} />}
    </Animated.View>
  );
}
