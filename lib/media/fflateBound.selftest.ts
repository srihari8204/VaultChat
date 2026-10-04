// lib/media/fflateBound.selftest.ts — run: npx tsx lib/media/fflateBound.selftest.ts
//
// app/archive-viewer checks an entry's DECLARED size (MAX_ENTRY_BYTES) before
// inflating it. That is only a real bound if inflation cannot produce more than
// was declared. fflate's unzip inflates into a buffer of exactly the declared
// originalSize and never grows it, so an entry that lies about its size comes
// out truncated. This pins that behaviour on the installed fflate, on both of
// its paths (synchronous under 512 KB, asynchronous above).

import assert from 'node:assert/strict';
import { unzip, zipSync, type Unzipped } from 'fflate';

const NAME = 'bomb.bin';
const REAL = 2_000_000;   // what the entry really inflates to

/** A zip whose one entry claims `declared` bytes but inflates to REAL. */
function lyingZip(declared: number): Uint8Array {
  const z = zipSync({ [NAME]: new Uint8Array(REAL) }, { level: 9 });
  const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
  for (let i = 0; i + 4 <= z.length; i++) {
    const sig = dv.getUint32(i, true);
    if (sig === 0x04034b50) dv.setUint32(i + 22, declared, true);   // local header
    if (sig === 0x02014b50) dv.setUint32(i + 24, declared, true);   // central directory
  }
  return z;
}

function inflateOne(zip: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    unzip(zip, { filter: f => f.name === NAME }, (err, out: Unzipped) => (err ? reject(err) : resolve(out[NAME])));
  });
}

(async () => {
  // Honest size: everything comes out.
  assert.equal((await inflateOne(lyingZip(REAL))).length, REAL, 'honest entry inflates fully');
  // Under-declared, synchronous path (< 512 KB declared).
  assert.ok((await inflateOne(lyingZip(1000))).length <= 1000, 'sync path is bounded by the declared size');
  // Under-declared, asynchronous path (>= 512 KB declared, well compressed).
  assert.ok((await inflateOne(lyingZip(600_000))).length <= 600_000, 'async path is bounded by the declared size');
  console.log('fflateBound selftest: all passed');
})().catch(e => { console.error(e); process.exit(1); });
