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
}

console.log('adminPages selftest: 3 pages hash-pinned, no inline handlers; log highlight and entitlement expiry OK');
