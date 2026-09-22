// Run: npx tsx lib/appTextRendering.selftest.ts
// Render the real wrapper with native primitives mocked; React context stays real.
import assert from 'node:assert/strict';
import Module from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const recorded: Record<string, unknown>[] = [];
const flatten = (style: any): Record<string, unknown> => Array.isArray(style)
  ? Object.assign({}, ...style.map(flatten)) : style || {};
const native = {
  StyleSheet: { flatten },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  Text: ({ style, children }: any) => {
    recorded.push(flatten(style));
    return React.createElement('span', null, children);
  },
};
const loader = Module as any;
const original = loader._load;
let AppText: any, FontReadyContext: any;
try {
  loader._load = function (name: string, ...args: any[]) {
    if (name === 'react-native') return native;
    if (name === '../../lib/theme') return { useColors: () => ({ text: '#101828' }) };
    if (name === '../../lib/visionComfort') return { useVisionComfort: () => ({ metrics: {
      textScale: 1, lineScale: 1, bold: false,
    } }) };
    return original.call(this, name, ...args);
  };
  ({ AppText, FontReadyContext } = require('../components/ui/Text'));
} finally {
  loader._load = original;
}

function render(child: React.ReactNode) {
  recorded.length = 0;
  renderToStaticMarkup(React.createElement(FontReadyContext.Provider, { value: true }, child));
}
render(React.createElement(AppText, { style: { fontSize: 12, color: '#FFFFFF' } },
  'Status ', React.createElement(AppText, { style: { fontWeight: 'bold' } }, 'active')));
assert.equal(recorded[0].fontSize, 12);
assert.equal(recorded[1].fontSize, undefined, 'inline text inherits size');
assert.equal(recorded[1].lineHeight, undefined, 'inline text inherits line box');
assert.equal(recorded[1].color, undefined, 'inline text inherits parent foreground');
assert.equal(recorded[1].fontFamily, 'NunitoSans_700Bold');

render(React.createElement(AppText, { style: { fontSize: 42 } }, '42'));
assert.ok(Number(recorded[0].lineHeight) > 42, 'large custom type cannot clip in body line box');
render(React.createElement(AppText, { style: { fontSize: 42, lineHeight: 48 } }, '42'));
assert.equal(recorded[0].lineHeight, 48, 'explicit line height survives');
render(React.createElement(AppText, null,
  React.createElement(AppText, { variant: 'caption', color: '#1552E0' }, 'Caption')));
assert.equal(recorded[1].color, '#1552E0');
assert.ok(Number(recorded[1].fontSize) > 0, 'explicit inline variant owns its type scale');
console.log('appTextRendering.selftest: 9 rendering assertions passed');
