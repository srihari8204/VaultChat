// lib/brandFonts.selftest.ts — run: npx tsx lib/brandFonts.selftest.ts
//
// The brand typeface chain, end to end, because every link in it fails SILENTLY.
//
//   constants/theme.ts FONT.*  →  assets/fonts/<name>.ttf  →  app.json expo-font
//   plugin list  →  TYPOGRAPHY[variant].family  →  the weight ladder in
//   components/ui/Text.tsx
//
// These families are per-weight STATIC files registered under their own names
// (Sora_700Bold, NunitoSans_600SemiBold, …). Android resolves them BY FILENAME, so
// every way of getting this wrong produces the same symptom: no error, no warning,
// and Roboto on screen where the brand face should be. Specifically:
//
//   * a FONT.* name with no matching .ttf — asks for a family that was never
//     registered, so the text silently renders in the system font.
//   * a .ttf on disk but missing from app.json's expo-font list — never embedded
//     at build time, so the name resolves to nothing. Same silent fallback, and
//     invisible in the repo because the file is right there.
//   * a weight the ladder resolves to a family that does not exist — e.g. adding a
//     '500' branch that asks for NunitoSans_500Medium. Falls back exactly where
//     emphasis was requested, which is the defect components/ui/Text.tsx's long
//     comment (2026-09-17) exists to prevent.
//
// So the chain is asserted rather than assumed. There is no runtime font load to
// fail — the expo-font config plugin embeds these at build time — which is why the
// build-time wiring is the only place a mistake can be caught.
//
// openspec: global-device-support task 4.4.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

console.log('\nbrand font chain');

const themeSrc = readFileSync(join(ROOT, 'constants', 'theme.ts'), 'utf8');

// ── 1. FONT.* → a real .ttf on disk ──────────────────────────────────────────
const fontBlock = /export const FONT = \{([\s\S]*?)\} as const;/.exec(themeSrc);
check('constants/theme.ts still exports a FONT block this guard can read',
  !!fontBlock, 'the shape changed — update this selftest, do not delete it');

const declared = new Map<string, string>();   // key → family name
for (const m of (fontBlock?.[1] ?? '').matchAll(/(\w+)\s*:\s*'([^']+)'/g)) {
  declared.set(m[1], m[2]);
}
check('FONT declares at least the five brand faces', declared.size >= 5, `found ${declared.size}`);

const onDisk = new Set(
  readdirSync(join(ROOT, 'assets', 'fonts'))
    .filter((f) => f.endsWith('.ttf') || f.endsWith('.otf'))
    .map((f) => f.replace(/\.(ttf|otf)$/, '')),
);
const missingFile = [...declared.entries()].filter(([, fam]) => !onDisk.has(fam));
check('every FONT.* family has a matching file in assets/fonts/',
  missingFile.length === 0,
  missingFile.map(([k, f]) => `FONT.${k} = '${f}' has no ${f}.ttf`).join('; '));

// ── 2. every file on disk is registered with the expo-font plugin ─────────────
// A file present but unregistered is the nastiest case: it looks correct in the
// repo and is simply never embedded.
const appJson = JSON.parse(readFileSync(join(ROOT, 'app.json'), 'utf8'));
const fontPlugin = (appJson.expo?.plugins ?? [])
  .find((p: unknown) => Array.isArray(p) && p[0] === 'expo-font') as [string, { fonts?: string[] }] | undefined;
check('app.json registers the expo-font plugin (nothing embeds the faces otherwise)', !!fontPlugin);

const registered = new Set(
  (fontPlugin?.[1]?.fonts ?? []).map((p) => p.replace(/^.*\//, '').replace(/\.(ttf|otf)$/, '')),
);
const usedFamilies = new Set(declared.values());
const unregistered = [...usedFamilies].filter((f) => !registered.has(f));
check('every FONT.* family is in the expo-font plugin list, so it is embedded',
  unregistered.length === 0,
  unregistered.length ? `on disk but never embedded: ${unregistered.join(', ')}` : '');

const orphanFiles = [...onDisk].filter((f) => !usedFamilies.has(f));
check('no orphan font files (dead weight in every APK)', orphanFiles.length === 0,
  orphanFiles.length ? `${orphanFiles.join(', ')} — referenced by no FONT.* entry` : '');

// ── 3. TYPOGRAPHY only names declared families ───────────────────────────────
const typographyFamilies = new Set(
  [...themeSrc.matchAll(/family:\s*FONT\.(\w+)/g)].map((m) => m[1]),
);
const unknownInScale = [...typographyFamilies].filter((k) => !declared.has(k));
check('every family named in the type scale is a declared FONT key',
  unknownInScale.length === 0, unknownInScale.map((k) => `FONT.${k}`).join(', '));

// ── 4. the weight ladder in Text.tsx resolves only to declared families ──────
// This is the one that catches a future '500' branch asking for a face nobody
// bundled. Read the shipping component rather than restating its ladder.
const textSrc = readFileSync(join(ROOT, 'components', 'ui', 'Text.tsx'), 'utf8');
const ladderKeys = [...textSrc.matchAll(/FONT\.(\w+)/g)].map((m) => m[1]);
check('components/ui/Text.tsx references at least one FONT family (the ladder is wired)',
  ladderKeys.length > 0);
const ladderUnknown = [...new Set(ladderKeys)].filter((k) => !declared.has(k));
check('every family the weight ladder can resolve to actually exists',
  ladderUnknown.length === 0,
  ladderUnknown.map((k) => `Text.tsx resolves to FONT.${k}, which is not declared`).join('; '));

// The ladder must not reintroduce a bare fontWeight alongside a brand family — the
// exact combination that makes Android hunt for an unregistered weighted variant.
check('Text.tsx still sets fontWeight only on the system fallback, never beside a family',
  /\.\.\.\(ready \? \{ fontFamily: t\.family \} : \{ fontWeight: t\.fontWeight \}\)/.test(textSrc),
  'the base style changed shape — re-read the 2026-09-17 comment in that file before "fixing" this');

// A guard that cannot fail is decoration.
check('the disk matcher would notice a missing file', !onDisk.has('ThisFaceDoesNotExist_900Black'));
check('the registration matcher would notice an unembedded family',
  !registered.has('ThisFaceDoesNotExist_900Black'));

console.log(`\n  ${declared.size} declared faces, ${onDisk.size} files, ${registered.size} embedded,`
  + ` ${typographyFamilies.size} used by the type scale`);
console.log(failures === 0 ? '\nALL PASSED ✓\n' : `\n${failures} FAILED ✗\n`);
process.exit(failures === 0 ? 0 : 1);
