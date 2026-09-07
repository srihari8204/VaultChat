// lib/games/ludoGlass.selftest.ts — the Ludo restyle must not move the board.
//
//   npx tsx lib/games/ludoGlass.selftest.ts
//
// This was a UI-ONLY change to a server-refereed game, so the checks worth
// having are not "does the token module export a red". They are the three ways
// a restyle of this file could break the game while looking correct:
//
//   1. by moving the geometry, which is a contract with go-server (the tables
//      in Ludo.tsx must byte-match games-web/ludo.js and the Go referee);
//   2. by shrinking a touch target below 44dp, which uiautomator CANNOT see
//      because it does not report hitSlop — so it has to be read in SOURCE;
//   3. by raising a surface's alpha until the ink on it drops under WCAG AA,
//      which is exactly the regression the last glass restyle shipped and had
//      to fix afterwards.
//
// Contrast is COMPUTED here rather than eyeballed, for the same reason: on this
// device family FLAG_SECURE blanks `screencap`, so arithmetic over a known
// alpha and a known ground is the only evidence available without a human
// holding a camera.

import { readFileSync } from 'fs';
import { join } from 'path';
import { LR, LR_AMBIENT, LR_STAGE, SEAT, SHAPE, COLOR_NAMES, P, PL, PD, LG, PAWN, PAWN_BODY, PAWN_BASE, seatA } from './ludoGlass';

// theme.ts is NOT imported: it pulls in react-native for Platform.select, which
// tsx cannot transform, and importing it here would make this whole file
// unrunnable. The one value needed from it is read out of the source instead —
// which is stricter anyway, since it proves the literal in theme.ts matches
// rather than that two modules agree at runtime.

let failed = 0;
function A(ok: boolean, what: string): void {
  if (ok) { console.log('  ok   ' + what); return; }
  failed++;
  console.log('  FAIL ' + what);
}

const src = readFileSync(join(__dirname, '..', '..', 'components', 'games', 'Ludo.tsx'), 'utf8');
const themeSrc = readFileSync(join(__dirname, 'theme.ts'), 'utf8');
const accentLudo = themeSrc.match(/\bludo:\s*'(#[0-9A-Fa-f]{6})'/)?.[1] ?? '';

console.log('\nLudo glass\n');

/* ── 1. the geometry contract ────────────────────────────────────────── */
{
  // These tables are copied from the reference client and the Go referee. A
  // restyle has no business touching them, and a second invented mapping puts
  // tokens on the wrong squares for the same authoritative state — a bug that
  // looks like a server fault and is not.
  const ring = src.match(/const RING: \[number, number\]\[\] = \[([\s\S]*?)\n\];/);
  A(!!ring, '1a. RING is still declared in Ludo.tsx');
  const pairs = ring ? (ring[1].match(/\[\s*\d+\s*,\s*\d+\s*\]/g) ?? []) : [];
  A(pairs.length === 52, `1b. RING still has exactly 52 cells (got ${pairs.length})`);

  A(/const START_OFFSET = \[0, 13, 26, 39\];/.test(src),
    '1c. START_OFFSET is unchanged');
  A(/const HOME_STEP = 56;/.test(src),
    '1d. HOME_STEP is still 56 — the server\'s token encoding');
  A(/const CENTER_RC: \[number, number\] = \[7, 7\];/.test(src),
    '1e. the centre is still [7,7]');
  A(/const SAFE = new Set\(\[0, 8, 13, 21, 26, 34, 39, 47\]\);/.test(src),
    '1f. the safe set is unchanged');
  A(/const YARD_RC: \[number, number\]\[\] = \[\[0, 0\], \[0, 9\], \[9, 9\], \[9, 0\]\];/.test(src),
    '1g. yard corners are unchanged — seat 0 top-left through seat 3 bottom-left');

  // coord() is total by construction, and it must stay that way: every lookup
  // is indexed by data off the wire, and returning undefined for an unexpected
  // seat crashes the board at the destructure.
  A(/function coord\(corner: number, tokenIdx: number, step: number\): \[number, number\]/.test(src),
    '1h. coord() still returns a total [row,col]');
  A(/if \(s < 0\) return BASE_SPOTS\[c\]\[i\];/.test(src),
    '1i. ...base');
  A(/if \(s <= 50\) return RING\[\(START_OFFSET\[c\] \+ s\) % 52\];/.test(src),
    '1j. ...ring');
  A(/if \(s >= HOME_STEP\) return CENTER_RC;/.test(src),
    '1k. ...home');

  // The board is drawn in grid units, so the cell size is the only bridge
  // between the tables above and pixels. Changing it is changing the geometry.
  A(/const cell = size \/ 15;/.test(src), '1l. cell is still size / 15');
  A(/viewBox="0 0 15 15"/.test(src), '1m. the board SVG is still a 15x15 viewBox');
}

