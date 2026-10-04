// lib/media/pdfZoom.selftest.ts — run: npx tsx lib/media/pdfZoom.selftest.ts
import assert from 'node:assert/strict';
import { keepCentre, pdfZoom, pdfZoomLabel, stepZoom, PDF_MAX_ZOOM, PDF_MIN_ZOOM } from './pdfZoom';

// A pinch multiplies the zoom it STARTED from, clamped to [1, 4], on quarter steps.
assert.equal(pdfZoom(1, 2), 2);
assert.equal(pdfZoom(2, 1.6), 3.25);
assert.equal(pdfZoom(1, 10), PDF_MAX_ZOOM);
assert.equal(pdfZoom(1, 0.3), PDF_MIN_ZOOM);       // never narrower than the screen
assert.equal(pdfZoom(1.5, NaN), 1.5);              // a bad scale keeps the zoom
assert.equal(pdfZoom(1, 1.1), 1);                  // a twitch does not re-render the pages
assert.equal(pdfZoom(1, 1.13), 1.25);

assert.equal(stepZoom(1, 1), 1.5);
assert.equal(stepZoom(4, 1), 4);
assert.equal(stepZoom(1.25, -1), 1);

// Zooming 1 → 2 around the middle of an 800-tall viewport at offset 1000:
// the centre was at 1400, becomes 2800, so the new offset is 2400.
assert.equal(keepCentre(1000, 800, 2), 2400);
assert.equal(keepCentre(0, 800, 0.5), 0);          // clamped at the top
assert.equal(keepCentre(500, 800, 1), 500);        // no change
assert.equal(keepCentre(500, 800, NaN), 500);

assert.equal(pdfZoomLabel(1.25), '125%');
console.log('pdfZoom selftest: all passed');
