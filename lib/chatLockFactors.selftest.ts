// lib/chatLockFactors.selftest.ts — run: npx tsx lib/chatLockFactors.selftest.ts
//
// Two defects in the per-chat lock, both invisible when they come back,
// because the chat opens — which is what it looks like when it is working:
//
//   • lockMethod 'both' was enforced as EITHER. A biometric alone opened the
//     chat, a PIN alone opened the chat, and either alone authorised a full
//     plaintext export. The user who chose the strongest setting was the only
//     one who thought they had two factors.
//   • verifyBiometric() returned true unconditionally on web — a configured
//     platform (app.json) — so in a browser build every biometric-locked chat
//     and its export gate opened with no check at all.
//
// 2026-09-17, second pass. The old version of this file was regex-over-source
// asserting the presence of lines its author had just written, so it PASSED BY
// CONSTRUCTION — including one check, "'pin' and 'biometric' alone still
// unlock", that matched a SUBSTRING of the 'both' conditions and so held
// whether or not single-factor unlock worked at all. It also never opened
// app/app-lock-chats.tsx, where the same factor rules decide whether a lock can
// be DELETED — a worse outcome than a chat merely opening.
//
// Rewritten around the one thing that cannot pass by construction: the real
// source of each decision is CUT OUT OF THE FILE AND EXECUTED against a truth
// table, with stubs standing in for react-native. These are not paraphrases of
// the logic. If an extraction goes stale the anchor throws; if the logic
// changes meaning, the table disagrees.
//
// Structural checks survive only where there is nothing to run — the wording
// the veil shows the user, and the "web ⇒ yes" shape that must not reappear —
// and they are labelled as such.

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/** Source with // and /* *\/ comments stripped, so a comment describing the
 *  old behaviour can never satisfy — or trip — a structural assertion. */
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** From the first `open` at/after `from`, through its matching `close`. */
function spanAt(src: string, from: number, open = '{', close = '}'): string {
  if (from < 0) throw new Error('chatLockFactors.selftest: anchor not found');
  const s = src.indexOf(open, from);
  if (s === -1) throw new Error('chatLockFactors.selftest: no opening ' + open);
  let depth = 0;
  for (let i = s; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close && --depth === 0) return src.slice(s, i + 1);
  }
  throw new Error('chatLockFactors.selftest: unbalanced ' + open + close);
}
/** The statements inside a declaration's block, ready for new Function(). */
const bodyAt = (src: string, anchor: string) => {
  const i = src.indexOf(anchor);
  if (i === -1) throw new Error(`chatLockFactors.selftest: "${anchor}" is gone — this extraction is stale`);
  return spanAt(src, i).slice(1, -1);
};
/** Compile extracted source. Everything it references must be passed in, so a
 *  new dependency surfaces as a loud ReferenceError, not a silent pass.
 *
 *  The snippets are TypeScript (`let lock: LockedChat | null = null`), so the
 *  repo's own tsc strips the annotations rather than this file guessing at a
 *  regex for them — the extraction must stay faithful to the source or it is
 *  not testing the source. */
const js = (src: string) =>
  ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;
const compile = (params: string[], body: string, asAsync = false): any => {
  const wrapped = asAsync ? `return (async () => {${body}})();` : body;
  // eslint-disable-next-line no-eval
  return (0, eval)(js(`(function (${params.join(', ')}) {\n${wrapped}\n})`));
};

