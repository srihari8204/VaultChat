// lib/msgEnvelope.ts — what the server is allowed to see about a message.
//
// THE PROBLEM
//
// `messages.meta` is plaintext JSONB on the server. It carries a base64 JPEG
// preview of every photo and video (`meta.thumb`), plus filenames, MIME types,
// dimensions, audio waveforms, poll option TEXT and mention display names.
// Measured on production: 22 of 24 image/video messages had a server-readable
// preview and 57 rows carried a filename.
//
// So a system that carefully end-to-end encrypts the message body was shipping
// a legible thumbnail of the same photo beside it, in the clear, forever.
//
// WHY NOT FIX IT SERVER-SIDE
//
// The delete-on-delivery sweep now strips private keys when it reclaims a body
// (jobs.deliveredMessagesSQL), and that is worth keeping as a backstop for rows
// written before this module existed. But it cannot be the answer:
//
//   * it only acts AFTER every recipient has acknowledged delivery, so there is
//     always a window — minutes to days — where the plaintext thumbnail is on
//     the server;
//   * an UNDELIVERED message is deliberately never reclaimed at any age, so a
//     message to someone who never comes back keeps its thumbnail forever;
//   * it requires the server to be trusted to delete, which is the assumption
//     end-to-end encryption exists to remove.
//
// The only way the server cannot leak this is for it never to receive it.
//
// THE FIX
//
// Private metadata travels INSIDE the encrypted body, exactly like the
// sender-generated link previews already do (lib/linkPreview). The server
// receives only the routing subset it provably needs — the same allow-list it
// enforces in jobs.MetaPublicKeys.
//
//   plaintext = '<NUL>vc1:' + JSON({ t: <text>, pm: <private meta> })
//
// The leading NUL cannot occur in real user text, so unwrapping is unambiguous
// and unwrapped strings pass through untouched. The older '<NUL>lp1:' form
// (text + link preview only) is still READ, so history already on a device
// keeps rendering; nothing writes it any more.
//
// KEEPING THE TWO LISTS IN STEP
//
// META_PUBLIC_KEYS below must match jobs.MetaPublicKeys on the server. The
// server enforces its copy when it reclaims; this one decides what is sent at
// all. They are asserted against each other in msgEnvelope.selftest.ts, which
// reads the Go source — a security allow-list that drifts silently is worse
// than no allow-list.

import type { LinkPreviewData } from './linkPreview';

const NUL = String.fromCharCode(0);
const PREFIX = NUL + 'vc1:';
/** Superseded wrapper '<NUL>lp1:': {t, lp}. Still read, never written. */
const LEGACY_LP_PREFIX = NUL + 'lp1:';

/**
 * Meta keys the SERVER is allowed to receive. Everything else is content.
 *
 * Each entry earns its place by being read by server code — see
 * internal/jobs/meta_public.go for the per-key justification. An ALLOW-list,
 * never a deny-list: the next feature to add a meta field must be private by
 * default, or it leaks the day it ships and nobody notices until an audit.
 */
export const META_PUBLIC_KEYS: readonly string[] = [
  'attachmentId', 'viewOnce', 'revoked',
  'announcement', 'audience', 'silent',
  'groupId', 'gifUrl',
  'allowMultiple', 'optionCount',
  'mentionUserIds', 'encrypted',
  // Game invites: the server validates both (chatsGameKinds / chatsGameRoomRe)
  // and the recipient opens a URL built from them, so they are inherently
  // server-visible. They were NOT on the original list, which meant the
  // never-enabled body-store split would have stripped them and rejected every
  // game invite the moment it was switched on.
  'game', 'room',
];

const PUBLIC = new Set<string>(META_PUBLIC_KEYS);

export interface SplitMeta {
  /** Sent to the server as `meta`. Null when empty, matching the old wire. */
  pub: Record<string, any> | null;
  /** Folded into the encrypted body. Null when empty. */
  priv: Record<string, any> | null;
}

/**
 * Divide message metadata into what the server receives and what stays inside
 * the ciphertext.
 *
 * Two fields are DERIVED rather than copied, because the server needs an answer
 * without needing the content. Both mirror the server's own chatsSplitMeta, and
 * both are load-bearing:
 *
 *   optionCount     the poll vote handler validates optionIndex against it.
 *                   Send `options` privately without this and the server cannot
 *                   bounds-check a vote.
 *   mentionUserIds  push overrides a muted chat for mentioned users, reading
 *                   only userId — so the ids go, the display names stay home.
 */
export function splitMeta(meta: Record<string, any> | null | undefined): SplitMeta {
  if (!meta) return { pub: null, priv: null };
  const pub: Record<string, any> = {};
  const priv: Record<string, any> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (PUBLIC.has(k)) pub[k] = v;
    else priv[k] = v;
  }
  if (Array.isArray(meta.options)) pub.optionCount = meta.options.length;
  if (Array.isArray(meta.mentions)) {
    const ids = meta.mentions
      .map((m: any) => m?.userId)
      .filter((id: any) => typeof id === 'string' && id);
    if (ids.length) pub.mentionUserIds = ids;
  }
  return {
    pub:  Object.keys(pub).length  ? pub  : null,
    priv: Object.keys(priv).length ? priv : null,
  };
}

/**
 * Fold private metadata into the plaintext that is about to be encrypted.
 * Returns the text UNCHANGED when there is nothing private to carry, so
 * ordinary messages keep the exact wire they had before this existed.
 */
export function wrapEnvelope(text: string, priv: Record<string, any> | null | undefined): string {
  if (!priv || !Object.keys(priv).length) return text;
  return PREFIX + JSON.stringify({ t: text, pm: priv });
}

export interface Unwrapped {
  text: string;
  /** Private meta to merge back over the server's public copy. */
  pm: Record<string, any> | null;
}

/**
 * Reverse of wrapEnvelope. Also reads the superseded '<NUL>lp1:' form so
 * messages already cached on a device keep rendering their link preview.
 * Anything unrecognised is returned verbatim — a corrupt wrapper must degrade
 * to "shows the raw text", never to a thrown render.
 */
export function unwrapEnvelope(plain: string | null | undefined): Unwrapped {
  const s = plain ?? '';
  if (s.startsWith(PREFIX)) {
    try {
      const p = JSON.parse(s.slice(PREFIX.length));
      if (typeof p?.t === 'string') return { text: p.t, pm: p.pm ?? null };
    } catch { /* fall through */ }
    return { text: s, pm: null };
  }
  if (s.startsWith(LEGACY_LP_PREFIX)) {
    try {
      const p = JSON.parse(s.slice(LEGACY_LP_PREFIX.length));
      if (typeof p?.t === 'string') {
        const lp = (p.lp ?? null) as LinkPreviewData | null;
        return { text: p.t, pm: lp ? { linkPreview: lp } : null };
      }
    } catch { /* fall through */ }
  }
  return { text: s, pm: null };
}

export default {};
