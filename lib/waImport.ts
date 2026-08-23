// lib/waImport.ts — reading a WhatsApp export, on the device, for ONE conversation.
//
// Design: openspec/changes/whatsapp-exit-kit (D4, D6, D7).
//
// PURE. No react-native, no ./api, no socket, no fetch — which is both what makes
// it Node-testable (waImport.selftest.ts) and how "nothing is uploaded" is proved
// rather than asserted. The RN bindings (document picker, RNFS positional reads)
// live in app/import-chats.tsx and hand this module a plain read function.
//
// Memory is the whole reason this file exists in this shape. `unzipSync` — which
// lib/archive.ts uses, correctly, for its own job — inflates the ENTIRE archive
// into JS memory, which is why that file refuses anything over 256 MB. A WhatsApp
// export is routinely gigabytes of media wrapped around a transcript of a few
// hundred KB. So we use fflate's streaming `Unzip`: it hands us one entry at a
// time as the bytes flow past, and an entry is only decompressed if we ask it to
// be. We ask for the transcript and nothing else. Peak cost is one chunk plus the
// transcript, whatever the archive weighs.

import { Unzip, UnzipInflate } from 'fflate';
import { sha256 } from '@noble/hashes/sha2.js';
import { safeEntryPath } from './archive';

// ─── Public shapes ───────────────────────────────────────────────────

/** Byte source for the archive. The caller owns the file handle; we only read. */
export interface ArchiveSource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export type WaMediaKind = 'image' | 'video' | 'audio' | 'file';

export interface WaMessage {
  /** Original timestamp, ms since epoch, interpreted as device-local wall clock. */
  tsMs: number;
  /** The timestamp EXACTLY as the export wrote it — kept so a timezone or
   *  date-order correction is possible later without re-importing. */
  tsRaw: string;
  /** Sender label as written in the export. Mapping it to a VaultChat id is the
   *  caller's job — this module has no idea who "me" is. */
  sender: string;
  /** The body, byte-for-byte as exported. Never annotated. */
  body: string;
  /** Present when the line referenced media. */
  media?: { filename: string | null; kind: WaMediaKind };
  /** True for WhatsApp's own notices ("Messages are end-to-end encrypted"). */
  system: boolean;
}

export interface WaEntry { name: string; size: number }

export type WaFormat = {
  order: 'DMY' | 'MDY' | 'YMD';
  /** True when day/month could not be told apart from the sample — ASK, don't guess. */
  ambiguous: boolean;
  clock: '12h' | '24h';
};

export interface WaParseOk {
  ok: true;
  messages: WaMessage[];
  participants: string[];
  format: WaFormat;
  /** Lines the parser could not interpret. Reported, never silently dropped. */
  unsupported: number;
  /** Every non-transcript entry, by name and size. None were decompressed. */
  media: WaEntry[];
  transcriptName: string;
  /** Media referenced by the transcript but absent from the archive. */
  missingMedia: number;
}

export interface WaParseFail { ok: false; reason: WaFailure; detail?: string }

export type WaParseResult = WaParseOk | WaParseFail;

// This repo compiles with `strictNullChecks: false`, and without it TypeScript
// will not discriminate a union on a boolean literal — `if (!r.ok)` compiles but
// narrows nothing, so `r.reason` is an error on the union. User-defined guards
// narrow regardless of that setting, so callers use these instead of `r.ok`.
export function parsedOk(r: WaParseResult): r is WaParseOk { return r.ok === true; }
export function parsedFail(r: WaParseResult): r is WaParseFail { return r.ok === false; }

export type WaFailure =
  | 'not-an-archive'       // truncated, not a ZIP, unreadable directory
  | 'no-transcript'        // a ZIP, but nothing that looks like a WhatsApp chat
  | 'unsupported-format'   // a transcript we cannot parse a single line of
  | 'empty'                // parsed fine, contained no messages
  | 'group-export'         // 3+ senders: importing it into a 1:1 chat is wrong
  | 'too-large'            // transcript over the ceiling
  | 'suspicious-archive';  // traversal entry, or a decompression bomb

