// Admin web pages (admin/*.html) — static checks that need no browser.
//
// 1. Each page's CSP pins the SHA-256 of its ONE real inline script (HTML
//    comments stripped first, so the regex text in the CSP comment does not
//    count). An edit without a re-pin makes the page refuse to run at all.
// 2. No inline event handlers or javascript: URLs (the CSP has no
//    'unsafe-inline' for scripts, so they would be dead anyway).
// 3. The pure helpers inside the pages behave: logs.html highlights against
//    the raw text (a filter such as "lt" must not split &lt;), and
//    shopbook.html's entitlement expiry check.
// 4. Every page's style-src pins a hash instead of 'unsafe-inline': its ONE
//    <style> element, and no style="" attribute anywhere.
// 5. shopbook.html asks for notes in inline forms: no prompt() is left; both
//    forms save through one helper; an early Confirm says why it was ignored.
// 6. logs.html and shopbook.html keep every stylesheet colour in :root tokens.
// 7. index.html's @font-face files exist where LOGS_DEPLOY.md copies them from.
//
// Run: npx tsx admin/adminPages.selftest.ts
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const dir = __dirname;
const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');

function inlineScript(page: string, html: string): string {
  const live = html.replace(/<!--[\s\S]*?-->/g, '');
  const scripts = [...live.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1, `${page}: expected exactly one <script> element`);
  assert.equal(scripts[0][1].trim(), '', `${page}: the script must be inline (no src/attributes)`);
  const scriptSrc = /script-src ([^;"]*)/.exec(live);
  assert.ok(scriptSrc, `${page}: CSP meta with script-src`);
  const pinned = [...scriptSrc[1].matchAll(/'sha256-([^']+)'/g)].map((m) => m[1]);
  assert.ok(!/unsafe-inline/.test(scriptSrc[1]), `${page}: script-src must not allow 'unsafe-inline'`);
  const body = scripts[0][2];
  const hash = crypto.createHash('sha256').update(body, 'utf8').digest('base64');
  assert.deepEqual(pinned, [hash], `${page}: CSP pins ${pinned.join(',')} but the script hashes to ${hash} — re-pin it`);
  const markup = live.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  assert.ok(!/<[^>]*\son[a-z]+\s*=/i.test(markup), `${page}: inline on*= handler in markup`);
  assert.ok(!/<[a-z][^<>`]*\son[a-z]+\s*=/i.test(body), `${page}: on*= handler in a script template`);
  assert.ok(!/javascript:/i.test(live), `${page}: javascript: URL`);
  const styleSrc = /style-src ([^;"]*)/.exec(live);
  assert.ok(styleSrc && !/unsafe-inline/.test(styleSrc[1]), `${page}: style-src must pin the stylesheet, not allow 'unsafe-inline'`);
  {
    const styles = [...live.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi)];
    assert.equal(styles.length, 1, `${page}: expected exactly one <style> element`);
    const stylePins = [...styleSrc[1].matchAll(/'sha256-([^']+)'/g)].map((m) => m[1]);
    const styleHash = crypto.createHash('sha256').update(styles[0][2], 'utf8').digest('base64');
    assert.deepEqual(stylePins, [styleHash], `${page}: style-src pins ${stylePins.join(',')} but the stylesheet hashes to ${styleHash} — re-pin it`);
    const noStyle = live.replace(/<style\b[\s\S]*?<\/style>/gi, '');
    assert.ok(!/\sstyle\s*=/i.test(noStyle), `${page}: a style="" attribute is blocked by the pinned style-src`);
  }
  return body;
}

// The source of `function name(...) {...}` (brace-matched) from a page script.
function fnSource(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`function ${name}: unbalanced braces`);
}
const lineOf = (src: string, decl: string): string => {
  const m = new RegExp(`^\\s*(${decl}.*;)\\s*$`, 'm').exec(src);
  assert.ok(m, `declaration ${decl} not found`);
  return m[1];
};

const scripts: Record<string, string> = {};
for (const page of ['index.html', 'logs.html', 'shopbook.html']) scripts[page] = inlineScript(page, read(page));

// ── logs.html: highlight by text, not by escaped HTML ──
{
  const s = scripts['logs.html'];
  const lineHtml = new Function(
    [lineOf(s, 'const esc = '), lineOf(s, 'const stripAnsi = '), fnSource(s, 'classify'), fnSource(s, 'lineHtml'), 'return lineHtml;'].join('\n'),
  )() as (raw: string, q: string) => string;
  assert.equal(lineHtml('a <b> & c', ''), '<span class="ln">a &lt;b&gt; &amp; c</span>');
  // "lt" used to match inside "&lt;" and produce "&<mark>lt</mark>;".
  assert.equal(lineHtml('x < y alt', 'lt'), '<span class="ln">x &lt; y a<mark>lt</mark></span>');
  assert.equal(lineHtml('a & b', 'amp'), '<span class="ln">a &amp; b</span>');
  assert.equal(lineHtml('A <b> a', '<b>'), '<span class="ln">A <mark>&lt;b&gt;</mark> a</span>');
  assert.equal(lineHtml('Error at x', 'err'), '<span class="ln err"><mark>Err</mark>or at x</span>');
  assert.equal(lineHtml('a.b axb', '.'), '<span class="ln">a<mark>.</mark>b axb</span>', 'the filter is literal, not a regex');
  assert.equal(lineHtml('\x1b[31mred\x1b[0m', 'red'), '<span class="ln"><mark>red</mark></span>');
}

// ── shopbook.html: entitlement expiry (the inline form's validation) ──
{
  const s = scripts['shopbook.html'];
  const expiry = new Function(`${fnSource(s, 'entitlementExpiry')}\nreturn entitlementExpiry;`)() as (
    plan: string, raw: string, today: string, badInput: boolean) => { expiresAt?: string; error?: string };
  const today = '2026-10-04';
  assert.deepEqual(expiry('free', '2001-01-01', today, true), { expiresAt: '' }, 'the free plan ignores the date');
  assert.deepEqual(expiry('pro', '', today, false), { expiresAt: '' }, 'blank = no expiry');
  assert.deepEqual(expiry('pro', '2026-12-31', today, false), { expiresAt: '2026-12-31T23:59:59Z' });
  assert.ok(expiry('pro', '', today, true).error, 'a half-typed date is not "no expiry"');
  assert.ok(expiry('pro', today, today, false).error, 'today is refused');
  assert.ok(expiry('pro', '2026-10-03', today, false).error, 'the past is refused');
  assert.ok(expiry('pro', '2027-02-30', today, false).error, 'an impossible date is refused');
  assert.ok(expiry('pro', '31/12/2026', today, false).error, 'only YYYY-MM-DD');
  assert.ok(!/\bprompt\(/.test(s.replace(/\/\/.*$/gm, '')), 'shopbook.html: notes use the inline form, not prompt()');
  assert.ok(/CONFIRM_DELAY_MS\) \{\s*errEl\.textContent = '[^']+';\s*return;\s*\}/.test(fnSource(s, 'submitEntitlement')),
    'shopbook.html: a Confirm right after Review is ignored, with a cue in the form');
  for (const fn of ['submitNote', 'submitEntitlement']) {
    assert.ok(/await saveForm\(btn, errEl,/.test(fnSource(s, fn)), `shopbook.html: ${fn} saves through saveForm`);
    assert.ok(!/btn\.disabled = true/.test(fnSource(s, fn)), `shopbook.html: ${fn} hand-rolls the busy state again`);
  }
}

// ── logs.html: the status live region is written only when it changes ──
{
  const s = scripts['logs.html'];
  assert.ok(/if \(\$\('statustxt'\)\.textContent !== msg\)/.test(fnSource(s, 'setConnected')), 'logs.html: setConnected rewrites the status every poll');
  assert.ok(!/(?<!window\[area\]\.)\b(localStorage|sessionStorage)\.(get|set|remove)Item/.test(s), 'logs.html: storage outside the guarded helpers');
}

// ── stylesheet colours live in :root tokens (logs.html, shopbook.html) ──
for (const page of ['logs.html', 'shopbook.html']) {
  const css = /<style>([\s\S]*?)<\/style>/.exec(read(page))![1]
    .replace(/\/\*[\s\S]*?\*\//g, '')           // comments may quote old values
    .replace(/:root\s*\{[^}]*\}/g, '');            // the token blocks themselves
  const stray = css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g);
  assert.equal(stray, null, `${page}: colour literal outside :root (${stray}) — add a token`);
}

// ── index.html's fonts: every @font-face file is one the deploy can copy ──
{
  const deploy = read('LOGS_DEPLOY.md');
  for (const [, file] of read('index.html').matchAll(/src:url\(fonts\/([^)]+)\)/g)) {
    assert.ok(deploy.includes(file), `index.html: fonts/${file} is not in LOGS_DEPLOY.md's copy step`);
    const from = [path.join(dir, '..', 'assets', 'fonts', file), path.join(dir, 'fonts', file)];
    assert.ok(from.some((p) => fs.existsSync(p)), `index.html: fonts/${file} exists in neither assets/fonts nor admin/fonts`);
  }
}

console.log('adminPages selftest: 3 pages script- and style-pinned, stylesheet colours tokenised, fonts present, no inline handlers or prompt(); log highlight, status and entitlement expiry OK');
