// lib/storyFeedCache.ts — the story feed, shared between the list and the viewer.
//
// WHY THIS EXISTS: opening a status cost THREE sequential round trips before a
// single pixel — feed, then the wrapped key, then the media — and the first of
// them was pure waste. The list screen had just fetched the feed to draw the
// row the person tapped; the viewer then threw that away and fetched the whole
// thing again only to find one entry in it. Measured against prod that is ~1s
// of a ~2.6s warm open, on the critical path, every single time.
//
// The AsyncStorage copy the list screen already writes (key below) is the same
// data, so the viewer reads THAT first and revalidates in the background. The
// in-memory copy short-circuits even the disk read on the common path, where
// the viewer opens seconds after the list rendered.
//
// STALENESS IS SAFE HERE and that is what makes this worth doing. The worst a
// stale entry can do is show a story that has since been deleted, or miss one
// posted in the last few seconds — and the background revalidation corrects
// both within a round trip. Nothing here is an authorization decision: the
// media still needs its wrapped key from the server, and a gate is still
// enforced by the key, not by this cache.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { StoryFeedEntry } from './chatService';

/** Must match the key the status list screen writes. */
export const FEED_CACHE_KEY = 'vc_stories_feed';

/** How long a cached feed may be used before the viewer waits for the network
 *  instead. Long enough to cover tapping a row you can see, short enough that
 *  a feed from a previous session is never trusted. */
export const FEED_CACHE_TTL_MS = 60_000;

let memo: { at: number; feed: StoryFeedEntry[] } | null = null;

/** Called by whoever fetches the feed, so the next reader does not refetch. */
export function putStoryFeed(feed: StoryFeedEntry[]): void {
  memo = { at: Date.now(), feed };
  AsyncStorage.setItem(FEED_CACHE_KEY, JSON.stringify(feed)).catch(() => {});
}

/**
 * A feed good enough to render from right now, or null to fetch.
 *
 * Returns the in-memory copy when fresh, otherwise the disk copy — which has
 * no timestamp of its own, so it is only ever used to paint something
 * immediately while the network answer is still in flight. Callers MUST still
 * revalidate.
 */
export async function peekStoryFeed(): Promise<StoryFeedEntry[] | null> {
  if (memo && Date.now() - memo.at < FEED_CACHE_TTL_MS) return memo.feed;
  try {
    const raw = await AsyncStorage.getItem(FEED_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoryFeedEntry[]) : null;
  } catch {
    return null;   // a corrupt cache is a cache miss, never an error
  }
}

/** Drop the memo (used after posting or deleting, where the feed is known stale). */
export function invalidateStoryFeed(): void {
  memo = null;
}