// ─── Security ceilings ───────────────────────────────────────────────
//
// The archive is a file from outside the app, so it is hostile until proven
// otherwise. These bound the ONE entry we inflate.

/** A transcript larger than this is not a conversation. */
export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
/** Beyond this, deflate is being used as a weapon rather than a codec. */
export const MAX_COMPRESSION_RATIO = 200;
/** Read granularity. Big enough to keep the JSI hop rare, small enough to be free. */
export const CHUNK_BYTES = 512 * 1024;

// ─── Transcript line grammar ─────────────────────────────────────────
//
// WhatsApp writes a different header on every platform, locale and decade, and
// the differences are load-bearing: getting the date order wrong shifts an entire
// conversation by months, silently. So the format is DETECTED from the export,
// never assumed, and when the export genuinely cannot say, we report that instead
// of picking.
//
//   [12/03/2022, 14:23:45] Ravi: hello        iOS, bracketed
//   12/03/2022, 14:23 - Ravi: hello           Android, dashed
//   [3/12/22, 2:23:45 PM] Ravi: hello         US, 12-hour
//   [2022-03-12, 14:23:45] Ravi: hello        ISO-ish
//
// Exports also carry invisible LTR/RTL marks and narrow no-break spaces around
// AM/PM, which is why the line is normalised before it is matched — those cost a
// day of debugging apiece when they are left in.

const HEADER = new RegExp(
  '^\\[?' +
  '(\\d{1,4})[\\/\\-.](\\d{1,2})[\\/\\-.](\\d{2,4})' +   // date parts
  ',?\\s+' +
  '(\\d{1,2}):(\\d{2})(?::(\\d{2}))?' +                  // h:m[:s]
  '(?:\\s*([AaPp])\\.?\\s?[Mm]\\.?)?' +                  // optional am/pm — the
                                                         // group must wrap the
                                                         // WHOLE marker, or 24-hour
                                                         // exports match nothing
  '\\s*\\]?' +
  '\\s*[-\u2013\u2014]?\\s*' +                           // Android's " - "
  '([\\s\\S]*)$',
);

/** Strip the invisible characters WhatsApp sprinkles through its exports. */
function normaliseLine(s: string): string {
  return s
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')  // bidi marks
    .replace(/[\u202f\u00a0]/g, ' ')                            // narrow / non-breaking space
    .replace(/\r$/, '');
}

interface HeaderParts {
  a: number; b: number; c: number;
  hh: number; mm: number; ss: number;
  ampm: 'a' | 'p' | null;
  rest: string;
  raw: string;
}

function matchHeader(line: string): HeaderParts | null {
  const m = HEADER.exec(line);
  if (!m) return null;
  const [, a, b, c, hh, mm, ss, ap, rest] = m;
  // Guard against matching an ordinary line that merely opens with digits.
  const hhN = Number(hh);
  if (hhN > 23) return null;
  if (Number(mm) > 59) return null;
  return {
    a: Number(a), b: Number(b), c: Number(c),
    hh: hhN, mm: Number(mm), ss: ss ? Number(ss) : 0,
    ampm: ap ? (ap.toLowerCase() as 'a' | 'p') : null,
    rest: rest ?? '',
    raw: line.slice(0, line.length - (rest?.length ?? 0)).trim(),
  };
}

/**
 * Work out the date order from the export itself.
 *
 * A four-digit leading component settles it. Otherwise the only honest evidence
 * is a component above 12: it cannot be a month. If the whole sample is ≤ 12 in
 * both positions the export genuinely does not say, and we report `ambiguous` so
 * the caller can ask — a silent coin-flip here moves every message in the
 * conversation by up to eleven months, and nothing downstream could detect it.
 */
