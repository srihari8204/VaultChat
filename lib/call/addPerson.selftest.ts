// lib/call/addPerson.selftest.ts — an "Add" button must actually open something.
//
//   npx tsx lib/call/addPerson.selftest.ts
//
// SCOPE: STRUCTURAL. It reads source and asserts the wiring exists. It renders
// nothing, so it proves the sheet is mounted, not that it looks right.
//
// WHAT WENT WRONG
//
// app/voicecall.tsx and app/videocall.tsx both imported Sheet, declared
// `const [addSheet, setAddSheet] = useState(...)`, loaded contacts on tap and
// called setAddSheet — and never rendered <Sheet>. The state changed, the
// component re-rendered, and NOTHING appeared. The button was present,
// enabled, and completely inert: "the add option is there but not working".
//
// Nothing catches this. TypeScript is happy (the import is used as a type),
// the handler has no error path to take, and the only visible symptom is that
// a tap does nothing. app/group-call-active.tsx had rendered its equivalent
// sheet all along, which is why the GROUP add worked and the 1:1 add did not.
//
// Check 1 is the general form of the bug, so a third screen that imports Sheet
// and forgets to mount it fails here rather than on someone's phone.

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');

let failed = 0;
function A(ok: boolean, what: string): void {
  if (ok) { console.log('  ok   ' + what); return; }
  failed++;
  console.log('  FAIL ' + what);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith('.tsx')) out.push(p);
  }
  return out;
}

console.log('\nAdd-person wiring\n');

// ── 1. THE GENERAL RULE: import Sheet => mount Sheet ──────────────────
{
  const offenders: string[] = [];
  for (const f of walk(join(ROOT, 'app')).concat(walk(join(ROOT, 'components')))) {
    const src = readFileSync(f, 'utf8');
    if (!/from '[^']*ui\/Sheet'/.test(src)) continue;
    if (!/<Sheet[\s/>]/.test(src)) offenders.push(f.slice(ROOT.length + 1).replace(/\\/g, '/'));
  }
  A(offenders.length === 0,
    '1. every screen importing Sheet also renders <Sheet> — a screen that sets '
    + 'sheet state without mounting it has a button that silently does nothing'
    + (offenders.length ? `\n         offenders: ${offenders.join(', ')}` : ''));
}

// ── 2. the three call screens specifically ────────────────────────────
for (const rel of ['app/voicecall.tsx', 'app/videocall.tsx', 'app/group-call-active.tsx']) {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  const name = rel.slice(4);
  A(/<Sheet[\s/>]/.test(src), `2. ${name} mounts <Sheet>`);
  A(/visible=\{!!\w*[Ss]heet\}/.test(src), `2a. ${name} drives it from the sheet state`);
  A(/onClose=\{\(\) => set\w*[Ss]heet\(null\)\}/.test(src), `2b. ${name} can be dismissed`);
  A(/inviteToCall\(/.test(src), `2c. ${name} actually calls engine.inviteToCall`);
}

// ── 3. the sheet is not clipped by a scrolling strip ──────────────────
//
// videocall's controls are a horizontal ScrollView. A <Sheet> nested INSIDE it
// renders, but is clipped to the strip and scrolls with it — visually just as
// broken as not rendering, and harder to spot.
{
  const src = readFileSync(join(ROOT, 'app/videocall.tsx'), 'utf8');
  const sheetAt = src.indexOf('<Sheet');
  const closeAt = src.indexOf('</ScrollView>');
  A(sheetAt > closeAt && closeAt >= 0,
    '3. videocall mounts <Sheet> AFTER </ScrollView> — inside the horizontal '
    + 'control strip it would be clipped to that strip');
}

// ── 4. 1:1 may add (this is the whole point of migration 123) ─────────
{
  const eng = readFileSync(join(ROOT, 'lib/call/engine.ts'), 'utf8');
  const i = eng.indexOf('export async function inviteToCall');
  const body = eng.slice(i, i + 900);
  A(i >= 0 && !/if \(s\.peerUid\) return/.test(body),
    '4. inviteToCall no longer returns early on a 1:1 — that early return is '
    + 'what made a two-person call unable to become a three-person one');
  A(/u !== s\.meId && !live\[u\]/.test(body),
    '4a. and it never rings yourself or someone already on the call');
}

// ── 5. the list never offers a row that does nothing ──────────────────
//
// You are a member of EVERY direct chat, so a candidate list built from those
// chats contains you. inviteToCall then drops your own uid — so the row is
// shown, tapped, and silently does nothing. Same defect class as check 1.
for (const rel of ['app/voicecall.tsx', 'app/videocall.tsx']) {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  const i = src.indexOf('const addPerson');
  const body = src.slice(i, i + 1200);
  A(/new Set<string>\(\[[^\]]*meId[^\]]*\]\)/.test(body),
    `5. ${rel.slice(4)} excludes YOURSELF from the add list — you are in every `
    + 'direct chat, and inviteToCall drops your own uid');
}

// ── 6. the candidate list reads fields that EXIST ─────────────────────
//
// DEVICE-PROVEN FAILURE: the sheet opened and said "No other contacts to add
// yet" on a phone with eight chats. listChats() returns ChatSummary, which has
// NO `members` field — members live on ChatDetail (getChat). The loop read
// `(c as any).members ?? []`, got undefined every time, and produced an empty
// list on EVERY device, always.
//
// The `as any` is what made this invisible: it disabled the one check that
// would have caught it. Asserting on peerUserId keeps the code on typed
// fields, so tsc fails if the shape ever changes again.
for (const rel of ['app/voicecall.tsx', 'app/videocall.tsx']) {
  // COMMENTS STRIPPED FIRST. These checks assert on what the code reads, and
  // the comment explaining the bug necessarily names `.members` — without this
  // the check fails on its own documentation.
  const src = readFileSync(join(ROOT, rel), 'utf8')
    .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const i = src.indexOf('const addPerson');
  const body = src.slice(i, i + 1600);
  const name = rel.slice(4);
  A(/c\.peerUserId/.test(body),
    `6. ${name} builds the list from ChatSummary.peerUserId`);
  A(!/\.members/.test(body),
    `6a. ${name} does NOT read .members from listChats — ChatSummary has none, `
    + 'which made the list unconditionally empty');
  A(!/\(c as any\)/.test(body),
    `6b. ${name} does not cast the chat to any — that cast is what hid 6a from tsc`);
}

console.log(failed === 0 ? '\naddPerson: all checks passed' : `\naddPerson: ${failed} FAILED`);
if (failed > 0) process.exit(1);
