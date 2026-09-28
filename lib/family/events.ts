// lib/family/events.ts — the wire format for a Family Space geofence crossing,
// and the parser that turns one back into an alert on a RECEIVER's device.
//
// Why this exists: a crossing is evaluated on the subject's own phone and
// announced to the circle as an E2EE system message ("Rohan arrived at Home").
// The subject's device records a local alert for it, but every OTHER device —
// including the guardian who actually wants to know — recorded nothing. Their
// alert inbox stayed empty and the event was indistinguishable from chat.
// F4.2 asks for that missing half.
//
// The message is prefixed with a marker so a receiver can recognise a family
// event without regexing English. The parser also accepts the UNMARKED legacy
// form, so a circle running mixed app versions keeps working in both
// directions — an older sender's crossings are still ingested by a newer
// receiver.
//
// Pure — no RN imports, no storage. Self-check:
//   node --experimental-strip-types lib/family/events.ts

export type CrossingKind = 'enter' | 'leave';

/** Marker that fronts a crossing announcement in the circle thread. */
export const FAMILY_EVENT_PREFIX = '📍';

/** Verb rendered per crossing kind. The parser keys off these exact words. */
export const CROSSING_VERB: Record<CrossingKind, string> = {
  enter: 'arrived at',
  leave: 'left',
};

/**
 * The emoji that front a person-event announcement. SOS and the "Need Help"
 * check-in share 🆘 and both mean the same thing to a reader, so both map to
 * `sos` (critical) rather than being told apart.
 */
export const GLYPH_KIND: Record<string, 'sos' | 'checkin'> = {
  '\u{1F198}': 'sos',       // 🆘  SOS / Need Help
  '\u2705': 'checkin',      // ✅  I'm Safe
  '\u{1F697}': 'checkin',   // 🚗  On My Way
  '\u23F3': 'checkin',      // ⏳  Running Late
  // Escalation-ladder audit lines (lib/family/escalation.ts). They ride the
  // same ingestion path so a guardian's request, its reminders and the member's
  // "I'm OK" all land in the receiver's inbox instead of looking like chat.
  '\u{1F514}': 'checkin',   // 🔔  check-in requested
  '\u{1F501}': 'checkin',   // 🔁  reminder
  '\u{1F44D}': 'checkin',   // 👍  member confirmed OK
  '\u{1F6A8}': 'sos',       // 🚨  Emergency Connect — critical, like an SOS
};

export interface ParsedCrossing {
  kind: CrossingKind;
  actorName: string;
  place: string;
  /** The announcement with the marker stripped — what the alert inbox shows. */
  text: string;
}

/** Render the circle-thread announcement for a crossing. */
export function formatCrossing(actorName: string, kind: CrossingKind, place: string): string {
  return `${FAMILY_EVENT_PREFIX} ${actorName} ${CROSSING_VERB[kind]} ${place}`;
}

/**
 * Parse a circle system message back into a crossing, or null if it is not one.
 *
 * Only ever called on `type: 'system'` messages inside a Circle, which are
 * produced by this app alone — so the English match is against our own output,
 * not against user-typed text. "left" is checked after "arrived at" because a
 * place name could itself contain the word.
 */
export function parseCrossing(raw: string): ParsedCrossing | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  if (s.startsWith(FAMILY_EVENT_PREFIX)) s = s.slice(FAMILY_EVENT_PREFIX.length).trim();
  if (!s) return null;
  // A check-in note is free text and may well contain "left" ("✅ Asha: left
  // work early"). Anything already claimed by a glyph is never a crossing.
  for (const g of Object.keys(GLYPH_KIND)) if (s.startsWith(g)) return null;

  for (const kind of ['enter', 'leave'] as CrossingKind[]) {
    const verb = ` ${CROSSING_VERB[kind]} `;
    const at = s.indexOf(verb);
    if (at <= 0) continue;                       // <=0: no verb, or no name before it
    const actorName = s.slice(0, at).trim();
    const place = s.slice(at + verb.length).trim();
    if (!actorName || !place) continue;
    return { kind, actorName, place, text: s };
  }
  return null;
}

