// units.selftest.ts — one unit vocabulary across product, order and khata.
//
// # WHY THIS EXISTS
//
// `unit` has always been a column on shopbook_product, shopbook_order_item AND
// shopbook_ledger_item, and the invoice renderer already prints it. But only
// the order path ever filled it, and only from free text. Production drifted
// exactly as you would expect:
//
//     order items:  1kg x29   250g x14   100g x7   500g x7   1L x5   (empty) x11
//     khata items:  (empty) x6      <- every single one
//
// The khata form never asked for a unit and hardcoded `unit: ''`, so "Sugar 1 x
// Rs250" could not say whether that was a kilo, a packet or a single sachet.
//
// # THE MODEL: PACK, NOT MEASURE
//
// `unit` labels what ONE of something is; `qty` counts those. 2 x "1kg" is two
// one-kilo packs. Loose weight is qty 2.5 of unit "kg". This is what the 63
// existing order rows already mean, and reinterpreting them as measures would
// silently change what every historical invoice claims was sold.
//
//   npx tsx utils/units.selftest.ts

import { readFileSync } from 'fs';
import { join } from 'path';
import { UNIT_PRESETS, normalizeUnit, formatQtyUnit } from './shopbook';

const ROOT = join(__dirname, '..');
const UI = readFileSync(join(ROOT, 'app', 'shop-book.tsx'), 'utf8');

let failures = 0;
const A = (ok: boolean, what: string): void => {
  if (!ok) { failures++; console.error('  FAIL', what); } else console.log('  ok  ', what);
};

console.log('\nShopBook units\n');

// ── 1. THE VOCABULARY ──────────────────────────────────────────────
A(UNIT_PRESETS.includes('pc' as any), '1. pieces (soap) is offered');
A(UNIT_PRESETS.includes('kg' as any), '2. kilos (rice) is offered');
for (const u of ['g', 'L', 'ml', 'packet', 'dozen']) {
  A(UNIT_PRESETS.includes(u as any), `3. ${u} is offered`);
}
A(new Set(UNIT_PRESETS).size === UNIT_PRESETS.length, '4. no duplicate presets');

// ── 2. NORMALISE WITHOUT REWRITING INTENT ──────────────────────────
A(normalizeUnit('KG') === 'kg', '5. KG folds to the preset kg');
A(normalizeUnit(' Kg ') === 'kg', '6. and whitespace/case together');
A(normalizeUnit('PC') === 'pc', '7. PC folds to pc');
A(normalizeUnit('5Kg Bag') === '5Kg Bag',
  '8. a deliberate custom unit is left EXACTLY as written, not lowercased');
A(normalizeUnit('') === '' && normalizeUnit('   ') === '',
  '9. blank stays blank — a unit is optional, never invented');
A(normalizeUnit(undefined as any) === '', '10. a missing value is safe');
A(normalizeUnit('sachet') === 'sachet',
  '11. anything not in the list is still accepted — no shop is locked out');

// ── 3. PACK SEMANTICS, NOT MEASURE ─────────────────────────────────
A(formatQtyUnit(2, '1kg') === '2 x 1kg', '12. 2 x 1kg reads as two one-kilo packs');
A(formatQtyUnit(3, 'pc') === '3 x pc', '13. soap reads in pieces');
A(formatQtyUnit(2.5, 'kg') === '2.5 x kg',
  '14. loose weight is expressible as a fractional qty of kg');
A(formatQtyUnit(2, '') === '2', '15. no unit degrades to a bare count, not "2 x "');
A(formatQtyUnit(NaN as any, 'kg') === '0 x kg', '16. a broken qty renders 0, never NaN');

// ── 4. ALL THREE ENTRY POINTS ASK ──────────────────────────────────
A(/UNIT_PRESETS\.map/.test(UI),
  '17. the customer order line offers the presets');
A(/normalizeUnit\(tUnit\)/.test(UI),
  '18. and carries the chosen unit into the cart');
// The escape hatch moved behind the "+ custom" chip (see 28) so it no longer
// costs a permanent full-width input; only its wording changed.
A(/placeholder="Unit \(500g packet, 5kg bag\.\.\.\)"/.test(UI),
  '19. a free-text escape hatch still exists for units outside the presets');
A(/placeholder="Unit"/.test(UI),
  '20. the khata product row asks for a unit');
A(/unit: normalizeUnit\(it\.unit\)/.test(UI),
  '21. and sends it instead of the hardcoded empty string');
A(!/brand: '', unit: '',/.test(UI),
  '22. the hardcoded `unit: \'\'` is gone');

// ── 5. THE CATALOGUE PATH STILL INHERITS ───────────────────────────
A(/add\(p\.name, p\.brand, 1, p\.price, '', p\.unit,/.test(UI),
  '23. a catalogue line still takes the product\'s own unit, unchanged');

// ── 6. CATALOG-FIRST LAYOUT AND THE STEPPER ────────────────────────
// The typed panel is the fallback; it must not be the first thing on screen,
// and ten wrapped chips must not push the form off the bottom.
A(/const \[typeOpen, setTypeOpen\] = useState\(false\)/.test(UI),
  '24. the typed-product panel starts collapsed');
A(UI.indexOf('{typeOpen && (') > UI.indexOf('{filtered.map((p) => ('),
  '25. and is rendered BELOW the catalog list');
A(/Use “Type any product” below\./.test(UI),
  '26. the empty state points below, not above');
A(/<ScrollView horizontal showsHorizontalScrollIndicator=\{false\}[\s\S]{0,200}UNIT_PRESETS\.map/.test(UI),
  '27. the chips are ONE horizontally scrolling row, not a wrapped block');
A(/label="\+ custom"/.test(UI) && /\{customUnit && \(/.test(UI),
  '28. the free-text unit box hides behind a + custom chip');

// The stepper edits the cart, which stays the only source of quantity truth.
A(/const lineFor = \(productId: string\) => cart\.find/.test(UI),
  '29. the row reads its quantity from the cart');
A(/const bump = \(productId: string, d: number\)/.test(UI),
  '30. +/- nudges that cart line');
A(/next <= 0 \? cart\.filter/.test(UI),
  '31. stepping below 1 removes the line rather than leaving qty 0');
A(/const setExact = \(productId: string, raw: string\)/.test(UI),
  '32. and the quantity can be typed exactly, for 2.5 kg');
A(/<Text style=\{s\.qtyUnit\}>\{p\.unit\}<\/Text>/.test(UI),
  '33. the unit sits beside the number so "2" is never ambiguous');

// Merging is what keeps the stepper and the cart from disagreeing.
A(/const at = cart\.findIndex\(\(c\) => c\.productId === productId\)/.test(UI),
  '34. a repeat Add merges into the existing catalog line');
A(/if \(productId\) \{/.test(UI),
  '35. but only for catalog lines - two free-typed requests stay separate');

console.log(failures === 0
  ? '\nALL UNIT CHECKS PASSED ✓  (device test separate)\n'
  : `\n${failures} FAILED ✗\n`);
process.exit(failures === 0 ? 0 : 1);
