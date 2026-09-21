// lib/games/boardFit.selftest.ts — the board has to fit the screen it is on.
//
//   npx tsx lib/games/boardFit.selftest.ts
//
// The rummy hand shipped a bug where the layout MODEL said it fitted and the
// render disagreed, and the tests passed throughout because they only ever
// asked the model about itself. So these check the two properties that a device
// can contradict: the board never exceeds the space available, and it never
// refuses space that is available.

import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';
import { transpileModule } from 'typescript';
import { boardFit, BOARD_MIN, BOARD_GUTTER } from './boardFit';

let failed = 0;
function A(ok: boolean, what: string): void {
  if (ok) { console.log('  ok   ' + what); return; }
  failed++;
  console.log('  FAIL ' + what);
}

const none = { top: 0, bottom: 0, left: 0, right: 0 };
console.log('\nBoard fit\n');

// Drive the actual sizing hook across native onLayout events. A window resize
// and its later container measurement are different events on Android.
{
  const src = readFileSync(join(__dirname, '../../components/games/ui.tsx'), 'utf8');
  const start = src.indexOf('export function useBoardBox(');
  const hook = src.slice(start, src.indexOf('\n}', start) + 2).replace('export ', '');
  let window = { width: 393, height: 851 };
  let stored = { w: 0, h: 0 };
  const context = {
    boardFit, NO_INSETS: none,
    useWindowDimensions: () => window,
    useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
    React: {
      useState: () => [stored, (set: (previous: typeof stored) => typeof stored) => { stored = set(stored); }],
      useCallback: (fn: unknown) => fn,
      useMemo: (fn: () => unknown) => fn(),
    },
  };
  const render = runInNewContext(transpileModule(hook, {}).outputText + '\nuseBoardBox;', context);
  let state = render(300);
  A(state.width === 393 && state.height === 803, '0. first frame uses safe window fallback');
  state.onLayout({ nativeEvent: { layout: { width: 393, height: 740 } } });
  state = render(300);
  A(state.width === 393 && state.height === 740 && state.size === 361,
    '0a. measured play viewport owns sizing without subtracting safe area twice');
  window = { width: 851, height: 393 };
  state.onLayout({ nativeEvent: { layout: { width: 795, height: 293 } } });
  state = render(300);
  A(state.width === 795 && state.height === 293, '0b. rotation exposes measured wide viewport to board/controls composition');
  state.onLayout({ nativeEvent: { layout: { width: 300, height: 470 } } });
  state = render(300);
  A(state.width === 300 && state.height === 470, '0c. split-screen relayout wins over unchanged window dimensions');
  const previous = stored;
  state.onLayout({ nativeEvent: { layout: { width: 300, height: 470 } } });
  A(stored === previous, '0d. identical native layout does not schedule another size state');
}

// ── it must never exceed what exists ─────────────────────────────────
{
  const screens: [number, number, string][] = [
    [320, 568, 'compact phone'],
    [320, 320, 'compact split screen'],
    [568, 320, 'compact landscape'],
    [360, 640, 'small phone'],
    [412, 915, 'standard phone'],
    [1080, 2340, 'Redmi, raw px'],
    [1224, 2664, 'Honor, raw px'],
    [800, 1280, 'tablet portrait'],
    [1280, 800, 'tablet landscape'],
    [915, 412, 'phone landscape'],
  ];
  for (const [w, h, name] of screens) {
    const f = boardFit({ width: w, height: h }, none, 360);
    const byW = w - BOARD_GUTTER * 2;
    const byH = h - 360;
    A(f.scrolls || (f.size <= byW && f.size <= byH),
      `1. ${name}: ${f.size} fits inside ${Math.min(byW, byH)}`);
  }
}

// ── it must not refuse space it has ──────────────────────────────────
{
  const small = boardFit({ width: 412, height: 915 }, none, 360);
  const big = boardFit({ width: 800, height: 1280 }, none, 360);
  A(big.size > small.size,
    '2. a tablet gets a BIGGER board than a phone — the old 460 cap meant it did not');

  const huge = boardFit({ width: 2000, height: 2600 }, none, 360);
  A(huge.size > 1200,
    '2a. and a very large display keeps growing rather than stopping at a constant');

  const w = 900;
  const f = boardFit({ width: w, height: 4000 }, none, 360);
  A(f.size === w - BOARD_GUTTER * 2,
    '2b. when height is plentiful the board takes the full width less its gutter');
}

