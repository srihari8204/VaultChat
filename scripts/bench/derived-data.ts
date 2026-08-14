// scripts/bench/derived-data.ts — run: npx tsx scripts/bench/derived-data.ts
//
// Measures the three derived-data passes the chat screen runs on EVERY message
// array change — every incoming message, every receipt, every optimistic send:
//
//   1. dedupe        (the renderMessages loop, lifted from app/chat.tsx)
//   2. groupAlbums   (lib/albumGrouping — the real function)
//   3. mergeReactions(lib/reactionMerge — the real function)
//
// This is measurement only. Nothing here is imported by the app, and the
// benchmark does not change any behaviour it measures.
//
// WHAT THIS CAN AND CANNOT TELL YOU
// ---------------------------------
// It measures JS-thread cost of the derived pipeline on Node, on a desktop CPU.
// A phone's JS thread is materially slower — treat these as a LOWER BOUND and a
// relative ranking, never as device numbers. It says nothing about
// virtualization, frame drops, image decode, or the UI thread, because none of
// those exist here.
//
// The data is SYNTHETIC. Real conversations differ in album density, reaction
// density and reply depth, all of which move these numbers.

import { groupAlbums, resetAlbumCache } from '../../lib/albumGrouping';
import { mergeReactions } from '../../lib/reactionMerge';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// ── the dedupe loop, lifted from the screen rather than restated ──────────
const CHAT_SRC = readFileSync(join(HERE, '..', '..', 'app', 'chat.tsx'), 'utf8');
const loopSrc = CHAT_SRC.match(
  /const seen = new Set<string>\(\);[\s\S]*?out\.push\(m\);\s*\}/);
if (!loopSrc) throw new Error('bench: could not lift the renderMessages dedupe loop from app/chat.tsx');
const dedupe = new Function('messages', `
  ${loopSrc[0].replace(/<string>/g, '').replace(/: DisplayMessage\[\]/g, '')}
  return out;
`) as (m: any[]) => any[];

// ── synthetic conversation generator ─────────────────────────────────────
type Profile = 'text-heavy' | 'media-heavy';

function makeConversation(n: number, profile: Profile) {
  const msgs: any[] = [];
  let id = 1;
  const albumEvery = profile === 'media-heavy' ? 12 : 60;   // how often an album appears
  const reactEvery = profile === 'media-heavy' ? 9 : 7;     // how often a reaction appears

  while (msgs.length < n) {
    // occasional album of 3–10 photos, each its OWN message (as the app does)
    if (msgs.length % albumEvery === 0 && msgs.length + 10 < n) {
      const albumId = `alb-${id}`;
      const size = 3 + (id % 8);
      for (let k = 0; k < size; k++) {
        msgs.push({
          id: id++, type: 'image', senderId: k % 2 ? 'u2' : 'me',
          content: null, createdAt: new Date(1767225600000 + id * 1000).toISOString(),
          meta: { albumId, albumIndex: k, attachmentId: `att-${id}` },
        });
      }
      continue;
    }
    const isMedia = profile === 'media-heavy' && id % 3 === 0;
    msgs.push({
      id: id++, type: isMedia ? 'image' : 'text',
      senderId: id % 2 ? 'u2' : 'me',
      content: isMedia ? null : `message body ${id} with some words in it`,
      createdAt: new Date(1767225600000 + id * 1000).toISOString(),
      meta: isMedia ? { attachmentId: `att-${id}` } : null,
    });
    // a reaction message targeting an earlier message
    if (id % reactEvery === 0 && msgs.length > 2) {
      const target = msgs[msgs.length - 2].id;
      msgs.push({
        id: id++, type: 'reaction', senderId: 'u2',
        createdAt: new Date(1767225600000 + id * 1000).toISOString(),
        content: JSON.stringify({ reactsTo: target, emoji: '👍', op: 'add' }),
      });
    }
  }
  return msgs.slice(0, n).reverse();   // newest-first, like the inverted list
}

// ── timing ───────────────────────────────────────────────────────────────
function bench(label: string, iters: number, fn: () => void): number {
  fn();                                   // warm
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6 / iters;
  console.log(`    ${label.padEnd(46)} ${ms.toFixed(3)} ms`);
  return ms;
}