/* ── 2. the game still decides, not the presentation ─────────────────── */
{
  // A tap is a membership test against the server's list. If a restyle ever
  // introduced a local legality rule, this is where it would show up.
  A(/movable=\{canMove && pid\(p\) === state\.you && movable\.includes\(i\)\}/.test(src),
    '2a. a token is movable iff the server says so');
  A(/send\(\{ t: 'move', tokenIndex: i \}\)/.test(src),
    '2b. tapping a token still sends `move`');
  A(/send\(\{ t: 'roll', clientSeed: cs \}\)/.test(src),
    '2c. rolling still sends `roll` with a client seed');
  A(/const canRoll = mine && die == null && !finished;/.test(src),
    '2d. canRoll is unchanged');
  A(/const canMove = mine && die != null && movable\.length > 0;/.test(src),
    '2e. canMove is unchanged');

  // The tumbling face is deliberately meaningless and the server's number
  // replaces it. A restyle must not start showing a result the player has not
  // seen arrive, and must not invent one at all.
  A(/const face = tumbling \? flicker : \(value \?\? 6\);/.test(src),
    '2f. the die shows the server\'s value, never a locally rolled one');
  A(!/Math\.random\(\)/.test(src.replace(/setFlicker\(1 \+ Math\.floor\(Math\.random\(\) \* 6\)\)/, '')),
    '2g. the only Math.random left is the tumble flicker');
}

/* ── 3. touch targets — uiautomator cannot see these ─────────────────── */
{
  // A ludo board is fifteen cells across, so a token is ~19dp however big the
  // board gets. The token cannot grow without the board lying about where
  // pieces sit, so the TOUCH area grows instead.
  A(/hitSlop=\{Math\.max\(6, Math\.ceil\(\(44 - d\) \/ 2\)\)\}/.test(src),
    '3a. the token still pads its touch area out to 44dp');
  A(/const d = cell \* 0\.78;/.test(src),
    '3b. ...and the token itself is still cell * 0.78, not grown to cheat it');

  // 44dp is checked against the DRAWN diameter across the board sizes boardFit
  // can actually produce, so a smaller board cannot quietly fall under it.
  for (const size of [200, 290, 310, 328, 358, 398, 460, 600]) {
    const d = (size / 15) * 0.78;
    const slop = Math.max(6, Math.ceil((44 - d) / 2));
    A(d + slop * 2 >= 44, `3c. board ${size}: token ${d.toFixed(1)}dp + slop reaches ${(d + slop * 2).toFixed(1)}dp`);
  }
}

/* ── 4. the layout still measures, and still budgets 400 ─────────────── */
{
  // The measured branch subtracts NO insets — taking the inset off a second
  // time IS the 76px centring bug. The hook owns that; the board only has to
  // keep using it, and keep passing the chrome it was designed against.
  A(/const \{ size, onLayout: onBoardBox \} = useBoardBox\(400\);/.test(src),
    '4a. Ludo still sizes with useBoardBox(400)');
  A(/onLayout=\{onBoardBox\}/.test(src),
    '4b. ...and actually wires onLayout, or the hook never measures');
  A(/usePortraitLock\(\);/.test(src),
    '4c. the board still asserts portrait on mount');

  // The Figma reflow put the non-board rows at 390dp on all three artboards.
  // 400 is the budget with 10dp of headroom; the ScrollView absorbs the rest.
  const CHROME = 390;
  for (const [w, h, it, ib, want] of [
    [360, 780, 24, 16, 328],
    [390, 844, 47, 34, 358],
    [430, 932, 59, 34, 398],
  ] as const) {
    const board = Math.min(w - 32, h - it - ib - 400);
    A(board === want, `4d. ${w}x${h}: boardFit(chrome 400) gives ${board}, design drew ${want}`);
    A(board + CHROME <= h - it - ib,
      `4e. ${w}x${h}: board ${board} + chrome ${CHROME} fits ${h - it - ib} usable`);
  }
}

