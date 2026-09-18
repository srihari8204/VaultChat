// lib/apiBypasses.selftest.ts — run: npx tsx lib/apiBypasses.selftest.ts
//
// EVERY RAW fetch(SERVER_URL…) IS AN OPT-OUT OF THE FUNNEL.
//
// lib/api.ts is where the 401 refresh-and-retry, the `expectedUserId`
// account-ownership guard, the X-Device-Id header and the 30s abort backstop
// live. A call site that builds its own URL and its own Authorization header
// gets none of them, silently — nothing fails, the request just goes out
// weaker than every other request in the app.
//
// protobuf-migration 4.6 reviewed the six that existed, routed the one that
// could be routed (POST /uploads, no-progress path) and wrote the rest down in
// inventory.md §4a with a reason each. This guard is the half that a document
// cannot do: it fails when a SEVENTH appears.
//
// It is a source scan, not a behaviour test, and it says so. It cannot tell a
// justified bypass from a lazy one — that judgement is in inventory.md. What
// it can do is make adding one a deliberate act: a new bypass fails here, and
// the only way to green is to add it to the list below, which is the moment
// somebody has to write down why.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['lib', 'app', 'services', 'components', 'utils', 'hooks'];
const SKIP = new Set(['node_modules', '.git', 'android', 'ios', 'dist', 'vaultchat-backend-go']);

let n = 0;
function ok(msg: string, cond: boolean) {
  n++;
  assert.ok(cond, msg);
  console.log(`  ✓ ${msg}`);
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') && !e.name.endsWith('.selftest.ts')) out.push(p);
  }
  return out;
}

// `${SERVER_URL}` or the `serverUrl` parameter deviceService takes — both are
// "the API origin", however it was spelled at the call site. XMLHttpRequest is
// listed because it cannot go through api() at all (fetch has no upload
// progress), so it is a bypass by construction.
const BYPASS = /fetch\(\s*`\$\{(?:SERVER_URL|serverUrl)\}|new\s+XMLHttpRequest/;

const found: string[] = [];
for (const d of SCAN_DIRS) {
  for (const file of walk(path.join(ROOT, d))) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const src = fs.readFileSync(file, 'utf8');
    src.split('\n').forEach((line, i) => {
      if (BYPASS.test(line)) found.push(`${rel}:${i + 1}`);
    });
  }
}

// The reviewed set. Line numbers are deliberately NOT pinned — they drift on
// every edit above them and a guard that fails on drift gets muted. The file
// is the unit; a second bypass in an already-listed file is caught by the
// count, which is why the count is asserted separately below.
const ALLOWED: Record<string, string> = {
  // Inside the funnel's own refresh path. Routing it through api() is circular.
  'lib/api.ts': 'POST /auth/refresh — the funnel refreshing itself',
  // Pre-auth, must answer before a session or a decoder exists.
  'lib/appVersion.ts': 'GET /app/version — runs before auth',
  'lib/remoteFlags.ts': 'GET /app/flags — module scope, pre-auth, cold start',
  'lib/serverTime.ts': 'GET /health — clock-skew probe, pre-auth',
  // GET /user/export wants the raw bytes; XHR is the upload-progress path.
  'lib/chatService.ts': '/user/export raw text + the XHR upload-progress path',
};

for (const site of found) {
  const file = site.split(':')[0];
  ok(`${site} is a reviewed bypass (${ALLOWED[file] ?? 'UNREVIEWED'})`, file in ALLOWED);
}

// Six sites across five files — the three dead /api/face/* bypasses went with
// the face-scan flow. A new bypass inside an already-listed file slips past the
// per-site check above; this is what catches it.
ok(`exactly 6 reviewed bypass sites remain (found ${found.length}: ${found.join(', ')})`,
   found.length === 6);

// The one that WAS routed in 4.6. Asserting the absence of the old raw fetch
// is not enough — it would also pass if uploadAttachment were deleted.
const chat = fs.readFileSync(path.join(ROOT, 'lib/chatService.ts'), 'utf8');
ok('uploadAttachment POSTs /uploads through api(), not a raw fetch',
   /api<UploadResult>\(\s*`\/uploads\$\{qs\}`/.test(chat));
ok('...and still hands the XHR progress path its own Bearer header',
   /postWithProgress\(url, form, headers,/.test(chat));

console.log(`\napiBypasses.selftest: ${n} assertions passed`);
