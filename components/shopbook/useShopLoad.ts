// components/shopbook/useShopLoad.ts — one load / error / retry cycle for a
// Shop Book screen.
//
// Every list and detail screen here hand-rolled the same eight lines:
//   setLoading(true); setErr('');
//   try { setX(await SB.something()); } catch (e) { setErr(loadErrText(e)); }
//   finally { setLoading(false); }
// twenty times over, each free to drift (two of them forgot to clear the
// error, one never cleared it at all). This is that block, once.
//
// It also fixes what none of the copies did: a slow response from an EARLIER
// load landing after a newer one. Switching the owner's order tab from "New"
// to "Ready" while "New" was still in flight showed the "New" orders under the
// "Ready" tab. Only the latest load may write its result, error or spinner.
//
// components/finance/useLoad.ts (useLoadStatus) was the existing candidate and
// is not reused: it holds no error text and runs nothing, and it deliberately
// keeps a reload from showing the spinner — which Shop Book's pull-to-refresh
// is driven by.

import { useCallback, useEffect, useRef, useState } from 'react';
import { loadErrText } from './shared';

/**
 * @param fetch  Reads the data. Its identity is the reload trigger: pass a
 *               module function (SB.myOrders) or a useCallback over the values
 *               it reads, and the screen reloads when those change.
 * @param apply  Stores a result. Only the latest load's result is applied; it
 *               may be an inline function.
 * @param opts.auto     Load on mount and whenever `fetch` changes (default true).
 *                      False for screens that start the first load themselves.
 * @param opts.fallback What to say when the error carries no message.
 * @returns `load()` (no arguments; safe as an onPress / onRefresh handler) and
 *          `loadWith(...args)` for a fetch that takes arguments.
 */
export function useShopLoad<T, A extends unknown[] = []>(
  fetch: (...args: A) => Promise<T>,
  apply: (value: T) => void,
  opts: { auto?: boolean; fallback?: string } = {},
) {
  const auto = opts.auto !== false;
  const fallback = opts.fallback;
  const [loading, setLoading] = useState(auto);
  const [err, setErr] = useState('');

  const applyRef = useRef(apply);
  useEffect(() => { applyRef.current = apply; });
  const seq = useRef(0);

  const loadWith = useCallback(async (...args: A) => {
    const mine = ++seq.current;
    setLoading(true); setErr('');
    try {
      const value = await fetch(...args);
      if (mine === seq.current) applyRef.current(value);
    } catch (e: any) {
      if (mine === seq.current) setErr(fallback ? (e?.message || fallback) : loadErrText(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [fetch, fallback]);
  // The no-argument form, for retry buttons and pull-to-refresh. Those call
  // their handler WITH an event, which must never reach `fetch` as an argument
  // (SB.shopReturns(event) would ask for returns of status "[object Object]").
  const load = useCallback(() => loadWith(...([] as unknown[] as A)), [loadWith]);

  useEffect(() => { if (auto) void load(); }, [auto, load]);

  return { loading, err, load, loadWith };
}
