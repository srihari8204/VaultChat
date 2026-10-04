// lib/nav/navErrorText.ts — the text for a failed "start navigation" or
// "navigate back to the lock" action.
//
// lib/userErrorText, except that the copy navigation throws on purpose (the
// missing location permission, no route between the two points) is kept: it
// tells the person what to fix, where the generic fallback would hide it.
// Every other local error (a GPS or platform message) still gets the caller's
// fallback, server copy still passes through, and a request with no HTTP answer
// still reads as connection copy. Pure, so it is Node-tested.

import { userErrorText } from '../userErrorText';

export const NAV_PERMISSION_TEXT = 'Location permission is required for navigation.';
export const NO_ROUTE_TEXT = 'No route was found to this place. Try another travel mode or a nearby destination.';

/** An Error whose message is deliberate user copy (kept by navErrorText). */
export function navUserError(message: string): Error {
  return Object.assign(new Error(message), { userFacing: true as const });
}

export function navErrorText(e: unknown, fallback: string): string {
  const x = e as { userFacing?: boolean; message?: string } | null | undefined;
  if (x?.userFacing === true && x.message) return x.message;
  return userErrorText(e, fallback);
}
