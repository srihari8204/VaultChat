// lib/userErrorText.ts — the text a person reads when an action fails, never
// the raw message of a JS or network error ("Network request failed",
// "undefined is not an object", a crypto library's tag error).
//
// lib/api errors carry `status`, and their message is already user copy: the
// server's own `{ error }`, or lib/httpErrorMessage's fallback. Those pass
// through. A request that got no HTTP answer becomes connection copy. Anything
// else gets the caller's fallback. Pure, so it is Node-tested.

export function isConnectionError(e: unknown): boolean {
  const x = e as { status?: number; message?: string; name?: string } | null | undefined;
  return !!x && !x.status && (x.name === 'AbortError'
    || /network request failed|network unavailable|network error|failed to fetch|timed? ?out|aborted/i.test(String(x.message ?? '')));
}

export function userErrorText(e: unknown, fallback: string): string {
  const x = e as { status?: number; message?: string } | null | undefined;
  if (typeof x?.status === 'number' && x.message) return x.message;
  if (isConnectionError(e)) return 'Check your connection and try again.';
  return fallback;
}

export default userErrorText;
