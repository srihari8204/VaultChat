// lib/missingRoute.ts — tell "the server has no such route yet" from a real 404.
//
// Endpoints written in the backend but not yet deployed (fixes/R4BE.md) answer
// with Go's plain-text "404 page not found" (or 405 on an existing path with a
// new method). lib/api parses no JSON body from that, so `body.error` is absent.
// A real "Channel not found" 404 carries `{ "error": … }` and is NOT a missing
// route. Pure, so it is Node-tested.

export function isMissingRoute(e: unknown): boolean {
  const x = e as { status?: number; body?: { error?: unknown } | null } | null | undefined;
  return (x?.status === 404 || x?.status === 405) && !x?.body?.error;
}
