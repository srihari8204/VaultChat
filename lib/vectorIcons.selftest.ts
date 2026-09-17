// Run: npx tsx lib/vectorIcons.selftest.ts
//
// metro.config.js resolves '@expo/vector-icons' to shims/vector-icons.js, which
// re-exports only the families this app renders — because the real entry point
// requires all 19 families and each one drags its own .ttf into the APK
// (measured: 4,076,840 bytes of fonts, 2,022,616 of them never drawn).
//
// TypeScript still types the barrel as having all 19, so `import { Feather }
// from '@expo/vector-icons'` compiles and `tsc --noEmit` stays green; the shim
// throws at import time instead. That is a runtime failure on whichever screen
// happens to pull it in first, which is a poor place to find out. This finds it
// here: every family imported from the barrel must be one the shim re-exports.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { URL, fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const SCAN = ['app', 'components', 'lib', 'constants', 'db', 'hooks', 'utils'];
const SHIM = join(ROOT, 'shims', 'vector-icons.js');

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|jsx)$/.test(name)) out.push(p);
  }
  return out;
};

// What the shim actually hands out. Read as text rather than imported: the file
// is CommonJS and pulls native-only modules through @expo/vector-icons.
const shimSource = readFileSync(SHIM, 'utf8');
const exported = new Set(
  [...shimSource.matchAll(/^const (\w+) = require\('@expo\/vector-icons\/\w+'\)\.default;$/gm)].map((m) => m[1]),
);
assert.ok(exported.size > 0, 'could not read the shim — did its require() style change?');
// The re-exported consts have to be in the exported object, not just declared.
const bundledBlock = shimSource.match(/const bundled = \{([^}]*)\}/)?.[1] ?? '';
for (const name of exported) {
  assert.ok(bundledBlock.includes(name), `${name} is required in the shim but missing from its exports`);
}

const barrelImport = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]@expo\/vector-icons['"]/g;
let sites = 0;
const missing: string[] = [];
for (const dir of SCAN) {
  for (const file of walk(join(ROOT, dir))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(barrelImport)) {
      sites++;
      for (const raw of m[1].split(',')) {
        const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
        if (!name) continue;
        if (!exported.has(name)) missing.push(`${relative(ROOT, file)}: ${name}`);
      }
    }
  }
}

assert.equal(
  missing.length,
  0,
  `these import a family the shim does not bundle — add it to shims/vector-icons.js ` +
    `(it costs that family's whole .ttf) or switch to a family that is already there:\n  ` +
    missing.join('\n  '),
);
assert.ok(sites > 0, 'found no @expo/vector-icons imports at all — did the scan paths move?');

console.log(`vectorIcons selftest: ${sites} barrel imports, all covered by [${[...exported].join(', ')}]`);