export type FamilyEventKind = CrossingKind | 'sos' | 'checkin';

export interface ParsedFamilyEvent {
  kind: FamilyEventKind;
  actorName: string;
  text: string;
}

/** Best-effort sender name out of an announcement body (already glyph-stripped). */
function actorFrom(body: string): string {
  const colon = body.indexOf(':');
  if (colon > 0) return body.slice(0, colon).trim();
  const sos = body.match(/^(.+?)\s+triggered an SOS/);
  if (sos) return sos[1].trim();
  return body.split(/\s+/)[0] ?? '';
}

/**
 * Parse any Family Space announcement — a crossing, an SOS, or a check-in.
 *
 * Glyphs are checked FIRST because they are unambiguous markers, whereas a
 * crossing is recognised from English that a free-text check-in note could
 * imitate.
 */
export function parseFamilyEvent(raw: string): ParsedFamilyEvent | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;

  for (const [glyph, kind] of Object.entries(GLYPH_KIND)) {
    if (!s.startsWith(glyph)) continue;
    const body = s.slice(glyph.length).trim();
    if (!body) return null;
    return { kind, actorName: actorFrom(body), text: s };
  }

  const crossing = parseCrossing(s);
  return crossing ? { kind: crossing.kind, actorName: crossing.actorName, text: crossing.text } : null;
}

/**
 * How stale a crossing may be and still become an alert on a receiver.
 *
 * A receiver ingests from the circle's recent message history, so the FIRST
 * subscribe after installing (or after any long gap) sees a backlog. Without an
 * age policy that backlog would replay as a burst of notifications for events
 * that are hours old — the exact behaviour that makes people mute an app.
 */
export const INGEST_MAX_AGE_MS = 6 * 60 * 60 * 1000;   // older: not even inboxed
export const NOTIFY_MAX_AGE_MS = 10 * 60 * 1000;       // older: inbox only, silent

export type IngestAction = 'skip' | 'record' | 'notify';

/** Decide what to do with a crossing of a given age. Ages are clamped at 0. */
export function ingestAction(ageMs: number): IngestAction {
  const age = Number.isFinite(ageMs) ? Math.max(0, ageMs) : Infinity;
  if (age > INGEST_MAX_AGE_MS) return 'skip';
  if (age > NOTIFY_MAX_AGE_MS) return 'record';
  return 'notify';
}