export function detectFormat(headers: HeaderParts[]): WaFormat {
  let order: WaFormat['order'] = 'DMY';
  let ambiguous = false;

  if (headers.some(h => h.a > 31)) {
    order = 'YMD';
  } else if (headers.some(h => h.a > 12)) {
    order = 'DMY';
  } else if (headers.some(h => h.b > 12)) {
    order = 'MDY';
  } else {
    ambiguous = headers.length > 0;
  }
  const clock = headers.some(h => h.ampm !== null) ? '12h' : '24h';
  return { order, ambiguous, clock };
}

function toTsMs(h: HeaderParts, fmt: WaFormat): number {
  let y: number, mo: number, d: number;
  if (fmt.order === 'YMD')      { y = h.a; mo = h.b; d = h.c; }
  else if (fmt.order === 'MDY') { y = h.c; mo = h.a; d = h.b; }
  else                          { y = h.c; mo = h.b; d = h.a; }
  if (y < 100) y += 2000;

  let hh = h.hh;
  if (h.ampm === 'p' && hh < 12) hh += 12;
  if (h.ampm === 'a' && hh === 12) hh = 0;

  // Local wall clock, deliberately: WhatsApp exports carry no offset, so the
  // only defensible reading is "the time the phone showed". tsRaw keeps the
  // original string so this can be revisited without a re-import.
  return new Date(y, mo - 1, d, hh, h.mm, h.ss, 0).getTime();
}

// ─── Media references ────────────────────────────────────────────────

const MEDIA_EXT: Array<[RegExp, WaMediaKind]> = [
  [/\.(jpe?g|png|gif|webp|heic|bmp)$/i, 'image'],
  [/\.(mp4|3gp|mov|mkv|avi|webm)$/i,    'video'],
  [/\.(opus|m4a|mp3|aac|ogg|wav|amr)$/i,'audio'],
];

function kindOf(filename: string): WaMediaKind {
  for (const [re, k] of MEDIA_EXT) if (re.test(filename)) return k;
  return 'file';
}

/** Recognise the several ways an export points at an attachment. */
export function mediaRef(body: string): { filename: string | null; kind: WaMediaKind } | null {
  let m = /^<attached:\s*(.+?)>\s*$/i.exec(body);                 // iOS
  if (m) return { filename: m[1].trim(), kind: kindOf(m[1]) };
  m = /^(.+?)\s*\((?:file attached|archivo adjunto|fichier joint)\)\s*$/i.exec(body);  // Android
  if (m) return { filename: m[1].trim(), kind: kindOf(m[1]) };
  // "Without media" exports: the message existed, the bytes did not come along.
  if (/^(<Media omitted>|<M[eé]dia omis>|image omitted|video omitted|audio omitted|sticker omitted|GIF omitted|document omitted)$/i.test(body.trim())) {
    const t = body.toLowerCase();
    const kind: WaMediaKind =
      t.includes('image') || t.includes('sticker') || t.includes('gif') ? 'image'
      : t.includes('video') ? 'video'
      : t.includes('audio') ? 'audio' : 'file';
    return { filename: null, kind };
  }
  return null;
}

// ─── Transcript parsing ──────────────────────────────────────────────

/**
 * Turn transcript text into messages.
 *
 * Separated from the archive layer so it is testable on a string, and so the
 * expensive part (I/O) and the fiddly part (grammar) fail independently.
 */
