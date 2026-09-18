/**
 * lib/keyboardAvoidance.selftest.ts
 *   run with: npx tsx lib/keyboardAvoidance.selftest.ts
 *
 * Two keyboard bugs in this app are invisible on iOS and total on Android.
 * Both look like working code, which is why review never caught either.
 *
 * 1. `<KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' :
 *    undefined}>`. React Native's KeyboardAvoidingView switches on `behavior`
 *    and its `default:` branch returns a plain View. An undefined behavior is
 *    therefore not "the platform default" — it is NO avoidance at all. The
 *    usual excuse (the manifest's windowSoftInputMode=adjustResize will handle
 *    it) does not hold here either: android/gradle.properties sets
 *    edgeToEdgeEnabled=true, so the window is never resized. Omitting the prop
 *    entirely is the same bug with less to read.
 *
 *    This is the rule that would have caught app/security-questions.tsx, the
 *    ACCOUNT RECOVERY screen, where the keyboard covered both the answer field
 *    and the Save button — on the one screen a locked-out user has left.
 *
 * 2. A `<Modal>` holding a `<TextInput>` with no keyboard handling inside it.
 *    A React Native Modal is its OWN Android window. It never receives the
 *    activity's adjustResize, so a composer inside one is covered by the
 *    keyboard no matter what the manifest says and no matter what `behavior`
 *    the KeyboardAvoidingView was given — 'padding' inside a Modal mixes
 *    Modal-relative layout coordinates with absolute screen coordinates and
 *    comes up short even on iOS.
 *
 * The fix for both is components/ui/KeyboardSafe.tsx, which pads by a measured
 * keyboard inset and depends on no window flag.
 *
 * Opt out in place with `keyboard-exempt:` and a reason on the same line or the
 * line above, the same convention as the layout and theme guards.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

let n = 0;
const ok = (label: string, cond: boolean) => { assert.ok(cond, label); n++; };

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.expo', 'dist', 'android', 'ios'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.tsx')) out.push(p.split(path.sep).join('/'));
  }
  return out;
}

const FILES = [...walk('app'), ...walk('components')];

/**
 * Blank out comments, keeping every newline so reported line numbers stay
 * true. Without this the guard trips on its own documentation: KeyboardSafe's
 * header comment quotes the broken `behavior` expression it exists to replace,
 * and every repaired site carries a note naming what it used to be. A guard
 * that fires on the explanation of the fix is noise, and noise gets muted.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[^]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

/** The opening tag starting at `from`, i.e. up to the first `>` outside braces. */
function openingTag(src: string, from: number): string {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return src.slice(from, i + 1);
  }
  return src.slice(from);
}

/** True when `keyboard-exempt:` sits in the tag or on the line just above it. */
function exempted(src: string, index: number, tag: string): boolean {
  if (tag.includes('keyboard-exempt:')) return true;
  const before = src.slice(Math.max(0, index - 400), index);
  const lines = before.split('\n');
  return lines.slice(-4).join('\n').includes('keyboard-exempt:');
}

// ── 1. No keyboard-avoiding wrapper whose behaviour is undefined ──────
const inert: string[] = [];
for (const file of FILES) {
  const raw = fs.readFileSync(file, 'utf8');
  const src = stripComments(raw);
  const re = /<KeyboardAvoidingView[\s/>]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const tag = openingTag(src, m.index);
    // Exemptions live in comments, so they are read off the RAW source.
    if (exempted(raw, m.index, raw.slice(m.index, m.index + tag.length))) continue;
    const line = src.slice(0, m.index).split('\n').length;
    const behavior = /\bbehavior\s*=\s*(\{[^]*?\}|"[^"]*"|'[^']*')/.exec(tag);
    if (!behavior) {
      inert.push(`${file}:${line}  no behavior prop — defaults to undefined`);
      continue;
    }
    if (/\bundefined\b/.test(behavior[1])) {
      inert.push(`${file}:${line}  behavior can resolve to undefined: ${behavior[1].replace(/\s+/g, ' ')}`);
    }
  }
}
ok(
  inert.length === 0
    ? 'no keyboard-avoiding wrapper resolves to undefined on Android'
    : 'KeyboardAvoidingView with a behaviour that is inert on Android — use components/ui/KeyboardSafe instead:\n      ' +
        inert.join('\n      '),
  inert.length === 0,
);

// ── 2. A Modal that holds a TextInput handles the keyboard itself ─────
//
// KeyboardSafe is the answer for almost all of these; a component that
// measures the keyboard itself (components/call/CallChatSheet.tsx lifts its
// sheet by the measured height) is equally correct and passes on the listener.
const HANDLED = /KeyboardSafe|useKeyboardInset|keyboardDidShow|keyboardWillShow/;
const unhandled: string[] = [];
for (const file of FILES) {
  const raw = fs.readFileSync(file, 'utf8');
  const src = stripComments(raw);
  const lines = src.split('\n');
  const rawLines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/<Modal[\s/>]/.test(lines[i])) continue;
    let depth = 0, end = -1;
    for (let j = i; j < lines.length; j++) {
      depth += (lines[j].match(/<Modal[\s>]/g) ?? []).length;
      depth -= (lines[j].match(/<\/Modal>/g) ?? []).length;
      if (depth <= 0 && j > i) { end = j; break; }
    }
    if (end < 0) break;
    const block = lines.slice(i, end + 1).join('\n');
    const start = i;
    i = end;
    if (!/<TextInput/.test(block)) continue;
    if (HANDLED.test(block)) continue;
    if (rawLines.slice(start, end + 1).join('\n').includes('keyboard-exempt:')) continue;
    unhandled.push(`${file}:${start + 1}`);
  }
}
ok(
  unhandled.length === 0
    ? 'every Modal holding a TextInput handles the keyboard itself'
    : 'a React Native Modal is its own window and never gets adjustResize — these composers are covered:\n      ' +
        unhandled.join('\n      '),
  unhandled.length === 0,
);

// ── 3. The account-recovery repair stays repaired ─────────────────────
//
// Rule 1 already fails if this screen goes back to an undefined behavior, but
// it is worth naming: security-questions is the last door a locked-out user
// has, and a silent regression here is not visible until someone is locked out.
const recovery = fs.readFileSync('app/security-questions.tsx', 'utf8');
ok('account recovery routes its form through KeyboardSafe', /<KeyboardSafe\b/.test(recovery));

// ── 4. KeyboardSafe itself still pads rather than translates ──────────
//
// The whole premise above is that KeyboardSafe works without any window flag.
// A transform-based rewrite would push the header off the top of a short
// screen and would silently un-fix every site routed through it.
const ks = fs.readFileSync('components/ui/KeyboardSafe.tsx', 'utf8');
ok('KeyboardSafe avoids by padding, not by transform', /paddingBottom/.test(ks) && !/translateY/.test(ks));
ok('KeyboardSafe takes the max of keyboard and safe area, never the sum',
   /Math\.max\(kb, insets\.bottom\)/.test(ks));

console.log(`keyboardAvoidance.selftest: ${n} assertions passed`);
