// lib/resumableUpload.plan.ts — pure part-planning for resumable multipart
// upload. Split out from resumableUpload.ts (which imports React-Native-only
// modules) so the byte-range math — the part where an off-by-one corrupts the
// assembled object — is unit-checkable in plain Node/tsx.

export interface PartPlan { part: number; position: number; length: number }

/**
 * Split a `size`-byte file into `partSize` chunks. Part numbers are 1-based
 * (S3/R2 requirement). The last part is whatever remains (< partSize). The
 * plan tiles [0, size) exactly: no gaps, no overlaps, summing to `size`.
 */
export function planParts(size: number, partSize: number): PartPlan[] {
  if (size <= 0 || partSize <= 0) return [];
  const parts: PartPlan[] = [];
  let part = 1;
  for (let pos = 0; pos < size; pos += partSize) {
    parts.push({ part, position: pos, length: Math.min(partSize, size - pos) });
    part++;
  }
  return parts;
}

// ── self-check: `npx tsx lib/resumableUpload.plan.ts` ──
function _selfCheck(): void {
  const assert = (c: boolean, m: string) => { if (!c) throw new Error('planParts self-check: ' + m); };

  // exact multiple → equal parts
  let p = planParts(24, 8);
  assert(p.length === 3, '24/8 → 3 parts');
  assert(p[0].position === 0 && p[0].length === 8, 'part 1');
  assert(p[2].position === 16 && p[2].length === 8, 'last part');

  // remainder → short last part
  p = planParts(20, 8);
  assert(p.length === 3, '20/8 → 3 parts');
  assert(p[2].length === 4, 'short last part = 4');

  // smaller than one part → single part
  p = planParts(3, 8);
  assert(p.length === 1 && p[0].length === 3, 'single short part');

  // covers [0,size) exactly for a range of sizes: 1-based, contiguous, sums to size
  for (const [size, ps] of [[1, 8], [8, 8], [9, 8], [100, 8], [8_388_609, 8_388_608]] as const) {
    const plan = planParts(size, ps);
    let expectPos = 0, total = 0;
    plan.forEach((pp, i) => {
      assert(pp.part === i + 1, `1-based part @${size}`);
      assert(pp.position === expectPos, `contiguous @${size}`);
      assert(pp.length > 0 && pp.length <= ps, `length bound @${size}`);
      expectPos += pp.length; total += pp.length;
    });
    assert(total === size, `covers size @${size}`);
  }

  // degenerate
  assert(planParts(0, 8).length === 0, 'zero size → no parts');

  console.log('planParts self-check: OK');
}

// tsx/node entry (no-op under Metro/RN, where require.main is undefined)
declare const require: any;
declare const module: any;
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