export function parseTranscript(text: string, forceOrder?: WaFormat['order']): WaParseResult {
  const lines = text.split('\n');
  // The file's terminating newline is not content. Left in, split() yields a
  // final '' which the continuation rule below faithfully appends to the last
  // message — so every export silently gained a trailing blank line on its last
  // message, and that changed the message's dedupe key, so re-importing a
  // slightly longer export duplicated the whole conversation. Only ONE trailing
  // empty is dropped: a blank line INSIDE a multi-line message is real text.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();

  // Pass 1 — sample headers to settle the format before interpreting any date.
  const sample: HeaderParts[] = [];
  for (const line of lines) {
    if (sample.length >= 200) break;
    const h = matchHeader(normaliseLine(line));
    if (h) sample.push(h);
  }
  if (!sample.length) {
    return { ok: false, reason: 'unsupported-format',
             detail: 'no line matched any known WhatsApp header format' };
  }
  // `forceOrder` is how the user answers when the export is ambiguous. It stays a
  // caller decision: this module reports what it can prove and never picks.
  const detected = detectFormat(sample);
  const format: WaFormat = forceOrder ? { ...detected, order: forceOrder } : detected;

  // Pass 2 — messages. A line without a header continues the previous message,
  // which is also how multi-line bodies survive intact.
  const messages: WaMessage[] = [];
  const participants = new Set<string>();
  let unsupported = 0;
  let cur: WaMessage | null = null;

  const flush = () => { if (cur) { messages.push(cur); cur = null; } };

  for (const rawLine of lines) {
    const line = normaliseLine(rawLine);
    const h = matchHeader(line);
    if (!h) {
      if (cur) cur.body += '\n' + rawLine.replace(/\r$/, '');
      else if (line.trim()) unsupported++;      // preamble junk before any header
      continue;
    }
    flush();

    // "Sender: body" vs a WhatsApp notice, which has no sender at all.
    const sep = h.rest.indexOf(': ');
    const isSystem = sep < 0;
    const sender = isSystem ? '' : h.rest.slice(0, sep).replace(/^~\s*/, '').trim();
    const body   = isSystem ? h.rest : h.rest.slice(sep + 2);

    if (!isSystem && sender) participants.add(sender);

    const ref = isSystem ? null : mediaRef(body);
    cur = {
      tsMs: toTsMs(h, format),
      tsRaw: h.raw,
      sender,
      body,
      system: isSystem,
      ...(ref ? { media: ref } : {}),
    };
  }
  flush();

  if (!messages.length) return { ok: false, reason: 'empty' };

  // A group export dropped into a 1:1 chat would write third parties' private
  // messages into a two-person conversation. Refuse before anyone sees a preview.
  if (participants.size > 2) {
    return { ok: false, reason: 'group-export',
             detail: `${participants.size} participants: ${[...participants].slice(0, 5).join(', ')}` };
  }

  return {
    ok: true, messages, participants: [...participants], format,
    unsupported, media: [], transcriptName: '', missingMedia: 0,
  };
}

// ─── Archive layer ───────────────────────────────────────────────────

const TE = new TextDecoder('utf-8');

function isTranscript(name: string): boolean {
  const base = name.slice(name.lastIndexOf('/') + 1);
  if (base.startsWith('.') || base.startsWith('__MACOSX')) return false;
  return /\.txt$/i.test(base);
}

/**
 * Read a WhatsApp export and parse the conversation inside it.
 *
 * Streams `src` in CHUNK_BYTES pieces through fflate's Unzip. Every entry is
 * announced as it goes past; we `.start()` exactly one of them (the transcript)
 * and let every other entry flow through undecompressed, recording only its name
 * and size. That is the difference between using a few hundred KB and needing the
 * whole archive resident.
 */
