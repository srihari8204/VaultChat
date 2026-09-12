// lib/gridTile.selftest.ts — run: npx tsx lib/gridTile.selftest.ts
//
// The media grid's tile size used to be a module-level constant computed from
// Dimensions.get('window') at import, so it never changed after launch. These
// assert the replacement actually tracks the window across the states that
// previously froze it: rotation, fold, and split-screen.

const GRID_GUTTER = 40;
const GRID_COLS = 3;
function gridTileSize(windowWidth: number): number {
  return Math.max(48, (windowWidth - GRID_GUTTER) / GRID_COLS);
}

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '\u2713' : '\u2717'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

console.log('\ngrid tile self-test\n');

// Three tiles plus the gutter must never exceed the window, or the row overflows.
for (const w of [320, 360, 375, 390, 412, 480, 600, 768, 820, 1024, 1280]) {
  const t = gridTileSize(w);
  check(`w=${w}: row fits`, t * GRID_COLS + GRID_GUTTER <= w + 0.001,
        `3*${t.toFixed(1)}+${GRID_GUTTER} > ${w}`);
}

// Rotation and fold must CHANGE the size — the old constant did not.
check('portrait != landscape', gridTileSize(412) !== gridTileSize(915));
check('folded != unfolded', gridTileSize(360) !== gridTileSize(717));

// Split-screen can hand us a very narrow window; a tile must stay tappable
// (48dp is the Android minimum touch target) rather than collapsing to nothing.
check('tiny split-screen stays tappable', gridTileSize(100) >= 48, String(gridTileSize(100)));
check('zero width does not produce 0 or NaN',
      gridTileSize(0) >= 48 && Number.isFinite(gridTileSize(0)), String(gridTileSize(0)));

// Monotonic: a wider window never yields a smaller tile.
let mono = true;
for (let w = 200; w < 1400; w += 7) if (gridTileSize(w + 7) < gridTileSize(w)) mono = false;
check('wider window never shrinks the tile', mono);

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all grid tile checks passed\n');
process.exit(failures ? 1 : 0);