const SIZES = [100, 1000, 5000, 10000];
const results: Record<string, Record<number, number>> = {};
const put = (k: string, n: number, v: number) => {
  (results[k] ??= {} as any)[n] = v;
};

for (const profile of ['text-heavy', 'media-heavy'] as Profile[]) {
  console.log(`\n=== profile: ${profile} (SYNTHETIC data) ===`);
  for (const n of SIZES) {
    const msgs = makeConversation(n, profile);
    const albums = new Set(msgs.filter(m => m.meta?.albumId).map(m => m.meta.albumId)).size;
    const reactions = msgs.filter(m => m.type === 'reaction').length;
    console.log(`\n  ${n} messages  (${albums} albums, ${reactions} reaction rows)`);

    resetAlbumCache();
    const iters = n >= 5000 ? 20 : 100;

    put(`${profile}/dedupe`, n, bench('dedupe (renderMessages loop)', iters, () => { dedupe(msgs); }));

    const deduped = dedupe(msgs);
    resetAlbumCache();
    put(`${profile}/groupAlbums-cold`, n, bench('groupAlbums  (cold cache)', iters, () => {
      resetAlbumCache(); groupAlbums(deduped);
    }));
    resetAlbumCache(); groupAlbums(deduped);
    put(`${profile}/groupAlbums-warm`, n, bench('groupAlbums  (warm cache)', iters, () => { groupAlbums(deduped); }));

    put(`${profile}/mergeReactions-cold`, n, bench('mergeReactions (no prev)', iters, () => {
      mergeReactions(msgs, 'me');
    }));
    const prevR = mergeReactions(msgs, 'me');
    put(`${profile}/mergeReactions-warm`, n, bench('mergeReactions (with prev)', iters, () => {
      mergeReactions(msgs, 'me', prevR);
    }));

    // ── THE QUESTION §13 ACTUALLY ASKS ─────────────────────────────────
    // "10,000 messages -> one receipt update -> how much work is performed?"
    // The screen patches ONE message object and re-runs the whole pipeline.
    const patched = msgs.map((m, i) => (i === Math.floor(msgs.length / 2)
      ? { ...m, deliveredAt: '2026-01-01T00:00:00.000Z' } : m));
    let stable = 0, total = 0;
    put(`${profile}/one-receipt-full-pipeline`, n, bench('ONE RECEIPT -> full pipeline', iters, () => {
      const d = dedupe(patched);
      const g = groupAlbums(d);
      const r = mergeReactions(patched, 'me', prevR);
      total = g.length;
      stable = Object.keys(r).length;
    }));
    // How much of that work actually invalidates a bubble?
    const before = groupAlbums(dedupe(msgs));
    const after = groupAlbums(dedupe(patched));
    let sameRows = 0;
    for (let i = 0; i < Math.min(before.length, after.length); i++) {
      if (before[i] === after[i]) sameRows++;
    }
    console.log(`    -> rows keeping identity: ${sameRows}/${after.length}` +
      `  (${((sameRows / after.length) * 100).toFixed(1)}% skip re-render)`);
    void total; void stable;
  }
}

// ── summary table ────────────────────────────────────────────────────────
console.log('\n\n=== SUMMARY: ms per pass, text-heavy (SYNTHETIC, Node on desktop CPU) ===');
console.log('  metric                                 100      1K      5K     10K');
for (const k of Object.keys(results).filter(k => k.startsWith('text-heavy'))) {
  const row = results[k];
  const name = k.replace('text-heavy/', '');
  console.log('  ' + name.padEnd(34) +
    SIZES.map(n => (row[n] ?? 0).toFixed(2).padStart(7)).join(' '));
}
console.log('\n=== media-heavy ===');
console.log('  metric                                 100      1K      5K     10K');
for (const k of Object.keys(results).filter(k => k.startsWith('media-heavy'))) {
  const row = results[k];
  const name = k.replace('media-heavy/', '');
  console.log('  ' + name.padEnd(34) +
    SIZES.map(n => (row[n] ?? 0).toFixed(2).padStart(7)).join(' '));
}
console.log('\nNOTE: Node on a desktop CPU. A phone JS thread is materially slower.');
console.log('      Lower bound and relative ranking only — NOT device numbers.');
