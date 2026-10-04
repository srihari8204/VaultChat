// lib/sosReachCopy.ts — what an SOS result says about who it reached.
//
// `contactsNotified` is who the alert was ADDRESSED to (including contacts with
// no device). `contactsReached` (R4BE C13: written, not deployed) is who the push
// provider accepted it for — still not proof a phone showed it, so the copy says
// "reached", never "saw". Today's server omits it; then the copy only says the
// alert was sent. Pure, so the wording is tested without React Native.

/** contactsReached from a server answer, or null when absent / not a number. */
export function sosReachedOf(r: unknown): number | null {
  const v = (r as { contactsReached?: unknown } | null | undefined)?.contactsReached;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

const contacts = (n: number) => `${n} trusted contact${n === 1 ? '' : 's'}`;

/** One sentence for an SOS result, plus a warning when some contacts were not reached. */
export function sosReachText(notified: number, reached: number | null, withLocation: boolean): { line: string; warn: string | null } {
  const where = withLocation ? ' with your location' : '';
  if (notified <= 0) return { line: `No trusted contacts were alerted${where}.`, warn: null };
  if (reached == null) return { line: `Sent to ${contacts(notified)}${where}.`, warn: null };
  const shown = Math.min(reached, notified);
  return {
    line: `Reached ${shown} of ${contacts(notified)}${where}.`,
    warn: shown < notified
      ? `${notified - shown} could not be reached (no app, or notifications turned off).`
      : null,
  };
}