export async function readExport(
  src: ArchiveSource,
  opts?: { forceOrder?: WaFormat['order'] },
): Promise<WaParseResult> {
  const media: WaEntry[] = [];
  const parts: Uint8Array[] = [];
  let transcriptName = '';
  let inflated = 0;
  let declared = 0;
  let failure: { reason: WaFailure; detail?: string } | null = null;
  let started = false;

  const unzip = new Unzip();
  // Without this, Unzip handles STORED entries only and silently yields nothing
  // for the deflated transcript that is the entire point of the exercise.
  unzip.register(UnzipInflate);

  unzip.onfile = (file) => {
    if (failure) return;

    // Entry names come from the archive, so they are attacker-controlled. The
    // traversal rules are already written and already tested in lib/archive.ts —
    // an archive containing `../../secrets` is broken or hostile, and neither
    // deserves a best effort.
    if (!safeEntryPath(file.name)) {
      failure = { reason: 'suspicious-archive', detail: `unsafe entry name: ${file.name}` };
      return;
    }
    if (file.name.endsWith('/')) return;

    if (!started && isTranscript(file.name)) {
      const orig = file.originalSize ?? 0;
      const comp = file.size ?? 0;
      if (orig > MAX_TRANSCRIPT_BYTES) {
        failure = { reason: 'too-large', detail: `transcript declares ${orig} bytes` };
        return;
      }
      // A tiny compressed entry claiming an enormous expansion is the classic
      // bomb. Only checkable when the local header carried both sizes; when it
      // did not, the running check inside ondata still catches it.
      if (comp > 0 && orig / comp > MAX_COMPRESSION_RATIO) {
        failure = { reason: 'suspicious-archive', detail: `compression ratio ${Math.round(orig / comp)}:1` };
        return;
      }
      started = true;
      transcriptName = file.name;
      declared = orig;
      file.ondata = (err, chunk, _final) => {
        if (err) { failure = { reason: 'not-an-archive', detail: String(err.message ?? err) }; return; }
        if (failure) return;
        inflated += chunk.length;
        // A header that lied, or an entry with no declared size running away.
        // Streaming means we find out mid-flight, which is exactly when we want
        // to stop rather than after allocating it all.
        if (inflated > MAX_TRANSCRIPT_BYTES || (declared > 0 && inflated > declared)) {
          failure = { reason: 'suspicious-archive', detail: `transcript exceeded its declared size` };
          return;
        }
        parts.push(chunk);
      };
      file.start();
      return;
    }

    // Everything else: catalogued, never decompressed.
    media.push({ name: file.name, size: file.originalSize ?? file.size ?? 0 });
  };

  try {
    for (let off = 0; off < src.size; off += CHUNK_BYTES) {
      const len = Math.min(CHUNK_BYTES, src.size - off);
      const chunk = await src.read(off, len);
      unzip.push(chunk, off + len >= src.size);
      if (failure) break;
    }
  } catch (e: any) {
    return { ok: false, reason: 'not-an-archive', detail: String(e?.message ?? e) };
  }

  if (failure) return { ok: false, ...(failure as { reason: WaFailure; detail?: string }) };
  if (!transcriptName) return { ok: false, reason: 'no-transcript' };

  // Join once, at the end — concatenating per chunk would make this quadratic.
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { buf.set(p, at); at += p.length; }

  const parsed = parseTranscript(TE.decode(buf), opts?.forceOrder);
  if (!parsed.ok) return parsed;

  // Reconcile referenced media against what the archive actually holds, so the
  // completion screen can be honest about what did and did not come across.
  const have = new Set(media.map(e => e.name.slice(e.name.lastIndexOf('/') + 1)));
  let missingMedia = 0;
  for (const m of parsed.messages) {
    if (m.media?.filename && !have.has(m.media.filename)) missingMedia++;
  }

  return { ...parsed, media, transcriptName, missingMedia };
}

/**
 * Second pass: pull specific media entries out of the archive.
 *
 * Separate from readExport because the transcript has to be parsed before we know
 * which media it actually references — an archive routinely carries entries no
 * message points at, and copying those would be pure waste.
 *
 * `onEntry` is async (it writes a file), but fflate's `ondata` is synchronous, so
 * completed entries are parked in a queue and drained between chunk pushes — the
 * outer loop is the only place we can legally await. That keeps resident bytes to
 * roughly one chunk's worth of completed entries plus the one in flight, instead
 * of the whole archive.
 *
 * `maxBytes` is a real product decision, not a safety valve: the brief asks us not
 * to duplicate large media, and a 200 MB video would have to be held in memory
 * AND base64'd to be written. Oversized entries are skipped and counted so the
 * completion screen can say so rather than imply they came across.
 */
