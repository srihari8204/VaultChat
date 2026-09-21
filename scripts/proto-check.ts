#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/proto-check.js — fail if the generated codecs have drifted from the
 * .proto files.
 *
 * WHY THIS EXISTS. Until now nothing in this repo connected proto/ccwire/v1/*.proto
 * to the code that actually encodes frames. The two codecs (lib/ccwire/codec.ts and
 * vaultchat-backend-go/internal/ccwire/codec.go) are hand-written, the .proto files
 * were documentation, and a field number changed in one place was caught by nothing.
 * Generated code only helps if regeneration is proven to be a no-op — otherwise it
 * becomes a third thing that drifts.
 *
 * It regenerates into a temp directory and compares. It never writes into the repo,
 * so it is safe to run from `npm test`.
 *
 * ponytail: byte-compares whole files rather than parsing them. If protoc-gen-es
 * ever emits a timestamp or version banner that changes without the schema
 * changing, this turns into a false failure — switch to ignoring the @generated
 * header line at that point, not before.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// --write regenerates in place (the repo's own 'contract/inventory.js --write' idiom).
const WRITE = process.argv.includes('--write');

/**
 * Both generated trees. Go is checked too, and that is the point: generated Go
 * that nobody re-verifies drifts exactly like the hand-written codec it was
 * added to reconcile. The Go half SKIPS (not fails) when protoc-gen-go is
 * absent, matching how scripts/test-all.js treats the migration suite — a
 * developer without a Go toolchain is not blocked, but the check is real for
 * anyone who has one.
 */
const TARGETS = [
  // protoc-gen-es is an npm bin, already on the PATH built below.
  { name: 'typescript', config: 'buf.gen.yaml', plugin: null },
  { name: 'go', config: 'buf.gen.go.yaml', plugin: 'protoc-gen-go' },
];

/**
 * The real buf template is the single source of truth for BOTH generating and
 * checking. An earlier version of this file embedded a copy of each template
 * and carried a comment admitting it had to be hand-synced — which is the same
 * drift hazard this script exists to catch, one level up. Now the only thing
 * rewritten is the `out:` line, so a plugin or option added to buf.gen.yaml is
 * covered automatically.
 *
 * EVERY `out:` LINE, NOT THE FIRST. Each template holds one plugin today, and
 * an earlier version of this function took `.find(...)` — the first match — and
 * redirected only that one. Adding a second plugin to a template would then
 * have meant: the first plugin's output goes to the temp dir and is compared,
 * and the SECOND plugin's `out:` still points into the repo, so a read-only
 * `npm test` would quietly REGENERATE the committed tree and then find no
 * drift. A drift check that fixes the drift it was looking for reports success
 * forever. Every out: is redirected and every one is compared.
 */
function readTemplate(config) {
  const raw = fs.readFileSync(path.join(ROOT, config), 'utf8');
  const outs = raw.split(/\r?\n/)
    .filter((l) => /^\s*out:\s*/.test(l))
    .map((l) => l.replace(/^\s*out:\s*/, '').trim());
  if (!outs.length) throw new Error(config + ': no `out:` line found');
  return { raw, outs };
}

/** GOPATH/bin, where `go install` puts protoc-gen-go. Not on PATH by default. */
function goBin() {
  try {
    const p = execFileSync('go', ['env', 'GOPATH'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return p ? path.join(p, 'bin') : null;
  } catch { return null; }
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out.sort();
}

/**
 * The platform binary directly, NOT npx: spawnSync on a .cmd shim raises EINVAL
 * on current Node for Windows, and going through a shell to dodge that would
 * mean hand-quoting temp paths.
 */
function findBuf() {
  const scope = path.join(ROOT, 'node_modules', '@bufbuild');
  if (!fs.existsSync(scope)) return null;
  const exe = process.platform === 'win32' ? 'buf.exe' : 'buf';
  for (const d of fs.readdirSync(scope)) {
    if (!d.startsWith('buf-')) continue;
    const p = path.join(scope, d, 'bin', exe);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const buf = findBuf();
if (!buf) {
  console.error('proto-check: no buf binary under node_modules/@bufbuild — run npm install');
  process.exit(1);
}

// protoc-gen-* plugins must be reachable on PATH for buf to invoke them.
const env = Object.assign({}, process.env);
const pathParts = [path.join(ROOT, 'node_modules', '.bin')];
const gb = goBin();
if (gb) pathParts.push(gb);
env.PATH = pathParts.join(path.delimiter) + path.delimiter + process.env.PATH;

function have(plugin) {
  if (!plugin) return true;
  const exe = process.platform === 'win32' ? plugin + '.exe' : plugin;
  return pathParts.some((d) => fs.existsSync(path.join(d, exe)));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-check-'));
const problems = [];
let checked = 0;
try {
  for (const t of TARGETS) {
    if (!have(t.plugin)) {
      console.log('proto codegen [' + t.name + ']: SKIPPED — ' + t.plugin + ' not found');
      continue;
    }
    const { raw, outs } = readTemplate(t.config);

    if (WRITE) {
      execFileSync(buf, ['generate', 'proto', '--template', path.join(ROOT, t.config)],
        { cwd: ROOT, stdio: 'pipe', env });
      console.log('proto codegen [' + t.name + ']: regenerated into ' + outs.join(', '));
      continue;
    }

    // One temp tree per out:, in template order, so two plugins writing to the
    // same committed directory still get compared separately.
    const freshRoots = outs.map((_, i) => path.join(tmp, t.name + (i ? '.' + i : '')));
    let n = 0;
    const template = path.join(tmp, t.name + '.gen.yaml');
    fs.writeFileSync(template,
      raw.replace(/^(\s*out:\s*).*$/gm, (_m, lead) => lead + freshRoots[n++].replace(/\\/g, '/')));
    if (n !== outs.length) throw new Error(t.config + ': redirected ' + n + ' of ' + outs.length + ' out: lines');
    execFileSync(buf, ['generate', 'proto', '--template', template], { cwd: ROOT, stdio: 'pipe', env });

    const rel = (base) => (f) => path.relative(base, f).replace(/\\/g, '/');
    let files = 0;
    for (let i = 0; i < outs.length; i++) {
      const freshRoot = freshRoots[i];
      const committedOut = path.join(ROOT, outs[i]);
      const where = outs.length > 1 ? t.name + ' -> ' + outs[i] : t.name;
      const freshNames = listFiles(freshRoot).map(rel(freshRoot));
      const committedNames = listFiles(committedOut).map(rel(committedOut));

      for (const f of freshNames) if (!committedNames.includes(f)) problems.push(where + ': missing from the repo: ' + f);
      for (const f of committedNames) if (!freshNames.includes(f)) problems.push(where + ': stale, no longer generated: ' + f);
      for (const f of freshNames) {
        if (!committedNames.includes(f)) continue;
        const a = fs.readFileSync(path.join(freshRoot, f), 'utf8');
        const b = fs.readFileSync(path.join(committedOut, f), 'utf8');
        if (a !== b) problems.push(where + ': out of date: ' + f);
      }
      files += freshNames.length;
    }
    checked += files;
    console.log('proto codegen [' + t.name + ']: ' + files + ' files');
  }

  if (problems.length) {
    console.error('\n  proto drift — generated code does not match proto/:');
    for (const p of problems) console.error('    ' + p);
    console.error('\n  Fix with: npm run proto:gen   (and, for go, buf generate proto --template buf.gen.go.yaml)\n');
    process.exit(1);
  }
  if (WRITE) { console.log('proto codegen regenerated'); } else {
    console.log('proto codegen is up to date (' + checked + ' files)');
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
