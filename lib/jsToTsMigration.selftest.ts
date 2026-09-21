import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const RUNTIME_DIRS = [
  'app',
  'components',
  'lib',
  'services',
  'utils',
  'constants',
  'db',
  'hooks',
  'types',
  'shims',
];
const ALLOWED = new Set<string>([]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const rel = relative(ROOT, path).replace(/\\/g, '/');
    if (
      rel.includes('/node_modules/')
      || rel.includes('/target/')
      || rel.includes('/build/')
      || rel.includes('/dist/')
    ) continue;
    const st = statSync(path);
    if (st.isDirectory()) walk(path, out);
    else if (/\.(jsx?|mjs|cjs)$/.test(name)) out.push(rel);
  }
  return out;
}

const runtimeJs = RUNTIME_DIRS.flatMap(dir => walk(join(ROOT, dir)))
  .filter(path => !ALLOWED.has(path));

assert.deepEqual(runtimeJs, [], `mobile runtime JS must migrate to TS/TSX:\n${runtimeJs.join('\n')}`);

console.log('jsToTsMigration.selftest: mobile runtime has no JS/JSX source files');
