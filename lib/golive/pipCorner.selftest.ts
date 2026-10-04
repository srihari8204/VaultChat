// lib/golive/pipCorner.selftest.ts — npx tsx lib/golive/pipCorner.selftest.ts
//
// nextPipCorner is the non-drag way to move the camera corner on the Go Live
// stage (a chrome button and a screen-reader action). It must walk the four
// corners clockwise and never leave the safe area.
import assert from 'node:assert/strict';
import { clampPip, nextPipCorner, PIP_MARGIN } from './stageLayout';

let n = 0;
const ok = (cond: boolean, what: string) => { assert.ok(cond, what); n++; };

const W = 400, H = 800, PW = 100, PH = 140, TOP_Y = 100, TI = 40, BI = 30;
const next = (at: { x: number; y: number }) => nextPipCorner(at, W, H, PW, PH, TOP_Y, TI, BI);

const tl = clampPip(0, TOP_Y, W, H, PW, PH, TI, BI);
const tr = next(tl);
const br = next(tr);
const bl = next(br);
ok(tr.x === W - PW - PIP_MARGIN && tr.y === TOP_Y, '1. top-left -> top-right, on the home row');
ok(br.x === tr.x && br.y === H - PH - BI - PIP_MARGIN, '2. top-right -> bottom-right, clear of the bottom inset');
ok(bl.x === PIP_MARGIN && bl.y === br.y, '3. bottom-right -> bottom-left');
const back = next(bl);
ok(back.x === tl.x && back.y === tl.y, '4. bottom-left -> top-left: a full cycle returns home');
ok(next({ x: 10, y: 200 }).x === W - PW - PIP_MARGIN, '5. a preview dragged to the upper-middle-left moves right');
// Landscape notch on the left: never parked under it.
const ln = nextPipCorner({ x: 600, y: 300 }, 800, 400, PW, PH, 60, 0, 0, 48, 0);
ok(ln.x >= 48 + PIP_MARGIN, '6. a left inset (landscape notch) is respected');
// A window smaller than the preview pins to the safe edge rather than going off it.
const tiny = nextPipCorner({ x: 0, y: 0 }, 80, 80, PW, PH, 10);
ok(tiny.x >= PIP_MARGIN && tiny.y >= PIP_MARGIN, '7. a tiny window never pushes the preview off the panel');

console.log(`pipCorner.selftest: ${n} assertions passed`);