/* ── 5. accessibility must survive a restyle ─────────────────────────── */
{
  A(SHAPE.length === 4 && new Set(SHAPE).size === 4,
    '5a. four distinct shape markers — the deuteranopia fallback');
  A(/\{SHAPE\[seat\]\}/.test(src), '5b. the pawn still carries its shape marker');
  A(/\{SHAPE\[player\.seat\]\}/.test(src), '5c. ...and so does the seat card');
  A(/accessibilityLabel=\{`\$\{COLOR_NAMES\[seat\]\} token \$\{index \+ 1\}\$\{movable \? ', can move' : ''\}`\}/.test(src),
    '5d. the token label still names the colour, the index and whether it can move');
  A(/accessibilityLabel=\{tumbling \? 'Rolling the dice' : value == null \? 'Dice, not rolled' : `Dice showing \$\{value\}`\}/.test(src),
    '5e. the die still announces its real state');
  A(COLOR_NAMES.length === 4, '5f. four colour names, for the labels above');
}

/* ── 6. contrast, computed rather than eyeballed ─────────────────────── */
{
  const rgb = (h: string): [number, number, number] => {
    const s = h.replace('#', '');
    return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16)) as [number, number, number];
  };
  /** sRGB relative luminance. */
  const lum = (c: [number, number, number]) => {
    const [r, g, b] = c.map(v => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  /** White at alpha `a` over `ground` — what a glass surface actually is. */
  const over = (a: number, ground: string): [number, number, number] =>
    rgb(ground).map(v => Math.round(255 * a + v * (1 - a))) as [number, number, number];
  const ratio = (fg: string, bg: [number, number, number]) => {
    const [l1, l2] = [lum(rgb(fg)), lum(bg)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  };

  // Surfaces composite over the LIT room, not over LR.bg — LR.bg is a colour
  // no pixel on a real screen is. Using the unlit ground here would report
  // contrast that is better than what ships.
  for (const [name, alpha] of [
    ['seat card (rest)',   LG.card],
    ['seat card (active)', LG.cardActive],
    ['fairness CTA',       LG.ctaQuiet],
    ['board pane',         LG.pane],
  ] as const) {
    const bg = over(alpha, LR.lit);
    const r = ratio(LR.muted, bg);
    A(r >= 4.5, `6a. LR.muted on ${name}: ${r.toFixed(2)}:1 (AA needs 4.5)`);
    const rt = ratio(LR.text, bg);
    A(rt >= 4.5, `6b. LR.text on ${name}: ${rt.toFixed(2)}:1`);
  }

  // The status word on the active seat is LR.ok, and the four seat accents
  // carry UI edges — 3.0 is the floor for large text and non-text indicators.
  const active = over(LG.cardActive, LR.lit);
  A(ratio(LR.ok, active) >= 3, `6c. LR.ok on the active seat: ${ratio(LR.ok, active).toFixed(2)}:1`);
  for (let s = 0; s < 4; s++) {
    const r = ratio(SEAT[s].light, active);
    A(r >= 3, `6d. SEAT[${s}].light as an edge on glass: ${r.toFixed(2)}:1`);
  }

  // The CTA is a light surface, so its ink has to be dark.
  A(ratio(LR.onGold, rgb(SEAT[2].base) as [number, number, number]) >= 4.5,
    `6e. LR.onGold on the gold CTA: ${ratio(LR.onGold, rgb(SEAT[2].base) as [number, number, number]).toFixed(2)}:1`);
}

/* ── 7. one accent source ────────────────────────────────────────────── */
{
  // The hub card, the board and the banner all read ACCENT[kind]. Seat 2 IS
  // that colour, so restating a near-miss here is how the hub and the board
  // drifted apart last time.
  A(!!accentLudo, '7a. ACCENT.ludo is readable out of theme.ts');
  A(SEAT[2].base.toUpperCase() === accentLudo.toUpperCase(),
    `7a'. SEAT[2].base === ACCENT.ludo (${SEAT[2].base} vs ${accentLudo})`);
  A(SEAT.length === 4 && P.length === 4 && PL.length === 4 && PD.length === 4,
    '7b. four seats, and the flat lists agree');
  A(new Set(P).size === 4, '7c. the four seat colours are distinct');

  // Ludo.tsx must not carry its own copy of the palette any more.
  A(!/^const P {2}= \['#/m.test(src), '7d. Ludo.tsx no longer declares its own P');
  A(!/^const SHAPE = \[/m.test(src), '7e. ...nor its own SHAPE');
  A(/from '\.\.\/\.\.\/lib\/games\/ludoGlass'/.test(src),
    '7f. ...it reads them from ludoGlass');

  A(seatA(1, 'base', 0.5) === 'rgba(62, 232, 155, 0.5)', '7g. seatA composes an rgba from the seat hex');
  A(seatA(99, 'base', 1) === seatA(0, 'base', 1), '7h. seatA is total for an out-of-range seat');
}

/* ── 8. the room is lit, or the glass is pointless ───────────────────── */
{
  A(LR_AMBIENT.length === 4, '8a. four ambient glows');
  A(LR_AMBIENT.every(g => g.opacity > 0.1),
    '8b. every glow is strong enough to tint a surface');
  A(LR_STAGE.scale > 1, '8c. the stage light is wider than the board it lights');
  A(LR_STAGE.stops[LR_STAGE.stops.length - 1].opacity === 0,
    '8d. ...and falls to zero, so it reads as light and not as a drawn circle');
  A(LR_STAGE.stops.length >= 4,
    '8e. ...over enough stops to avoid the hard ring a two-stop falloff leaves');

  // No BlurView. Same call as theme.ts and rummyGlass.ts, and it is a
  // per-frame cost on a board that animates sixteen tokens.
  A(!/BlurView/.test(src), '8f. no BlurView on the board');
}

/* ── 9. one palette on the screen ────────────────────────────────────── */
{
  // The restyle half-landed once: the board was midnight and the lobby, the
  // sheets and the receipts were still on the shared maroon-era ink, so one
  // screen carried two palettes. Ludo reads its INK from ludoGlass and its
  // GRID (S / R / D3) from theme — mixing those up is the regression.
  A(!/\bC\.(text|muted|gold|gold2|goldDeep|bg|panel|line)\b/.test(src),
    '9a. no shared-palette colours left in Ludo.tsx');
  A(!/\bgoldLine\[/.test(src), '9b. ...and no shared gold hairline');
  A(/import \{ S, R, D3, white \} from '\.\.\/\.\.\/lib\/games\/theme'/.test(src),
    '9c. spacing, radii and elevation are still SHARED — only the light is local');
}

/* ── 10. the action bar, and the voice control behind it ─────────────── */
{
  // The design is a single four-up bar. The full VoiceBar is three controls
  // wide on its own and cannot share a line, so the table uses a compact
  // control that opens VoiceSheet — the pattern Chess already uses.
  A(/label="Talk at the table"/.test(src), '10a. the table has a voice control');
  A(/<VoiceSheet/.test(src), '10b. ...and it opens the real VoiceSheet, so it is not a dead button');
  A(/onPress=\{\(\) => setShowVoice\(true\)\}/.test(src), '10c. ...wired to it');
  A(/visible=\{showVoice\}/.test(src) && /voice=\{voice\}/.test(src),
    '10d. ...driving the SAME voice object the bar drove — no second voice state');

  // The lobby keeps the full bar: there is room for it there, and it is the
  // moment a player most wants the detail.
  A(/<VoiceBar/.test(src), '10e. the lobby still renders the full VoiceBar');

  // Four controls on the row, and the icon-only one still declares a label.
  for (const label of ['Talk at the table', 'Emote', 'Invite']) {
    A(new RegExp(`label="${label}"`).test(src), `10f. action bar keeps "${label}"`);
  }
  A(/accessibilityLabel="Settings"/.test(src), '10g. ...and the gear is labelled for a screen reader');

  // Folding the bar into a button hid its live state, so the state has to be
  // shown somewhere or a player cannot tell they are in voice.
  A(/voiceLive/.test(src), '10h. a live-voice indicator survives the fold');
  A(/voice\.phase === 'live' \|\| voice\.phase === 'waiting'/.test(src),
    '10i. ...for the two phases VoiceBar showed its live row for');
}

/* ── 11. the pieces, and the tokens that describe them ───────────────── */
{
  // A token module that declares a value nobody reads is worse than no module:
  // it documents a number the pixels do not use, which is exactly how the two
  // drift apart. This caught PAWN.specular and PAWN.rimMovable going dead when
  // the pawn moved from a styled View to an SVG.
  for (const k of Object.keys(PAWN)) {
    A(new RegExp(`PAWN\\.${k}\\b`).test(src), `11a. PAWN.${k} is actually used by Ludo.tsx`);
  }

  // The silhouette is the whole point of the redesign: four colours of one flat
  // circle is what it replaced. Both halves must be drawn, base BEFORE body.
  A(/d=\{PAWN_BASE\}/.test(src), '11b. the pawn draws its plinth');
  A(/d=\{PAWN_BODY\}/.test(src), '11c. ...and its body');
  A(src.indexOf('d={PAWN_BASE}') < src.indexOf('d={PAWN_BODY}'),
    '11d. ...plinth first, so the body sits on top of it');
  A(!/borderRadius: d \/ 2/.test(src), '11e. the old flat disc is gone');

  // The paths are drawn in a 0..100 box and scaled by the caller, so the
  // geometry can never start depending on the board size.
  for (const [name, d] of [['PAWN_BODY', PAWN_BODY], ['PAWN_BASE', PAWN_BASE]] as const) {
    const nums = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    A(nums.length > 0 && Math.max(...nums) <= 100 && Math.min(...nums) >= 0,
      `11f. ${name} stays inside the 0..100 box (max ${Math.max(...nums)})`);
    A(/^M /.test(d) && /Z$/.test(d), `11g. ${name} is a closed path`);
  }

  // The die's sheen escapes its own rounded corners unless the face clips.
  // Shadows are drawn outside a clipped view either way, so the gold halo
  // survives — this was found by rendering it, not by reading it.
  A(/overflow: 'hidden'/.test(src), '11h. the die clips, so its sheen cannot escape the cube');
}

/* ── 12. a dropped socket must not rewrite whose turn it is ──────────── */
{
  // FOUND ON A DEVICE, mid-reconnect. `mine` is "your turn AND connected",
  // because it also gates interaction. The turn WORDING used it too, so while
  // the socket was down the screen said:
  //     seat card   -> "Srihari B, you, Red, Tap a token"
  //     turn line   -> "Srihari B is playing / Waiting for their move"
  // i.e. it told the player to wait for themselves, and simultaneously invited
  // a tap that could not land. Whose turn it is is a SERVER fact; whether we
  // may act on it is a socket fact. These must not be the same expression.
  A(/const yourTurn = G\.turnPlayerId === state\.you;/.test(src),
    '12a. there is a socket-independent "whose turn is it"');
  A(/title=\{\s*\n?\s*!yourTurn \? `\$\{turnName\} is playing`/.test(src),
    '12b. the turn line names another player only when it really is theirs');
  A(!/!mine \? `\$\{turnName\} is playing`/.test(src),
    '12c. ...and no longer prints YOUR name at you while reconnecting');
  A(/if \(!connected\) return 'Your turn';/.test(src),
    '12d. the seat card stops saying "Tap a token" once the socket is down');
  A(/tone=\{!yourTurn \|\| !connected \? 'wait'/.test(src),
    '12e. the gold "act" tone is never shown while a tap cannot land');

  // The affordances themselves must still hang off `mine`/`canMove`, which do
  // include `connected` — the fix is to the wording, not to the gating.
  A(/const mine = G\.turnPlayerId === state\.you && connected;/.test(src),
    '12f. `mine` still requires a live socket');
  A(/const canMove = mine && die != null && movable\.length > 0;/.test(src),
    '12g. ...and canMove still hangs off it');
}

console.log(failed === 0 ? '\nAll good.\n' : `\n${failed} FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
