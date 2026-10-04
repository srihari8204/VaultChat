// lib/media/fileUrl.ts — compare local file URLs the way WKWebView reports them.
//
// iOS percent-encodes a file URL's path (a space becomes %20, non-ASCII
// becomes %XX bytes) and writes file:/// where the app may have file://.
// Comparing raw strings refused a PDF's own load whenever its path had such
// a character. On iOS /var and /tmp are symlinks into /private, and WebKit may
// report either spelling of the same file. PURE (no react-native import).

/** The decoded absolute path of a file: URL or bare path; null for other schemes. */
export function filePathOf(url: string): string | null {
  let rest: string;
  if (/^file:/i.test(url)) rest = url.replace(/^file:(\/\/)?/i, '');
  else if (url.startsWith('/')) rest = url;
  else return null;
  rest = rest.split('#')[0].split('?')[0];
  let path: string;
  try { path = decodeURIComponent(rest); } catch { path = rest; }
  // /private/var/x and /var/x are the same file on iOS (symlink).
  return ('/' + path.replace(/^\/+/, '')).replace(/^\/private(?=\/(?:var|tmp)\/)/, '');
}

/** True when both name the same local file. */
export function sameFileUrl(a: string, b: string): boolean {
  const pa = filePathOf(a);
  return pa != null && pa === filePathOf(b);
}
