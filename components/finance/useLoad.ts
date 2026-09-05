// components/finance/useLoad.ts — did this screen's data load, or not?
//
// Every finance list screen reloads on focus and, before this, threw the result
// away on failure: `listLedger(me.id).then(setRows).catch(() => {})`. A failed
// read therefore rendered the EMPTY state — the screen told the user "No
// ledgers yet" when the truth was "I could not read your ledger book". For a
// financial app that is the worst possible lie to tell.
//
// This is presentation state only. It does not touch the queries, the data or
// the order anything happens in.

import { useCallback, useState } from 'react';

export type LoadStatus = 'loading' | 'ready' | 'error';

export function useLoadStatus() {
  const [status, setStatus] = useState<LoadStatus>('loading');

  // Screens reload on EVERY focus. Once we have shown real content, a refocus
  // must not drop back to a spinner — that flashes the list away each time the
  // user navigates back, which reads as a bug. Only the first load, or a retry
  // after an error, shows the loading state.
  const begin = useCallback(() => setStatus(s => (s === 'ready' ? s : 'loading')), []);
  const done = useCallback(() => setStatus('ready'), []);
  const fail = useCallback(() => setStatus('error'), []);

  return { status, begin, done, fail };
}

export default useLoadStatus;
