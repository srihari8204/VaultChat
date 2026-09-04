// lib/linkPreview.ts — sender-generated E2EE link previews (F5 / VC-052).
//
// WhatsApp model: the SENDER's device fetches the page at compose time and
// embeds {title, description, thumbnail-bytes} INSIDE the E2EE message
// payload. The receiver renders the card entirely from the payload — neither
// the receiver's device nor our server ever touches the URL. (The old flow
// had every client resolve previews through GET /link/preview at render time,
// which handed the URL — protected content inside an E2EE body — back to the
// server in cleartext on every render.)
//
// Wire format (INSIDE the E2EE envelope — the server only ever sees ciphertext):
//   plaintext = '\u0000lp1:' + JSON({ t: <message text>, lp: <LinkPreviewData> })
// The leading NUL can't occur in real user text (same trick as the e2ee
// tombstone marker), so unwrapping is unambiguous; unwrapped strings pass
// through untouched. Old clients receiving a wrapped payload render the raw
// wrapper — acceptable for the current pre-launch fleet, and previews are only
// attached when the sender's device actually resolved one.

import * as FileSystem from 'expo-file-system/legacy';

export interface LinkPreviewData {
  u: string;          // canonical URL the preview describes
  t: string;          // og:title (or <title>)
  d?: string;         // og:description
  i?: string;         // thumbnail as a data URI (bytes travel E2E — receiver fetches nothing)
}

const FETCH_TIMEOUT_MS = 6000;
const MAX_HTML_BYTES = 512 * 1024;    // parse at most 512KB of HTML
const MAX_THUMB_B64 = 49_152;         // ~48KB base64 ≈ 36KB JPEG — keeps envelopes small

export function extractFirstUrl(text: string): string | null {
  const m = String(text || '').match(/https?:\/\/[^\s]+/);
  return m ? m[0].replace(/[.,!?;:)\]]+$/, '') : null;
}

// ── E2EE plaintext envelope ─────────────────────────────────────────
// The wrapper moved to lib/msgEnvelope. A link preview turned out to be one
// instance of a general problem — sender-authored data that must ride inside
// the ciphertext rather than in plaintext `meta` — and thumbnails, filenames,
// poll option text and mention names all needed the same treatment. Keeping a
// second, preview-only wrapper here would have meant two wire formats to
// unwrap and two places to get the NUL-prefix handling right.
//
// msgEnvelope still READS this module's old '<NUL>lp1:' form, so previews
// already cached on a device keep rendering.

// ── Compose-time fetch (sender's device only) ───────────────────────
function htmlDecode(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
    .trim();
}

function metaContent(html: string, prop: string): string | null {
  // <meta property="og:x" content="..."> — tolerate attribute order + quotes.
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']|` +
    `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
  const m = html.match(re);
  const v = m ? (m[1] ?? m[2]) : null;
  return v ? htmlDecode(v) : null;
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { signal: ctl.signal, headers: { Accept: 'text/html' } }); }
  finally { clearTimeout(timer); }
}

/** Download og:image and shrink it into a small data URI so the BYTES ride E2E
 *  and the receiver never contacts the image host. Null on any failure. */
async function thumbnailDataUri(imageUrl: string): Promise<string | null> {
  const tmp = `${(FileSystem as any).cacheDirectory}lp_${Date.now()}.img`;
  try {
    const dl = await FileSystem.downloadAsync(imageUrl, tmp);
    if ((dl.status ?? 0) >= 400) return null;
    let uri = tmp;
    try {
      const im = await import('expo-image-manipulator');
      const out = await im.manipulateAsync(tmp, [{ resize: { width: 320 } }],
        { compress: 0.7, format: im.SaveFormat.JPEG });
      uri = out.uri;
    } catch { /* manipulator unavailable — try the raw file if it's small enough */ }
    const b64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
    if (b64.length > MAX_THUMB_B64) return null;
    return `data:image/jpeg;base64,${b64}`;
  } catch { return null; }
  finally { FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {}); }
}

/**
 * Resolve a preview from the sender's device (compose time). Never throws —
 * returns null when the page can't be fetched/parsed in time, and the message
 * simply goes out without a preview (exactly like WhatsApp on a flaky page).
 */
export async function fetchPreviewFromDevice(url: string): Promise<LinkPreviewData | null> {
  try {
    const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return null;
    const html = (await res.text()).slice(0, MAX_HTML_BYTES);

    const title = metaContent(html, 'og:title')
      ?? htmlDecode((html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? ''));
    if (!title) return null;

    const lp: LinkPreviewData = { u: url, t: title.slice(0, 160) };
    const desc = metaContent(html, 'og:description') ?? metaContent(html, 'description');
    if (desc) lp.d = desc.slice(0, 240);

    const img = metaContent(html, 'og:image');
    if (img) {
      const abs = img.startsWith('http') ? img : new URL(img, url).toString();
      const thumb = await thumbnailDataUri(abs);
      if (thumb) lp.i = thumb;
    }
    return lp;
  } catch { return null; }
}

export default { extractFirstUrl, fetchPreviewFromDevice };