export async function extractEntries(
  src: ArchiveSource,
  wanted: Set<string>,
  onEntry: (name: string, bytes: Uint8Array) => Promise<void> | void,
  opts?: { maxBytes?: number; signal?: { cancelled: boolean } },
): Promise<{ written: number; skipped: number }> {
  const maxBytes = opts?.maxBytes ?? 25 * 1024 * 1024;
  const done: Array<{ name: string; bytes: Uint8Array }> = [];
  let written = 0, skipped = 0;

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file) => {
    const base = file.name.slice(file.name.lastIndexOf('/') + 1);
    if (!wanted.has(base) || !safeEntryPath(file.name)) return;
    if ((file.originalSize ?? 0) > maxBytes) { skipped++; return; }

    const parts: Uint8Array[] = [];
    let n = 0, aborted = false;
    file.ondata = (err, chunk, final) => {
      if (err || aborted) return;
      n += chunk.length;
      if (n > maxBytes) { aborted = true; skipped++; parts.length = 0; return; }
      parts.push(chunk);
      if (final) {
        const bytes = new Uint8Array(n);
        let at = 0;
        for (const p of parts) { bytes.set(p, at); at += p.length; }
        parts.length = 0;
        done.push({ name: base, bytes });
      }
    };
    file.start();
  };

  for (let off = 0; off < src.size; off += CHUNK_BYTES) {
    if (opts?.signal?.cancelled) break;
    const len = Math.min(CHUNK_BYTES, src.size - off);
    unzip.push(await src.read(off, len), off + len >= src.size);
    while (done.length) {
      const e = done.shift()!;
      await onEntry(e.name, e.bytes);
      written++;
    }
  }
  return { written, skipped };
}

// ─── Deduplication ───────────────────────────────────────────────────

/**
 * The key that makes re-importing safe.
 *
 * Text alone is nowhere near enough — "ok" recurs forever — so the key binds the
 * source, the destination chat, the conversation, the original instant, the
 * sender and the body together. `occurrence` disambiguates the remaining case:
 * WhatsApp exports carry no message ids, so two genuinely distinct messages with
 * the same body, sender and minute are indistinguishable without it, and would
 * otherwise collapse into one. Counted in transcript order, so it is stable
 * across re-parses of the same file.
 */
export function dedupeKey(input: {
  source: string;
  chatId: string;
  conv: string;
  tsMs: number;
  sender: string;
  body: string;
  media?: string | null;
  occurrence: number;
}): string {
  const bodyHash = bytesToHex(sha256(utf8(input.body + '\u0000' + (input.media ?? ''))));
  const material = [
    input.source, input.chatId, input.conv,
    String(input.tsMs), input.sender, bodyHash, String(input.occurrence),
  ].join('\u001f');
  return bytesToHex(sha256(utf8(material))).slice(0, 32);   // 128 bits
}

/** Attach a stable dedupe key to every parsed message. */
export function withDedupeKeys(
  messages: WaMessage[],
  ctx: { source: string; chatId: string; conv: string },
): Array<WaMessage & { importKey: string }> {
  const seen = new Map<string, number>();
  return messages.map(m => {
    const sig = `${m.tsMs}\u001f${m.sender}\u001f${m.body}`;
    const occurrence = seen.get(sig) ?? 0;
    seen.set(sig, occurrence + 1);
    return { ...m, importKey: dedupeKey({ ...ctx, tsMs: m.tsMs, sender: m.sender, body: m.body,
                                          media: m.media?.filename ?? null, occurrence }) };
  });
}

const _te = new TextEncoder();
function utf8(s: string): Uint8Array { return _te.encode(s); }
function bytesToHex(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0');
  return out;
}

export default {};
