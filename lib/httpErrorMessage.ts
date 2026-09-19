// lib/httpErrorMessage.ts — the LAST-RESORT text for a failed request, when
// the server sent no message of its own.
//
// lib/api.ts used to fall back to `res.statusText || `HTTP ${res.status}``, and
// roughly 248 call sites do
//     catch (e: any) { Alert.alert('Could not load X', e?.message ?? 'Try again.') }
// so that string is the one a person actually reads. On a handset the Spaces
// screens put up a modal whose entire body was **"HTTP 404"** — a status code,
// in a dialog, with an OK button. Measured on an Honor ELI-NX9 (Android 16),
// 2026-09-19; one of those dialogs also blocked navigation until dismissed.
//
// Fixed in ONE place rather than at the 248 call sites: they all take their
// text from here, so patching them individually would be 248 chances to miss
// one, and no guarantee at all for the next screen somebody writes.
//
// Its own module, not a function inside api.ts, for one boring reason: api.ts
// imports react-native, so a selftest importing it cannot run under tsx. This
// file imports nothing.
//
// What is deliberately NOT changed by this:
//   * A message the SERVER supplied still wins — api.ts overwrites the fallback
//     from `{ error }` / `{ error: { message } }`. This is only used when that
//     is absent.
//   * `err.status` is untouched, so the 24 call sites that branch on it, and
//     mediaOutbox's permanent-vs-transient retry rule, behave identically.
//   * `res.statusText` is ignored even when present. RN's fetch gives the raw
//     HTTP reason phrase ("Not Found", "Unprocessable Entity"), which is the
//     same protocol trivia in friendlier clothing; the mapping below says what
//     the person can do instead.

export function httpErrorMessage(status: number, _statusText?: string): string {
  switch (status) {
    case 400: return 'That request was not valid. Please check and try again.';
    case 401: return 'Your session has expired. Please sign in again.';
    case 403: return 'You do not have permission to do that.';
    case 404: return 'That is not available.';
    case 408: return 'The server took too long to answer. Please try again.';
    case 409: return 'That changed while you were working. Please refresh and try again.';
    case 413: return 'That file is too large to upload.';
    case 429: return 'Too many attempts. Please wait a moment and try again.';
    case 507: return 'The server is out of storage space.';
  }
  if (status >= 500) return 'The server is having trouble. Please try again shortly.';
  if (status >= 400) return 'That request could not be completed.';
  // Not an error status at all — only reachable if a caller misuses this. Still
  // returns something showable, because every caller renders it unconditionally.
  return 'Something went wrong. Please try again.';
}

export default httpErrorMessage;
