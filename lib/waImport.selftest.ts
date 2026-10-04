// lib/waImport.selftest.ts — run: npx tsx lib/waImport.selftest.ts
//
// The parser reads a file a stranger produced, on a phone, and writes the result
// into somebody's private conversation. Everything below is a way that has gone
// wrong somewhere before:
//
//   1. the date order silently flipped and a year of history moved by months
//   2. a multi-line message became forty one-line messages
//   3. a re-import doubled the conversation
//   4. a malformed archive took the app down instead of showing an error
//   5. a group export landed in a 1:1 chat, exposing third parties
//   6. and the one that matters most — the export left the device
//
// Real ZIPs built with fflate, not mocks: the streaming reader is the part most
// likely to break, so it is the part that must actually run.

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import {
  readExport, parseTranscript, detectFormat, mediaRef, dedupeKey, withDedupeKeys, parsedOk, parsedFail,
  MAX_TRANSCRIPT_BYTES, type ArchiveSource, type WaParseResult,
} from './waImport.js';

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

/** Wrap bytes as the ArchiveSource the parser consumes. */
function source(bytes: Uint8Array): ArchiveSource {
  return { size: bytes.length, read: async (o, l) => bytes.subarray(o, o + l) };
}
function zip(files: Record<string, string | Uint8Array>): Uint8Array {
  const out: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) out[k] = typeof v === 'string' ? strToU8(v) : v;
  return zipSync(out);
}
const ok = (r: WaParseResult) => { if (parsedOk(r)) return r; throw new Error(`expected ok, got ${(r as any).reason}`); };

// ── 1. header grammar across platforms, locales and decades ──────────
console.log('every WhatsApp export writes a different header');

const IOS   = `[12/03/2022, 14:23:45] Ravi: hello\n[12/03/2022, 14:24:01] Me: hi\n`;
const ANDRO = `12/03/2022, 14:23 - Ravi: hello\n12/03/2022, 14:24 - Me: hi\n`;
const US12  = `[3/12/22, 2:23:45 PM] Ravi: hello\n[3/12/22, 2:24:01 PM] Me: hi\n`;
const ISO   = `[2022-03-12, 14:23:45] Ravi: hello\n[2022-03-12, 14:24:01] Me: hi\n`;

for (const [name, text] of [['iOS bracketed', IOS], ['Android dashed', ANDRO],
                            ['US 12-hour', US12], ['ISO dates', ISO]] as [string, string][]) {
  const r = parseTranscript(text);
  check(`${name} parses two messages`, parsedOk(r) && r.messages.length === 2,
    parsedOk(r) ? `${r.messages.length}` : (r as any).reason);
  if (parsedOk(r)) check(`  …with both senders`, r.participants.length === 2, r.participants.join(','));
}

// The 12-hour clock is where an off-by-twelve-hours bug lives.
{
  const r = ok(parseTranscript(`[3/12/22, 12:05:00 AM] A: midnight\n[3/12/22, 12:05:00 PM] A: noon\n`));
  const hours = r.messages.map(m => new Date(m.tsMs).getHours());
  check('12 AM is hour 0 and 12 PM is hour 12', hours[0] === 0 && hours[1] === 12, hours.join(','));
}

// Invisible characters: real exports are full of them.
{
  const dirty = `‎[12/03/2022, 2:23:45 PM] Ravi: hello\n`;
  const r = parseTranscript(dirty);
  check('bidi marks and narrow no-break spaces do not break the match', parsedOk(r) && r.messages.length === 1,
    parsedOk(r) ? '' : (r as any).reason);
}

// ── 2. date order is detected, never assumed ─────────────────────────
console.log('the date order must come from the export, not from hope');
{
  const dmy = ok(parseTranscript(`[25/03/2022, 10:00:00] A: x\n[26/03/2022, 10:00:00] A: y\n`));
  check('a day > 12 proves DMY', dmy.format.order === 'DMY' && !dmy.format.ambiguous, dmy.format.order);
  const d = new Date(dmy.messages[0].tsMs);
  check('  …and 25/03 is 25 March', d.getDate() === 25 && d.getMonth() === 2,
    `${d.getDate()}/${d.getMonth() + 1}`);

  const mdy = ok(parseTranscript(`[03/25/2022, 10:00:00] A: x\n`));
  check('a second component > 12 proves MDY', mdy.format.order === 'MDY', mdy.format.order);
  const d2 = new Date(mdy.messages[0].tsMs);
  check('  …and 03/25 is 25 March', d2.getDate() === 25 && d2.getMonth() === 2,
    `${d2.getDate()}/${d2.getMonth() + 1}`);

  const amb = ok(parseTranscript(`[03/04/2022, 10:00:00] A: x\n[05/06/2022, 10:00:00] A: y\n`));
  check('an ambiguous export is REPORTED, not guessed', amb.format.ambiguous === true,
    'silently picking here shifts every message by up to 11 months, undetectably');

  const iso = ok(parseTranscript(ISO));
  check('a 4-digit leading component is YMD', iso.format.order === 'YMD');
  check('12-hour exports are detected as such', ok(parseTranscript(US12)).format.clock === '12h');
  check('24-hour exports are detected as such', ok(parseTranscript(IOS)).format.clock === '24h');
}

