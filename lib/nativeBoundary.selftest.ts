import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const UI_DIRS = ['app', 'components'];
const FORBIDDEN = /\b(NativeModules|NativeEventEmitter|TurboModuleRegistry|NitroModules|createHybridObject)\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const rel = relative(ROOT, path).replace(/\\/g, '/');
    if (rel.includes('/node_modules/') || rel.includes('/build/') || rel.includes('/dist/')) continue;
    const st = statSync(path);
    if (st.isDirectory()) walk(path, out);
    else if (/\.(tsx?|jsx?)$/.test(name) && !name.endsWith('.selftest.ts')) out.push(rel);
  }
  return out;
}

const offenders = UI_DIRS.flatMap(dir => walk(join(ROOT, dir)))
  .filter(path => FORBIDDEN.test(readFileSync(join(ROOT, path), 'utf8')));

assert.deepEqual(
  offenders,
  [],
  `UI files must call TypeScript facades, not native modules directly:\n${offenders.join('\n')}`,
);

console.log('nativeBoundary.selftest: UI does not call native modules directly');
