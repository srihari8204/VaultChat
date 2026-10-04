// lib/groups/latestSave.ts — save a setting so the LAST choice wins.
//
// group-admin used to drop a tap on a different option while that setting's
// save was running (no feedback). Now the newest choice is shown at once and
// written as soon as the running save finishes; choices in between are skipped
// (only the latest matters). On a failure the control returns to the last value
// the server accepted. One chain per key, so different settings stay independent.
//
// Pure (no React), so the self-test runs under tsx.

export type LatestSaveResult<T> =
  | { status: 'saved'; value: T }        // the final choice is on the server
  | { status: 'queued' }                 // a save for this key is running; it will write this choice
  | { status: 'unchanged' }              // the choice equals what is already saved
  | { status: 'failed'; value: T; error: unknown }; // `value` = last value the server accepted

export function makeLatestSaver() {
  const wanted = new Map<string, unknown>();

  return async function save<T>(
    key: string,
    saved: T,
    next: T,
    write: (v: T) => Promise<unknown>,
    show: (v: T) => void,
  ): Promise<LatestSaveResult<T>> {
    if (wanted.has(key)) {
      wanted.set(key, next);
      show(next);
      return { status: 'queued' };
    }
    if (saved === next) return { status: 'unchanged' };
    wanted.set(key, next);
    show(next);
    let last = saved;
    try {
      for (;;) {
        const want = wanted.get(key) as T;
        if (want === last) return { status: 'saved', value: last };
        await write(want);
        last = want;
      }
    } catch (error) {
      show(last);
      return { status: 'failed', value: last, error };
    } finally {
      wanted.delete(key);
    }
  };
}
