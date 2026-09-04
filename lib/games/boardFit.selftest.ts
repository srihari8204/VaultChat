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
import { boardFit, BOARD_MIN, BOARD_GUTTER } from './boardFit';

let failed = 0;
function A(ok: boolean, what: string): void {
  if (ok) { console.log('  ok   ' + what); return; }
  failed++;
  console.log('  FAIL ' + what);
}

const none = { top: 0, bottom: 0, left: 0, right: 0 };
console.log('\nBoard fit\n');

// ── it must never exceed what exists ─────────────────────────────────
{
  const screens: [number, number, string][] = [
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
    A(/onLayout=\{onBoardBox\}/.test(code),
      `6f. ${f} measures the container it lays the board out in, not the window`);
  }
}

console.log(failed === 0 ? '\nAll good.\n' : `\n${failed} FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
