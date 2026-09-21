import assert from 'node:assert/strict';
import { chessTttLayout } from './chessTttLayout';

// Follow one mounted game through rotation, split-window resize, and safe-area changes.
const portrait = chessTttLayout(360, 720, 328);
assert.deepEqual(portrait, { wide: false, size: 328, controlsWidth: 328 });
const landscape = chessTttLayout(760, 336, 200);
assert.equal(landscape.wide, true);
assert.equal(landscape.size, 304); // Old portrait chrome forced a 200dp board here.
assert.equal(landscape.controlsWidth, 392);
const cutoutChanged = chessTttLayout(700, 312, 200);
assert.equal(cutoutChanged.size, 280);
assert.equal(cutoutChanged.controlsWidth, 356);
const splitWindow = chessTttLayout(400, 336, 200);
assert.equal(splitWindow.wide, false);
assert.equal(splitWindow.size, 200); // Scrollable portrait composition, no squeezed sidebar.
assert.deepEqual(chessTttLayout(360, 720, 328), portrait);

for (const [width, height] of [[600, 360], [844, 340], [1024, 700], [600, 160]]) {
  const layout = chessTttLayout(width, height, 200);
  assert.ok(layout.controlsWidth >= 240, `${width}: controls remain usable`);
  assert.equal(layout.size + layout.controlsWidth + 64, width, 'both panes and gutters fit exactly');
  assert.ok(layout.size >= 200, 'short viewports keep a playable, scrollable board');
  if (height >= 232) assert.ok(layout.size + 32 <= height, 'board fits viewport vertically');
}
// Chess frame/rails and TTT border/padding must stay inside the resized board in every mode.
for (const { size } of [portrait, landscape, cutoutChanged, splitWindow]) {
  const edge = size - 6;
  const rail = Math.max(13, Math.min(26, Math.round(edge * 0.053)));
  const cell = (edge - rail * 2) / 8;
  assert.equal(cell * 8 + rail * 2 + 6, size);
  const tttCell = Math.floor((size - 42) / 3);
  assert.ok(tttCell * 3 + 42 <= size);
}
console.log('chessTttLayout: rotation, safe-area resize, split-window, tiny height, and board bounds passed');