// ── both axes bind ───────────────────────────────────────────────────
{
  const shortScreen = boardFit({ width: 1200, height: 700 }, none, 360);
  A(shortScreen.size === 700 - 360,
    '3. on a short screen HEIGHT binds, so the controls under the board stay reachable');

  const narrow = boardFit({ width: 500, height: 2000 }, none, 360);
  A(narrow.size === 500 - BOARD_GUTTER * 2,
    '3a. on a narrow one WIDTH binds');
}

// ── safe areas come out of the margin, not the board ─────────────────
{
  const plain = boardFit({ width: 1200, height: 900 }, none, 360);
  const cut = boardFit({ width: 1200, height: 900 }, { top: 80, bottom: 40, left: 0, right: 0 }, 360);
  A(cut.size < plain.size,
    '4. a notch and a gesture bar reduce the board rather than being drawn over');

  const sideCut = boardFit({ width: 1200, height: 4000 }, { top: 0, bottom: 0, left: 60, right: 60 }, 360);
  A(sideCut.size === 1200 - 120 - BOARD_GUTTER * 2,
    '4a. and a landscape cutout is taken off the width');
}

// ── the floor, and its honest consequence ────────────────────────────
{
  const tiny = boardFit({ width: 300, height: 420 }, none, 360);
  A(tiny.size === BOARD_MIN && tiny.scrolls,
    `5. below the floor the board stays ${BOARD_MIN} and SAYS it scrolls — pieces that `
    + 'cannot be tapped are worse than a screen that scrolls');

  const ok = boardFit({ width: 412, height: 915 }, none, 360);
  A(!ok.scrolls, '5a. and a normal phone never reports scrolling');
}