// ── self-check ──
function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('events: ' + m); };

  // round-trip, both kinds
  for (const kind of ['enter', 'leave'] as CrossingKind[]) {
    const wire = formatCrossing('Rohan', kind, 'Home');
    const p = parseCrossing(wire);
    A(!!p, `${kind} must parse`);
    A(p!.kind === kind, `${kind} round-trips`);
    A(p!.actorName === 'Rohan' && p!.place === 'Home', `${kind} fields`);
    A(!p!.text.startsWith(FAMILY_EVENT_PREFIX), 'marker stripped from inbox text');
  }

  // legacy unmarked form still ingests (mixed-version circle)
  const legacy = parseCrossing('Asha left School');
  A(!!legacy && legacy.kind === 'leave' && legacy.place === 'School', 'legacy form parses');

  // a place containing the verb word must not be mis-split
  const tricky = parseCrossing(formatCrossing('Rohan', 'enter', 'Left Bank Cafe'));
  A(!!tricky && tricky.kind === 'enter' && tricky.place === 'Left Bank Cafe', 'verb inside place name');

  // multi-word names survive
  const two = parseCrossing(formatCrossing('Asha Kumar', 'leave', 'Green Park'));
  A(!!two && two.actorName === 'Asha Kumar' && two.place === 'Green Park', 'multi-word name + place');

  // non-events are rejected rather than half-parsed
  for (const junk of ['', '   ', 'hello', FAMILY_EVENT_PREFIX, `${FAMILY_EVENT_PREFIX}   `,
                      'arrived at Home', 'left', 'Rohan arrived at ', ' left Home']) {
    A(parseCrossing(junk) === null, `must reject: ${JSON.stringify(junk)}`);
  }
  A(parseCrossing(null as any) === null, 'null is not a crossing');
  A(parseCrossing(123 as any) === null, 'number is not a crossing');

  // check-in / SOS messages are NOT crossings (they have their own path)
  A(parseCrossing('🆘 Rohan triggered an SOS — please respond') === null, 'SOS is not a crossing');
  A(parseCrossing('✅ Rohan: I am Safe') === null, 'check-in is not a crossing');

  // combined parser: person-events
  const sos = parseFamilyEvent('\u{1F198} Rohan triggered an SOS \u2014 please respond (12.97, 77.59)');
  A(!!sos && sos.kind === 'sos', 'SOS parses as sos');
  A(sos!.actorName === 'Rohan', 'SOS actor extracted');
  const safe = parseFamilyEvent("\u2705 Asha Kumar: I'm Safe");
  A(!!safe && safe.kind === 'checkin' && safe.actorName === 'Asha Kumar', 'check-in parses');
  const help = parseFamilyEvent('\u{1F198} Rohan: Need Help');
  A(!!help && help.kind === 'sos', 'Need Help is critical, like an SOS');
  for (const g of ['\u{1F697}', '\u23F3']) {
    A(parseFamilyEvent(g + ' Asha: on it')!.kind === 'checkin', 'glyph ' + g + ' is a check-in');
  }

  // THE ordering bug this guards: a check-in note containing a crossing verb
  const trap = parseFamilyEvent('\u2705 Asha: left work early');
  A(!!trap && trap.kind === 'checkin', 'check-in mentioning "left" is NOT a crossing');
  A(parseCrossing('\u2705 Asha: left work early') === null, 'parseCrossing refuses glyph-claimed text');

  // crossings still route through the combined parser
  const cross = parseFamilyEvent(formatCrossing('Rohan', 'leave', 'School'));
  A(!!cross && cross.kind === 'leave' && cross.actorName === 'Rohan', 'crossing via combined parser');

  // junk stays junk
  for (const junk of ['', '   ', 'just a normal message', '\u{1F198}', '\u2705   ']) {
    A(parseFamilyEvent(junk) === null, `combined must reject: ${JSON.stringify(junk)}`);
  }
  A(parseFamilyEvent(undefined as any) === null, 'undefined is not an event');

  // escalation audit lines ingest like any other family event
  A(parseFamilyEvent('\u{1F514} Asha asked Rohan to check in')!.kind === 'checkin', 'request ingests');
  A(parseFamilyEvent('\u{1F501} Reminder 1/2: Rohan, please check in')!.kind === 'checkin', 'reminder ingests');
  A(parseFamilyEvent('\u{1F44D} Rohan confirmed they are OK')!.kind === 'checkin', 'OK ingests');
  const emg = parseFamilyEvent('\u{1F6A8} Emergency Connect: Rohan did not respond');
  A(!!emg && emg.kind === 'sos', 'Emergency Connect is critical');

  // age policy — the guard against a first-open notification storm
  A(ingestAction(0) === 'notify', 'a just-now crossing notifies');
  A(ingestAction(NOTIFY_MAX_AGE_MS) === 'notify', 'boundary is inclusive for notify');
  A(ingestAction(NOTIFY_MAX_AGE_MS + 1) === 'record', 'past notify window ⇒ inbox only');
  A(ingestAction(INGEST_MAX_AGE_MS) === 'record', 'boundary is inclusive for record');
  A(ingestAction(INGEST_MAX_AGE_MS + 1) === 'skip', 'ancient backlog is dropped entirely');
  A(ingestAction(-5000) === 'notify', 'clock skew (future ts) still notifies, never crashes');
  A(ingestAction(NaN) === 'skip', 'unparseable age is skipped, not notified');
  A(NOTIFY_MAX_AGE_MS < INGEST_MAX_AGE_MS, 'notify window sits inside the ingest window');

  console.log('family/events self-check OK');
}
declare const require: any; declare const module: any; declare const process: any;
const _isMain =
  typeof require !== 'undefined' && typeof module !== 'undefined'
    ? require.main === module
    : typeof process !== 'undefined' && /[\\/]events\.ts$/.test(String(process.argv?.[1] ?? ''));
if (_isMain) _selfCheck();
