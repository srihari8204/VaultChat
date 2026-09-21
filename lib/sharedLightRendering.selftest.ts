// Render real components with native drawing mocked; verify resolved colors.
import assert from 'node:assert/strict';
import Module from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PALETTES } from '../constants/theme';

let scheme: 'light' | 'dark' = 'light';
let connection = 'CONNECTING';
const drawn: { type: string; props: any }[] = [];
const flatten = (style: any): any => Array.isArray(style)
  ? Object.assign({}, ...style.map(flatten)) : style || {};
const primitive = (type: string) => function NativePrimitive({ children, ...props }: any) {
  drawn.push({ type, props: { ...props, style: flatten(props.style) } });
  return React.createElement('span', null, children);
};
const native = {
  Platform: { OS: 'android', select: (values: any) => values.android ?? values.default },
  View: primitive('View'), Text: primitive('Text'), TouchableOpacity: primitive('TouchableOpacity'),
  ActivityIndicator: primitive('ActivityIndicator'),
  StyleSheet: { create: (s: any) => s, hairlineWidth: 0.33 },
};
const loader = Module as any;
const original = loader._load;
const requireNative = Module.createRequire(__filename);
let Banner: any, Chip: any, C: any, GamePaletteContext: any, lightHubPalette: any, useGamePalette: any;
try {
  loader._load = function(name: string, ...args: any[]) {
    if (name === 'react-native') return native;
    if (name.endsWith('/lib/theme')) return { useColors: () => PALETTES[scheme], useTheme: () => ({ scheme }) };
    if (name === '../lib/socket') return { useConnectionState: () => connection };
    if (name === 'expo-linear-gradient') return { LinearGradient: primitive('Gradient') };
    if (name === '@expo/vector-icons') return { Ionicons: primitive('Icon') };
    if (name === './Text') return { AppText: primitive('AppText') };
    return original.call(this, name, ...args);
  };
  Banner = requireNative('../components/ConnectionBanner').default;
  Chip = requireNative('../components/ui/GlassChip').GlassChip;
  ({ C } = requireNative('./games/theme'));
  ({ GamePaletteContext, lightHubPalette, useGamePalette } = requireNative('../components/games/appearance'));
} finally { loader._load = original; }

function render(component: any, props = {}) {
  drawn.length = 0;
  renderToStaticMarkup(React.createElement(component, props));
}
function ratio(a: string, b: string) {
  const lum = (hex: string) => {
    const h = hex.slice(1); const expanded = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    return [0.2126, 0.7152, 0.0722].reduce((n, weight, i) => {
      const v = parseInt(expanded.slice(i * 2, i * 2 + 2), 16) / 255;
      return n + weight * (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    }, 0);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
render(Banner);
const ink = drawn.find(x => x.type === 'Text')!.props.style.color;
const background = drawn.find(x => x.type === 'View')!.props.style.backgroundColor;
assert.ok(ratio(ink, background) >= 4.5, 'connecting text remains readable on the light status strip');
assert.equal(drawn.find(x => x.type === 'ActivityIndicator')!.props.color, ink, 'spinner shares readable ink');
connection = 'OFFLINE'; render(Banner);
assert.equal(drawn.find(x => x.type === 'Text')!.props.style.color, '#fff', 'red offline strip retains white ink');
connection = 'ONLINE'; render(Banner); assert.equal(drawn.length, 0, 'online remains hidden');
render(Chip, { label: 'Unread', count: 3, active: true });
for (const stop of drawn.find(x => x.type === 'Gradient')!.props.colors) {
  assert.ok(ratio('#FFFFFF', stop) >= 4.5, 'every light active-chip stop supports white text');
}
assert.ok(drawn.some(x => x.props.style.backgroundColor === 'rgba(0,0,0,0.08)'), 'count badge does not wash out the button');
scheme = 'dark'; connection = 'CONNECTING'; render(Banner);
assert.equal(drawn.find(x => x.type === 'Text')!.props.style.color, '#fff', 'dark status ink unchanged');
render(Chip, { label: 'Unread', active: true });
assert.deepEqual(drawn.find(x => x.type === 'Gradient')!.props.colors,
  [PALETTES.dark.accentLight, PALETTES.dark.accentDeep], 'dark chip gradient unchanged');

let observed: ReturnType<typeof useGamePalette>;
function Probe() { observed = useGamePalette(); return null; }
renderToStaticMarkup(React.createElement(Probe));
assert.equal(observed!, C, 'boards keep the original palette without a hub override');
const light = lightHubPalette(PALETTES.light);
renderToStaticMarkup(React.createElement(GamePaletteContext.Provider, { value: light }, React.createElement(Probe)));
assert.equal(observed!, light, 'launcher sheets inherit the explicit light palette');
assert.ok(ratio(light.text, light.panel) >= 4.5 && ratio(light.gold, light.panel) >= 4.5, 'light hub body/action ink readable');
renderToStaticMarkup(React.createElement(Probe));
assert.equal(observed!, C, 'launcher override cannot leak into a sibling game board');
console.log('sharedLightRendering.selftest: 13 rendering assertions passed');
