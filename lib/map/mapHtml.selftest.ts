// lib/map/mapHtml.selftest.ts — prove the two map pages are valid JavaScript
// AFTER template evaluation, which is the only form a device ever runs.
//
// WHY THE "AFTER" MATTERS (this test was written blind to it once, and a bug
// walked straight through):
// The pages are template literals, so a backslash in the SOURCE is a template
// escape, not a character. `/^https?:\/\/([^\/]+)/` reads fine in the .tsx and
// parses fine as source — but the template collapses every `\/` to `/`, and the
// page receives `/^https?://([^/]+)/`, a regex that closes at the first bare
// slash. The result is a top-level SyntaxError, thrown BEFORE map.on('error')
// is registered — so MapLibre never constructs, nothing is reported, the RN side
// never downgrades, and the user gets a silent blank map.
//
// Checking the raw source cannot see that. So this evaluates each template the
// way the component does and parses the RESULT.
//
// A *.selftest.ts, not an embedded check: reading source with `fs` from a module
// Metro bundles breaks `assembleRelease`. Source scans live out here.
//
//   npx tsx lib/map/mapHtml.selftest.ts

import { readFileSync } from 'fs';
import { join } from 'path';

const A = (c: boolean, m: string) => { if (!c) throw new Error('mapHtml: ' + m); };

const PAGES = [
  join(__dirname, '..', '..', 'components', 'nav', 'NavMap.tsx'),
  join(__dirname, '..', '..', 'components', 'family', 'FamilyMap.tsx'),
];

/** Every `return \`…</html>\`` template in a file — the Leaflet page and the MapLibre one. */
function templatesIn(src: string): string[] {
  const out: string[] = [];
  for (let i = 0; ;) {
    const start = src.indexOf('return `', i);
    if (start < 0) break;
    const from = start + 'return `'.length;
    const end = src.indexOf('</html>`', from);
    if (end < 0) break;
    out.push(src.slice(from, end + '</html>'.length));
    i = end + 1;
  }
  return out;
}

// Stand-ins for everything the templates interpolate. A new interpolation that
// is not listed here throws ReferenceError, which is the correct failure: add it.
const STUB: Record<string, unknown> = {
  JSON,
  MAPLIBRE_CSS_B64: '', MAPLIBRE_JS_B64: '', LEAFLET_CSS_B64: '', LEAFLET_JS_B64: '', ROUTING_JS_B64: '',
  MARKER_CSS: () => '', light: true,
  ATTRIBUTION: '(c) OpenStreetMap contributors',
  styleUrl: 'https://tiles.example.org/styles/x',
  tileUrl: '', bg: '#0d0f14', accent: '#7c5cff', selfColor: '#7c5cff', svKey: '',
  buildings: { id: 'building-3d', type: 'fill-extrusion' },
};

// Evaluate the actual shared marker CSS, including its day/night branch.
const familySource = readFileSync(PAGES[1], 'utf8');
const cssStart = familySource.indexOf('=> `', familySource.indexOf('const MARKER_CSS')) + 4;
const cssEnd = familySource.indexOf('`;', cssStart);
A(cssStart > 3 && cssEnd > cssStart, 'shared marker CSS is available');
const markerCss = new Function('selfColor', 'light', 'return `' + familySource.slice(cssStart, cssEnd) + '`;');
A(markerCss('#1552E0', true).includes('.mk:not(.self),.cl:not(.self){color:#070A18}'),
  'light member initials and cluster counts use dark ink, self markers retain white');
A(!markerCss('#1552E0', false).includes('#070A18'), 'dark marker CSS remains unchanged');
A((familySource.match(/isCl\?\('cl'\+\(m\.self\?' self':''\)\)/g) ?? []).length === 2,
  'both map engines identify self-containing clusters for correct light ink');

let parsed = 0;

for (const file of PAGES) {
  const src = readFileSync(file, 'utf8');
  const name = file.split(/[\/]/).pop();

  // Only lib/map/tileProvider may name a provider. A hardcoded host here is how
  // the whole app ended up serving CARTO's "API KEY REQUIRED" watermark.
  A(!/cartocdn|tile\.openstreetmap\.org|api\.mapbox\.com|maptiler\.com/.test(src),
    `${name}: must not name a tile provider — that belongs in lib/map/tileProvider`);

  // maplibregl has no public supported() in the bundled 4.7.1; calling one kills
  // the whole page script on every device. The probe must be a plain canvas one.
  A(/getContext\('webgl'\)/.test(src), `${name}: needs a WebGL probe before constructing the map`);
  A(!/maplibregl\.supported\s*\(/.test(src), `${name}: maplibregl.supported() does not exist in 4.7.1`);

  const tpls = templatesIn(src);
  A(tpls.length >= 2, `${name}: expected the Leaflet and MapLibre pages, found ${tpls.length}`);

  for (const tpl of tpls) {
    // Evaluate exactly as the component does, so escapes collapse the same way.
    let page: string;
    try {
      page = new Function(...Object.keys(STUB), 'return `' + tpl + '`;')(...Object.values(STUB)) as string;
    } catch (e: any) {
      throw new Error(`${name}: a page template does not even build — ${e?.message ?? e}`);
    }

    const scripts = page.match(/<script>([\s\S]*?)<\/script>/g) ?? [];
    A(scripts.length >= 1, `${name}: evaluated page has no inline script`);

    for (const block of scripts) {
      const js = block.replace(/^<script>/, '').replace(/<\/script>$/, '');
      try {
        new Function(js);           // throws SyntaxError on a page a device cannot run
      } catch (e: any) {
        throw new Error(`${name}: EVALUATED page does not parse — ${e?.message ?? e}`);
      }
      parsed++;
    }
  }
}

console.log(`map/mapHtml self-check: OK (${parsed} evaluated page scripts parsed)`);
