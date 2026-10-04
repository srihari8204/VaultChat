// lib/spaces/errors.ts — reading a caught error typed as `unknown`.
//
// lib/api throws an Error carrying `status` and the parsed `body`; other
// sources may throw anything. These read those fields from `unknown`, so the
// Spaces screens' catches stay typed. Pure, so the selftest runs under tsx.

type Shape = { message?: unknown; status?: unknown; statusCode?: unknown; body?: unknown };
const shape = (e: unknown): Shape => (e && typeof e === 'object' ? (e as Shape) : {});

/** The error's own words, if it carries a message. */
export function errMsg(e: unknown): string | undefined {
  const m = shape(e).message;
  return typeof m === 'string' && m ? m : undefined;
}

/** The HTTP status lib/api attached, or 0. */
export function errStatus(e: unknown): number {
  const { status, statusCode } = shape(e);
  const n = Number(status ?? statusCode ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** The server's `code` in an `{ code }` failure body, when there is one. */
export function errCode(e: unknown): string | undefined {
  const b = shape(e).body;
  const c = b && typeof b === 'object' ? (b as { code?: unknown }).code : undefined;
  return typeof c === 'string' ? c : undefined;
}
