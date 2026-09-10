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