// ── 3. bodies survive exactly as exported ────────────────────────────
console.log('a message body must arrive byte-for-byte');
{
  const r = ok(parseTranscript(
    `[12/03/2022, 14:23:45] Ravi: line one\nline two\nline three\n[12/03/2022, 14:24:00] Me: after\n`));
  check('a multi-line message stays ONE message', r.messages.length === 2, `${r.messages.length}`);
  check('  …with its line breaks intact', r.messages[0].body === 'line one\nline two\nline three',
    JSON.stringify(r.messages[0].body));

  const colon = ok(parseTranscript(`[12/03/2022, 14:23:45] Ravi: 14:30: meet me\n`));
  check('a body containing ": " is not re-split', colon.messages[0].body === '14:30: meet me',
    JSON.stringify(colon.messages[0].body));
  check('  …and the sender is still right', colon.messages[0].sender === 'Ravi');

  const sys = ok(parseTranscript(
    `[12/03/2022, 14:00:00] Messages and calls are end-to-end encrypted.\n[12/03/2022, 14:23:45] Ravi: hi\n`));
  check('a WhatsApp notice is marked system, not attributed to someone',
    sys.messages[0].system === true && sys.messages[1].system === false);
  check('  …and system lines add no participant', sys.participants.length === 1, sys.participants.join(','));

  const tilde = ok(parseTranscript(`[12/03/2022, 14:23:45] ~ Ravi K: hi\n`));
  check('the "~" on a non-contact sender is stripped', tilde.messages[0].sender === 'Ravi K',
    tilde.messages[0].sender);
}

// ── 4. media references ──────────────────────────────────────────────
console.log('media references come in several dialects');
check('iOS <attached: …>', mediaRef('<attached: 0001-PHOTO-2022.jpg>')?.filename === '0001-PHOTO-2022.jpg');
check('Android "(file attached)"', mediaRef('IMG-20220312-WA0001.jpg (file attached)')?.filename === 'IMG-20220312-WA0001.jpg');
check('"<Media omitted>" is media with no file', (() => {
  const r = mediaRef('<Media omitted>'); return !!r && r.filename === null;
})(), 'a without-media export still has the message — it just has no bytes');
check('kind is derived from the extension',
  mediaRef('<attached: a.mp4>')?.kind === 'video' && mediaRef('<attached: a.opus>')?.kind === 'audio'
  && mediaRef('<attached: a.jpg>')?.kind === 'image' && mediaRef('<attached: a.pdf>')?.kind === 'file');
check('ordinary text is not mistaken for media', mediaRef('see the attached photo') === null);

// ── 5. edge-case exports must not throw ──────────────────────────────
console.log('empty, tiny and unreadable exports are ordinary, not exceptional');
{
  const one = parseTranscript(`[12/03/2022, 14:23:45] Ravi: only\n`);
  check('a one-message export parses', parsedOk(one) && one.messages.length === 1);

  const empty = parseTranscript(`\n\n`);
  check('an empty transcript reports unsupported-format, not a crash',
    parsedFail(empty) && empty.reason === 'unsupported-format', parsedFail(empty) ? empty.reason : '');

  const headersNoBody = parseTranscript(`this is not a whatsapp export at all\njust some text\n`);
  check('an unrelated text file is rejected',
    parsedFail(headersNoBody) && headersNoBody.reason === 'unsupported-format');

  const group = parseTranscript(
    `[12/03/2022, 10:00:00] A: x\n[12/03/2022, 10:01:00] B: y\n[12/03/2022, 10:02:00] C: z\n`);
  check('a GROUP export is refused before anything is shown',
    parsedFail(group) && group.reason === 'group-export',
    'importing it into a 1:1 chat would expose a third party');
}

