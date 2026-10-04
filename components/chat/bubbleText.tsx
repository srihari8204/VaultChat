// components/chat/bubbleText.tsx — how a bubble's text is drawn: @mentions,
// search highlights, tappable links and Invisible Ink. Moved out of
// components/chat/MessageBubble.tsx.
//
// Link and mention colours come from the caller (`BubbleInk`), not from a fixed
// palette: the old fixed sky-blue link and mint mention were ~1.7:1 and ~1.9:1
// on the light theme's white received bubble. The search highlight keeps its
// fixed yellow + near-black, which reads on every bubble colour.

import { Linking, Text, type TextStyle } from 'react-native';
import { navigateFromUrl } from '../../lib/nav/openNavigation';
import { HL } from './chatStyles';

export type BubbleInk = { link: TextStyle; mention: TextStyle };

/** Open a URL from a message: in-app routes first, else the OS. */
export function openMessageUrl(url: string): void {
  if (!navigateFromUrl(url)) Linking.openURL(url).catch(() => {});
}

function colorMentions(body: string, ink: BubbleInk): any {
  if (!body || body.indexOf('@') === -1) return body;
  const parts: any[] = [];
  const re = /@[\p{L}\p{N}_]+/gu;
  let last = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m.index > last) parts.push(body.slice(last, m.index));
    parts.push(<Text key={`mn${m.index}`} style={ink.mention}>{m[0]}</Text>);
    last = m.index + m[0].length;
  }
  if (last < body.length) parts.push(body.slice(last));
  return parts.length ? parts : body;
}

export function renderWithHighlight(body: string, q: string | null | undefined, ink: BubbleInk): any {
  if (!body) return body;
  if (!q) return colorMentions(body, ink); // no active search → color @mentions
  const needle = q.toLowerCase();
  const hay    = body.toLowerCase();
  if (hay.indexOf(needle) === -1) return body;
  const parts: any[] = [];
  let i = 0;
  while (i < body.length) {
    const idx = hay.indexOf(needle, i);
    if (idx === -1) { parts.push(body.slice(i)); break; }
    if (idx > i) parts.push(body.slice(i, idx));
    parts.push(
      <Text key={`h${idx}`} style={HL.highlight}>{body.slice(idx, idx + q.length)}</Text>,
    );
    i = idx + q.length;
  }
  return parts;
}

// Detect URLs in `body` and tokenise into alternating plain / link chunks.
// Each link chunk becomes a tappable <Text> that opens the URL via Linking.
// Trailing punctuation (.,!?;:) is excluded from the link match so a URL
// at the end of a sentence doesn't include the trailing dot.
// Privacy: no remote fetch — we render the URL inline, not a rich card.
// (Server-proxied OG previews are a follow-up; opengraph.io with a sample
// key would leak every messaged URL to a third party.)
const URL_RE = /https?:\/\/[^\s]+?(?=[.,!?;:)]*(?:\s|$))/g;
export function renderRichText(body: string, q: string | null | undefined, ink: BubbleInk): any {
  if (!body) return body;
  // No URLs? Defer to the existing highlight renderer.
  URL_RE.lastIndex = 0;
  if (!URL_RE.test(body)) return renderWithHighlight(body, q, ink);

  URL_RE.lastIndex = 0;
  const parts: any[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(body)) !== null) {
    if (m.index > cursor) {
      parts.push(renderWithHighlight(body.slice(cursor, m.index), q, ink));
    }
    const url = m[0];
    parts.push(
      <Text
        key={`u${m.index}`}
        style={ink.link}
        accessibilityRole="link"
        onPress={() => openMessageUrl(url)}
      >
        {renderWithHighlight(url, q, ink)}
      </Text>,
    );
    cursor = m.index + url.length;
  }
  if (cursor < body.length) parts.push(renderWithHighlight(body.slice(cursor), q, ink));
  return parts;
}

// Invisible Ink: replace each non-whitespace char with a bullet. Keep
// whitespace as-is so word boundaries are preserved (otherwise the
// obscured text reads as one long blob).
export function obscureForInk(plain: string): string {
  return plain.replace(/\S/g, '●');
}