// ── the callers actually use it ──────────────────────────────────────
{
  const ROOT = join(__dirname, '..', '..');
  const ui = readFileSync(join(ROOT, 'components/games/ui.tsx'), 'utf8');
  A(/boardFit\(/.test(ui), '6. useBoardBox is backed by boardFit');
  A(!/Math\.min\(byWidth,\s*byHeight,\s*max\)/.test(ui),
    '6a. ...and the old capped expression is gone');

  // A measured layout box is ALREADY inside the safe area. Taking the inset off
  // it a second time is exactly what put the rummy table 76px off centre, so
  // the measured branch is pinned to NO_INSETS here rather than trusted.
  A(/boardFit\(\{ width: box\.w, height: box\.h \}, NO_INSETS/.test(ui),
    '6d. the measured branch applies the safe-area inset exactly once');
  A(/Math\.abs\(prev\.w - width\) < 0\.5/.test(ui),
    '6e. an unchanged measurement returns the SAME object, so onLayout cannot loop');

  for (const f of ['Chess.tsx', 'Ludo.tsx', 'TicTacToe.tsx']) {
    const src = readFileSync(join(ROOT, 'components/games', f), 'utf8');
    const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    A(/useBoardBox\(/.test(code), `6b. ${f} sizes its board through the shared hook`);
    A(!/useBoardBox\(\s*\d+\s*,\s*\d+\s*\)/.test(code),
      `6c. ${f} no longer passes a hard maximum`);
    A(/onLayout=\{(?:onBoardBox|viewport\.onLayout)\}/.test(code),
      `6f. ${f} measures the container it lays the board out in, not the window`);
  }
}

// ── 7. the board is CENTRED, and the inset is owned exactly once ─────
//
// The regression this pins: on the Redmi, Chess/Ludo/Tic-Tac-Toe rendered 38px
// right of centre in landscape — a left/right margin delta of 76px, which is
// exactly one display cutout. Nothing owned the horizontal inset in that
// orientation, so the board centred inside the FULL window while 76px of that
// window sat under the cutout.
//
// These assert the geometry contract rather than any device's coordinates, so
// they fail for the right reason on any screen.
{
  const CHROME = [330, 360, 400];           // tic-tac-toe, chess, ludo
  const WINDOWS = [
    { width: 320, height: 568 }, { width: 360, height: 800 },
    { width: 393, height: 851 }, { width: 412, height: 915 },
    { width: 674, height: 841 }, { width: 820, height: 1180 },
    // landscape shapes too: the contract must not depend on orientation
    { width: 851, height: 393 }, { width: 1180, height: 820 },
  ];
  const INSETS = [
    { top: 0, bottom: 0, left: 0, right: 0 },
    { top: 24, bottom: 0, left: 0, right: 0 },
    { top: 59, bottom: 34, left: 0, right: 0 },
    // the landscape cutout: asymmetric, and the case that actually broke
    { top: 0, bottom: 44, left: 76, right: 0 },
    { top: 0, bottom: 44, left: 0, right: 76 },
  ];

  let centred = 0, once = 0;
  for (const chrome of CHROME) {
    for (const win of WINDOWS) {
      for (const ins of INSETS) {
        // (a) CENTRING. Whatever width the board is given, the slack around it
        //     splits evenly — margins equal to within a pixel of rounding.
        const fit = boardFit(win, ins, chrome);
        const usable = win.width - ins.left - ins.right;
        const slack = usable - fit.size;
        if (slack >= 0) {
          const left = slack / 2, right = slack - slack / 2;
          A(Math.abs(left - right) <= 1,
            `7. centred: ${win.width}x${win.height} inset(${ins.left},${ins.right}) chrome ${chrome}`);
          centred++;
        }

        // (b) THE INSET IS CONSUMED EXACTLY ONCE. Measuring a container that is
        //     already inside the safe area and passing NO_INSETS must give the
        //     SAME board as measuring the raw window and passing the insets.
        //     Consume the inset twice and the first is smaller; consume it zero
        //     times and the first is larger. Only "exactly once" makes these
        //     agree, which is the ownership model the boards rely on.
        const measured = {
          width: win.width - ins.left - ins.right,
          height: win.height - ins.top - ins.bottom,
        };
        const viaContainer = boardFit(measured, { top: 0, bottom: 0, left: 0, right: 0 }, chrome);
        A(viaContainer.size === fit.size && viaContainer.scrolls === fit.scrolls,
          `7a. inset owned once: container ${measured.width}x${measured.height} === window ${win.width}x${win.height} less inset (chrome ${chrome})`);
        once++;

        // (c) A board never claims more than it was given unless it SAYS it
        //     scrolls. An off-centre board is usually an oversized one.
        A(fit.size <= Math.min(usable, measured.height - chrome) || fit.scrolls,
          `7b. fits its box or declares scrolls: ${win.width}x${win.height} chrome ${chrome}`);
      }
    }
  }
  console.log(`  (7) ${centred} centring cases, ${once} inset-ownership cases`);
}

// ── 8. orientation belongs to the focused games route ────────────────
{
  const ROOT = join(__dirname, '..', '..');
  const route = readFileSync(join(ROOT, 'app/games.tsx'), 'utf8');
  A(/useFocusEffect/.test(route) && /ScreenOrientation\.unlockAsync\(/.test(route),
    '8. games unlocks orientation on focus, including return to a mounted route');
  A(/<SafeAreaView/.test(route), '8a. games owns the safe container for hub and boards');
  for (const f of ['Chess.tsx', 'Ludo.tsx', 'TicTacToe.tsx', 'Rummy.tsx']) {
    const code = readFileSync(join(ROOT, 'components/games', f), 'utf8');
    A(!/usePortraitLock\(|ScreenOrientation\.lockAsync\(/.test(code),
      `8b. ${f} does not override the focused route orientation`);
  }
  const rummy = readFileSync(join(ROOT, 'components/games/Rummy.tsx'), 'utf8');
  A(!/boxInsets|paddingTop: insets\.top|paddingBottom: insets\.bottom/.test(rummy),
    '8c. Rummy does not subtract or pad safe-area edges a second time');
}

// ── 9. the chess board's FRAME comes out of the board, not out of the page ──
//
// The 2026-09-06 chess redesign wraps the board in a 3dp bronze rim. boardFit
// returns the largest square that fits inside a 16dp gutter and the ScrollView
// pads by exactly that 16, so a frame drawn AROUND `size` is 6dp wider than the
// column it sits in: a clipped right edge, or a page that scrolls sideways.
// Both are things §13 of the brief forbids and both are invisible on a
// simulator wide enough to absorb them.
//
// The fix is arithmetic — the eight cells divide `size - 2*RIM` — so it is
// pinned as arithmetic, and the source is checked for the shape that would undo
// it (an inner board sized `width: size`).
{
  const ROOT = join(__dirname, '..', '..');
  const src = readFileSync(join(ROOT, 'components/games/Chess.tsx'), 'utf8');
  const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  const rim = Number((code.match(/const RIM = (\d+)/) ?? [])[1]);
  A(Number.isFinite(rim) && rim > 0, '9. chess declares a board rim');
  A(/const boardEdge = size - RIM \* 2;/.test(code),
    '9a. ...and what is left after it is the felt board');
  // The felt carries a RAIL, and the coordinates sit on it. Three bands now
  // share `size`: frame, rail, grid — and they have to sum back to it exactly.
  A(/const rail = Math\.max\(RAIL_MIN, Math\.min\(RAIL_MAX, Math\.round\(boardEdge \* RAIL_RATIO\)\)\);/.test(code),
    '9b. the rail is a ratio of the board, clamped at both ends');
  A(/const grid = boardEdge - rail \* 2;/.test(code),
    '9c. ...the grid is what the rail leaves');
  A(/const cell = grid \/ 8;/.test(code),
    '9d. ...and a cell is grid/8, never size/8');
  A(/width: boardEdge, height: boardEdge/.test(code) && /width: grid, height: grid/.test(code),
    '9e. the felt is boardEdge and the squares container is grid');

  // No `\d` here: this is a plain string, so the escape collapses to a literal
  // `d` and the match silently returns NaN — which reads as a failing board, not
  // a failing regex.
  const num = (k: string) => Number((code.match(new RegExp('const ' + k + ' = ([0-9.]+)')) ?? [])[1]);
  const RATIO = num('RAIL_RATIO'), RMIN = num('RAIL_MIN'), RMAX = num('RAIL_MAX');
  A(RATIO > 0 && RMIN > 0 && RMAX > RMIN, '9f. the rail constants parse');

  // Frame + rail + grid must sum back to `size` on every screen, and a square
  // must stay big enough to hit. Swept, not asserted once — the rail is the
  // thing that shrinks squares, so it is the thing that needs a floor.
  for (const w of [320, 360, 390, 412, 430, 480, 600, 768, 1024]) {
    for (const h of [640, 720, 780, 844, 932, 1180]) {
      const fit = boardFit({ width: w, height: h }, { top: 0, bottom: 0, left: 0, right: 0 }, 300);
      const boardEdge = fit.size - rim * 2;
      const rail = Math.max(RMIN, Math.min(RMAX, Math.round(boardEdge * RATIO)));
      const grid = boardEdge - rail * 2;
      const column = w - BOARD_GUTTER * 2;
      A(rim * 2 + rail * 2 + grid === fit.size,
        `9g. frame + rail + grid === size at ${w}x${h}`);
      A(fit.scrolls || fit.size <= column,
        `9h. the whole assembly fits the column at ${w}x${h}: ${fit.size} <= ${column}`);
      // 28dp is the floor a chess square may not go under. It is below the 44dp
      // control guideline on purpose — eight columns have to divide the screen,
      // and every chess client lands here — but a rail that pushed it lower
      // would be a visual flourish paid for with playability.
      A(grid / 8 >= 28,
        `9i. a square stays tappable at ${w}x${h}: ${(grid / 8).toFixed(1)}dp`);
    }
  }

  // The action dock divides the board's own width with flex, so four slots or
  // five, on any screen, it cannot overflow the way rummy's budgeted bar did.
  // It LIVES IN ui.tsx now — chess and ludo share one dock rather than two
  // copies — so the property is asserted where the property is.
  const dock = readFileSync(join(ROOT, 'components/games/ui.tsx'), 'utf8');
  A(/style=\{\[aStyle, \{ flex: 1, opacity: a\.disabled/.test(dock),
    '9j. a dock slot is flex:1, not a computed width');
  A(!/const slot = /.test(dock),
    '9k. ...so there is no slot arithmetic left to get wrong');
  A(/<ActionDock/.test(code), '9l. chess uses the shared dock');
  A(!/function DockBtn\(/.test(code), '9m. ...and no longer carries its own');
}

console.log(failed === 0 ? '\nAll good.\n' : `\n${failed} FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