async function main() {
  console.log('\nChat-lock factor self-test\n');

  // ── verifyBiometric on web — the real source line, executed ─────────
  console.log('verifyBiometric fails closed on web:');
  {
    const src = code('lib/chatLock.ts');
    const fn = src.slice(src.indexOf('export async function verifyBiometric'));
    const guard = fn.slice(fn.indexOf('{') + 1, fn.indexOf('try {'));
    // Run the guard with Platform.OS === 'web'. If it has been removed, or
    // changed back to `return true`, we do not get false and this fails.
    const run = compile(['Platform'], `${guard}\nreturn 'fell through to the sensor path';`);
    const webResult = run({ OS: 'web' });
    check('the web branch returns false', webResult === false, String(webResult));
    check('nothing in chatLock.ts still answers "web ⇒ yes" [structural]',
      !/Platform\.OS === 'web'\)\s*return true/.test(src));
    // Executed for the same reason: the regex form of this one was satisfied by
    // hasBiometric's signature sitting near ANY web branch in the file.
    const hb = src.slice(src.indexOf('export async function hasBiometric'));
    const hbGuard = hb.slice(hb.indexOf('{') + 1, hb.indexOf('try {'));
    check('hasBiometric agrees (web has no biometrics)',
      compile(['Platform'], `${hbGuard}\nreturn 'fell through';`)({ OS: 'web' }) === false);
  }

  // ── 'both' means BOTH, in the chat screen ──────────────────────────
  console.log("\napp/chat.tsx enforces 'both' as AND:");
  {
    const c = code('app/chat.tsx');

    // The whole focus effect, run. One extraction covers the auto-unlock, the
    // per-visit reset of the banked factor and the fail-closed catch — three
    // things a substring match could not tell apart.
    const focusBodies = [...c.matchAll(/useFocusEffect\(useCallback\(/g)]
      .map((m) => spanAt(c, m.index!).slice(1, -1))
      .filter((b) => b.includes('getLock('));
    check('exactly one focus effect owns the per-chat lock', focusBodies.length === 1,
      `${focusBodies.length} found`);
    const focus = compile(
      ['getLock', 'verifyBiometric', 'chatId', 'setLockState', 'setLockInfo',
       'setLockPin', 'setLockErr', 'setLockBio'],
      focusBodies[0],
    );
    const onFocus = async (lock: any, sensor: boolean, unreadable = false) => {
      const st = { state: 'never-set', info: 'never-set' as any, bio: 'never-set' as any };
      focus(
        async () => { if (unreadable) throw new Error('lock table unreadable'); return lock; },
        async () => sensor, 'chat-1',
        (s: string) => { st.state = s; }, (i: any) => { st.info = i; },
        () => {}, () => {}, (b: boolean) => { st.bio = b; },
      );
      for (let i = 0; i < 8; i++) await Promise.resolve();   // drain the microtasks
      return st;
    };
    const both = await onFocus({ lockMethod: 'both', pinHash: 'h' }, true);
    check('a passing biometric does NOT open a "both" chat', both.state === 'locked', `state=${both.state}`);
    check('...but it IS banked as the first factor', both.bio === true, `lockBio=${both.bio}`);
    const bio = await onFocus({ lockMethod: 'biometric' }, true);
    check("a passing biometric DOES open a 'biometric' chat", bio.state === 'open', `state=${bio.state}`);
    check('...and a failing one does not',
      (await onFocus({ lockMethod: 'biometric' }, false)).state === 'locked');
    check("a 'pin' chat is never opened by the sensor",
      (await onFocus({ lockMethod: 'pin', pinHash: 'h' }, true)).state === 'locked');
    check('an unlocked chat opens without ceremony', (await onFocus(null, false)).state === 'open');
    const broke = await onFocus(null, false, true);
    check('an unreadable lock table fails CLOSED', broke.state === 'locked' && broke.info === null,
      `state=${broke.state} info=${String(broke.info)}`);
    check('the banked biometric is cleared on every focus [structural]',
      /setLockBio\(\s*false\s*\)/.test(focusBodies[0]),
      'otherwise leaving and returning to the chat needs only the PIN');

    // submitLockPin, run. This is the check the old file got most wrong: it
    // matched `lockInfo.lockMethod === 'both' && !lockBio` as a STRING, which
    // says nothing about what that branch then does.
    const submit = compile(
      ['lockInfo', 'lockPin', 'lockBio', 'verifyPin', 'setLockErr', 'setLockState', 'setLockPin'],
      bodyAt(c, 'const submitLockPin = useCallback('),
    );
    const onPin = (method: string, pin: string, banked: boolean) => {
      let state = 'locked';
      submit({ lockMethod: method, pinHash: 'h' }, pin, banked,
        (_l: any, p: string) => p === '1234', () => {}, (s: string) => { state = s; }, () => {});
      return state === 'open';
    };
    check('a correct PIN alone does NOT open a "both" chat', onPin('both', '1234', false) === false);
    check('...and does open it once the biometric is banked', onPin('both', '1234', true) === true);
    check('...and a wrong PIN never does', onPin('both', '9999', true) === false);
    check("a correct PIN DOES open a 'pin' chat", onPin('pin', '1234', false) === true);
    check('...and a wrong PIN does not', onPin('pin', '9999', false) === false);

    // The veil's own biometric button, run: it must bank the factor rather than
    // lift the veil when the chat wants both.
    const btns = [...c.matchAll(/onPress=\{async \(\) => \{/g)]
      .map((m) => spanAt(c, m.index! + 'onPress={'.length).slice(1, -1))
      .filter((b) => b.includes('verifyBiometric'));
    check('exactly one button on the veil calls the sensor', btns.length === 1, `${btns.length} found`);
    const btn = compile(['verifyBiometric', 'lockInfo', 'setLockBio', 'setLockState'], btns[0], true);
    const onTap = async (method: string, sensor: boolean) => {
      const st = { state: 'locked', bio: false };
      await btn(async () => sensor, { lockMethod: method },
        (b: boolean) => { st.bio = b; }, (s: string) => { st.state = s; });
      return st;
    };
    const tapBoth = await onTap('both', true);
    check('the veil’s biometric button does not open a "both" chat either',
      tapBoth.state === 'locked' && tapBoth.bio === true, `state=${tapBoth.state} bio=${tapBoth.bio}`);
    check('...but it does open a biometric-only chat', (await onTap('biometric', true)).state === 'open');
    const refused = await onTap('biometric', false);
    check('...and a refused scan banks nothing', refused.state === 'locked' && refused.bio === false);

    // Wording, not behaviour — so it stays a text check, and admits it.
    check('the veil tells the user both factors are required [structural]',
      /needs both biometrics and its PIN/.test(c),
      'without this the user sees a veil after a successful scan and assumes a bug');
  }

  // ── 'both' means BOTH, in the export gate ──────────────────────────
  console.log("\napp/chat-export.tsx enforces 'both' as AND:");
  {
    const e = code('app/chat-export.tsx');
    const auth = bodyAt(e, 'const authorizeExport =');
    const gateAt = auth.indexOf('const deny =');
    check('the export gate still ends in the factor checks', gateAt !== -1);
    const gate = compile(['lock', 'Alert', 'verifyBiometric', 'askPin', 'confirm'], auth.slice(gateAt), true);
    // pinHash is nulled, never undefined: an explicit `undefined` argument
    // re-triggers the JS default and quietly restores the hash.
    const tryExport = async (method: string, sensor: boolean, pin: boolean, pinHash: string | null = 'h') => {
      const calls = { bio: 0, pin: 0 };
      const allowed = await gate(
        { lockMethod: method, pinHash },
        { alert: () => {} },
        async () => { calls.bio++; return sensor; },
        async () => { calls.pin++; return pin; },
        async () => 'CONFIRM-REACHED',
      );
      return { allowed, ...calls };
    };
    const bothNoBio = await tryExport('both', false, true);
    check('a biometric alone cannot export a "both" chat',
      bothNoBio.allowed === false && bothNoBio.pin === 0, JSON.stringify(bothNoBio));
    const bothNoPin = await tryExport('both', true, false);
    check('a PIN alone cannot export a "both" chat', bothNoPin.allowed === false, JSON.stringify(bothNoPin));
    const bothOk = await tryExport('both', true, true);
    check('...and both together can', bothOk.allowed === 'CONFIRM-REACHED', JSON.stringify(bothOk));
    const pinOnly = await tryExport('pin', false, true);
    check("a 'pin' chat is gated on its PIN and never on the sensor",
      pinOnly.allowed === 'CONFIRM-REACHED' && pinOnly.bio === 0, JSON.stringify(pinOnly));
    check('...and a wrong PIN denies', (await tryExport('pin', false, false)).allowed === false);
    const bioOnly = await tryExport('biometric', true, false);
    check("a 'biometric' chat passes on its sensor without a PIN",
      bioOnly.allowed === 'CONFIRM-REACHED' && bioOnly.pin === 0, JSON.stringify(bioOnly));
    const fallback = await tryExport('biometric', false, true);
    check('...and falls back to the PIN when the sensor says no (the only route on web)',
      fallback.allowed === 'CONFIRM-REACHED' && fallback.pin === 1, JSON.stringify(fallback));
    check('a missing PIN hash denies rather than waves through',
      (await tryExport('pin', false, true, null)).allowed === false);
    check('the gate still runs before any export work [structural]',
      /if \(!\(await authorizeExport\(\)\)\) return;/.test(e));
  }

  // ── Removing a lock must satisfy that lock ─────────────────────────
  // app/app-lock-chats.tsx was never opened by the old version of this file,
  // and it is where the factor rules bite hardest: these paths DELETE the lock
  // rather than merely open the chat behind it.
  console.log('\napp/app-lock-chats.tsx enforces the same factors to REMOVE a lock:');
  {
    const a = code('app/app-lock-chats.tsx');
    const toggle = compile(
      ['chat', 'lockedChats', 'bioAvailable', 'Alert', 'verifyBiometric', 'askUnlockPin',
       'removeChatLock', 'reloadLocks', 'setConfigMethod', 'setConfigTimer', 'setConfigChat'],
      bodyAt(a, 'const toggleLock ='), true,
    );
    const tryRemove = async (method: string, sensor: boolean, pin: boolean, bioAvailable = true) => {
      const calls = { bio: 0, pin: 0, removed: 0, alerts: 0 };
      await toggle(
        { id: 'c1', name: 'Chat' },
        { c1: { locked: true, lockMethod: method, pinHash: 'h' } }, bioAvailable,
        { alert: () => { calls.alerts++; } },
        async () => { calls.bio++; return sensor; },
        async () => { calls.pin++; return pin; },
        async () => { calls.removed++; }, async () => {},
        () => {}, () => {}, () => {},
      );
      return calls;
    };
    const pinLock = await tryRemove('pin', true, false);
    check("a 'pin' lock cannot be removed on a fingerprint",
      pinLock.removed === 0 && pinLock.bio === 0, JSON.stringify(pinLock));
    check('...and comes off with its own PIN', (await tryRemove('pin', false, true)).removed === 1);
    const bothBio = await tryRemove('both', true, false);
    check("a 'both' lock is not removed by the sensor alone",
      bothBio.removed === 0 && bothBio.pin === 1, JSON.stringify(bothBio));
    const bothPin = await tryRemove('both', false, true);
    check('...nor by the PIN alone', bothPin.removed === 0 && bothPin.pin === 0, JSON.stringify(bothPin));
    check('...and comes off only with both', (await tryRemove('both', true, true)).removed === 1);
    // The hole that was here: `bioAvailable ? verify : true` removed a biometric
    // lock with NO verification of any kind on a device with nothing enrolled —
    // and on web, where hasBiometric() is always false.
    const noSensor = await tryRemove('biometric', true, true, false);
    check('a biometric lock is not removed where no biometric exists',
      noSensor.removed === 0 && noSensor.alerts === 1, JSON.stringify(noSensor));

    // The other half of that fix: a factor this device cannot produce must not
    // be offerable, or closing the removal hole leaves the chat unreadable AND
    // its lock undeletable, in three taps.
    const fi = a.indexOf('LOCK_METHOD_OPTIONS.filter');
    check('the method chips are still filtered by what the device can do', fi !== -1);
    const call = 'LOCK_METHOD_OPTIONS.filter' + spanAt(a, fi, '(', ')');
    const filter = compile(['LOCK_METHOD_OPTIONS', 'bioAvailable'], `return ${call};`);
    const OPTS = [{ value: 'biometric' }, { value: 'pin' }, { value: 'both' }];
    check('with no biometric enrolled, only PIN is offerable',
      JSON.stringify(filter(OPTS, false).map((o: any) => o.value)) === '["pin"]',
      JSON.stringify(filter(OPTS, false)));
    check('with one enrolled, all three are', filter(OPTS, true).length === 3);
  }
}

main().then(() => {
  console.log(failures === 0
    ? '\nAll chat-lock factor checks passed.\n'
    : `\n${failures} chat-lock factor check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}, (err) => {
  // An extraction that no longer parses or no longer finds its anchor is a
  // FAILURE, not a skip — that is exactly how a guard quietly stops guarding.
  console.error('\nchat-lock factor self-test could not run:', err);
  process.exit(1);
});
