// lib/searchSnippet.ts — split a search hit around its first match.
//
// app/search.tsx shows each message hit on one line. Without a split the match
// was not marked at all, and in a long message it sat past the ellipsis where
// nobody could see why the row matched. This trims the text before the match
// to a short lead-in so the match lands on the visible line. Pure (tsx-tested).

export interface Snippet { before: string; match: string; after: string }

/** `text` split around the first case-insensitive `query`; no match → all in `before`. */
export function searchSnippet(text: string, query: string, lead = 24): Snippet {
  const t = String(text ?? '');
  const q = String(query ?? '').trim();
  const i = q ? t.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return { before: t, match: '', after: '' };
  let before = t.slice(0, i);
  if (before.length > lead) {
    // Cut on a word boundary where there is one close by.
    const cut = before.slice(-lead);
    const sp = cut.indexOf(' ');
    before = '…' + (sp >= 0 && sp < lead / 2 ? cut.slice(sp + 1) : cut);
  }
  return { before, match: t.slice(i, i + q.length), after: t.slice(i + q.length) };
}