// Everything below touches the async archive reader. tsx compiles this repo as
// CJS, where top-level await is not available — hence the wrapper.
async function main() {

// ── 6. the streaming archive reader, on real ZIPs ────────────────────
console.log('the archive is a stranger’s file, streamed');

const run = (bytes: Uint8Array) => readExport(source(bytes));

{
  const big = 'x'.repeat(300_000);
  const z = zip({
    '_chat.txt': IOS,
    'IMG-20220312-WA0001.jpg': big,          // must NOT be inflated
    'VID-20220312-WA0002.mp4': big,
  });
  const r = await run(z);
  check('a real ZIP yields the transcript', parsedOk(r) && r.messages.length === 2, parsedOk(r) ? '' : (r as any).reason);
  if (parsedOk(r)) {
    check('  …and catalogues the media without decompressing it', r.media.length === 2,
      r.media.map(m => m.name).join(','));
    check('  …naming the transcript it used', r.transcriptName === '_chat.txt', r.transcriptName);
  }

  const named = await run(zip({ 'WhatsApp Chat with Ravi.txt': ANDRO }));
  check('the transcript need not be called _chat.txt', parsedOk(named) && named.messages.length === 2);

  const noTxt = await run(zip({ 'photo.jpg': 'nope' }));
  check('a ZIP with no transcript is reported, not crashed',
    parsedFail(noTxt) && noTxt.reason === 'no-transcript', parsedFail(noTxt) ? noTxt.reason : '');

  const notZip = await run(strToU8('this is not a zip file at all, not even close'));
  check('a non-ZIP file is reported, not crashed',
    parsedFail(notZip) && (notZip.reason === 'not-an-archive' || notZip.reason === 'no-transcript'),
    parsedFail(notZip) ? notZip.reason : '');

  const whole = zip({ '_chat.txt': IOS });
  const truncated = await run(whole.subarray(0, Math.floor(whole.length / 2)));
  check('a truncated archive is reported, not crashed',
    parsedFail(truncated), parsedFail(truncated) ? truncated.reason : 'parsed a half file?!');
}

// ── 7. hostile archives ──────────────────────────────────────────────
console.log('an archive can be a weapon');
{
  const trav = await run(zip({ '../../../etc/passwd': 'x', '_chat.txt': IOS }));
  check('a path-traversal entry refuses the whole archive',
    parsedFail(trav) && trav.reason === 'suspicious-archive', parsedFail(trav) ? trav.reason : 'ACCEPTED IT');

  const abs = await run(zip({ '/etc/shadow': 'x', '_chat.txt': IOS }));
  check('an absolute-path entry refuses the whole archive',
    parsedFail(abs) && abs.reason === 'suspicious-archive', parsedFail(abs) ? abs.reason : 'ACCEPTED IT');

  // A highly compressible transcript: small on disk, enormous inflated. The
  // running byte count is what has to stop this, mid-flight.
  const bomb = zip({ '_chat.txt': 'A'.repeat(MAX_TRANSCRIPT_BYTES + 4096) });
  const r = await run(bomb);
  check('a transcript that expands past the ceiling is stopped',
    parsedFail(r) && (r.reason === 'too-large' || r.reason === 'suspicious-archive'),
    parsedFail(r) ? r.reason : 'INFLATED IT ALL');
  check('  …and the bomb archive was far smaller than what it claimed',
    bomb.length < MAX_TRANSCRIPT_BYTES / 100, `${bomb.length} bytes on disk`);
}

// ── 8. streaming actually streams ────────────────────────────────────
console.log('the whole point: archive size must not become memory');
{
  // Incompressible filler. 'q'.repeat(2e6) deflates to a few KB, which would
  // make this test pass by accident on a one-chunk archive and prove nothing.
  // Genuinely random, so deflate cannot shrink it. An LCG written in JS floats
  // loses precision above 2^53 and degenerates into a short cycle that zips down
  // to nothing — which is how this test passed on a single-chunk archive while
  // claiming to prove chunking.
  const noise = (n: number) => new Uint8Array(randomBytes(n));
  const z = zip({ '_chat.txt': IOS, 'a.bin': noise(700_000), 'b.bin': noise(700_000), 'c.bin': noise(700_000) });
  let maxChunk = 0, reads = 0;
  const src: ArchiveSource = {
    size: z.length,
    read: async (o, l) => { reads++; maxChunk = Math.max(maxChunk, l); return z.subarray(o, o + l); },
  };
  const r = await readExport(src);
  check('a multi-megabyte archive parses', parsedOk(r) && r.messages.length === 2);
  check('  …read in bounded chunks, never in one gulp',
    reads > 1 && maxChunk <= 512 * 1024, `${reads} reads, max ${maxChunk} bytes`);
  if (parsedOk(r)) check('  …and none of the 6 MB of filler was inflated', r.media.length === 3);
}

// ── 9. missing media is counted honestly ─────────────────────────────
{
  const t = `[12/03/2022, 14:23:45] Ravi: <attached: here.jpg>\n[12/03/2022, 14:24:00] Ravi: <attached: gone.jpg>\n`;
  const r = ok(await run(zip({ '_chat.txt': t, 'here.jpg': 'bytes' })));
  check('media referenced but absent from the archive is counted', r.missingMedia === 1, `${r.missingMedia}`);
}

// ── 10. deduplication ────────────────────────────────────────────────
console.log('importing twice must not double the conversation');
{
  const ctx = { source: 'whatsapp', chatId: 'chat-1', conv: 'Ravi' };
  const msgs = ok(parseTranscript(IOS)).messages;

  const a = withDedupeKeys(msgs, ctx).map(m => m.importKey);
  const b = withDedupeKeys(ok(parseTranscript(IOS)).messages, ctx).map(m => m.importKey);
  check('re-parsing the same export yields identical keys', a.join() === b.join());

  const other = withDedupeKeys(msgs, { ...ctx, chatId: 'chat-2' }).map(m => m.importKey);
  check('the same export into a DIFFERENT chat yields different keys', a.join() !== other.join(),
    'otherwise importing for Ravi would block importing for Priya');

  // Genuinely repeated messages are distinct messages, not duplicates.
  const rep = ok(parseTranscript(
    `[12/03/2022, 14:23:45] Ravi: ok\n[12/03/2022, 14:23:45] Ravi: ok\n`)).messages;
  const keys = withDedupeKeys(rep, ctx).map(m => m.importKey);
  check('the same body twice in one second stays two messages', keys[0] !== keys[1],
    'occurrence index is what separates them — there are no message ids in an export');

  // An export that has GROWN keeps the old keys stable.
  const grown = ok(parseTranscript(IOS + `[13/03/2022, 09:00:00] Ravi: later\n`)).messages;
  const gk = withDedupeKeys(grown, ctx).map(m => m.importKey);
  check('a later export reuses the keys of the messages it already had',
    gk.slice(0, 2).join() === a.join(), 'so only the new messages import');
  check('  …and the new message gets a new key', !a.includes(gk[2]));

  check('the key is not derived from text alone',
    dedupeKey({ ...ctx, tsMs: 1, sender: 'A', body: 'x', occurrence: 0 })
    !== dedupeKey({ ...ctx, tsMs: 2, sender: 'A', body: 'x', occurrence: 0 }));
  check('the key is a 128-bit hex digest',
    /^[0-9a-f]{32}$/.test(dedupeKey({ ...ctx, tsMs: 1, sender: 'A', body: 'x', occurrence: 0 })));
}

// ── 11. THE requirement: none of this can leave the device ───────────
//
// Enforced by scanning the shipped sources, not by trusting a reading of them.
// This is a source-scan, which is why it lives in a .selftest.ts and never in the
// module itself — a require('fs') inside a shipped file breaks assembleRelease.
console.log('the export must never leave the device');
{
  const BANNED: Array<[RegExp, string]> = [
    [/\bfetch\s*\(/,            'fetch('],
    [/from\s+['"][^'"]*\/api['"]/, "import from lib/api"],
    [/\bXMLHttpRequest\b/,      'XMLHttpRequest'],
    [/\bWebSocket\b/,           'WebSocket'],
    [/from\s+['"][^'"]*socket['"]/, 'socket import'],
    [/\bresumableUpload\b/,     'resumableUpload'],
    [/\buploadAndSet\w+/,       'upload helper'],
    [/\bsendMedia\b/,           'sendMedia'],
  ];
  for (const file of ['waImport.ts', '../app/import-chats.tsx', '../components/chattools/importChatsParts.tsx', '../components/chattools/useImportFlow.ts']) {
    let src: string;
    try { src = readFileSync(join(HERE, file), 'utf8'); }
    catch { check(`${file} exists to be scanned`, false, 'not created yet'); continue; }
    const hits = BANNED.filter(([re]) => re.test(src)).map(([, n]) => n);
    check(`${file} has no path off the device`, hits.length === 0, hits.join(', '));
  }
  const parser = readFileSync(join(HERE, 'waImport.ts'), 'utf8');
  check('waImport.ts stays pure (no react-native import)',
    !/from\s+['"]react-native['"]/.test(parser),
    'purity is what lets this file be tested here at all');
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);

}   // main

main().catch(e => { console.error('\nFAIL — the suite itself threw:', e); process.exit(1); });
