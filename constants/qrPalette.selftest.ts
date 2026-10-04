// constants/qrPalette.selftest.ts — run: npx tsx constants/qrPalette.selftest.ts
//
// QR codes must be dark modules on a light ground with strong contrast in every
// theme, and every screen that draws one must take the colours from here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrastOn } from '../components/chat/bubbleFillInk';
import { QR_COLORS, QR_SCAN_OVERLAY } from './qrPalette';

const lum = (hex: string) => contrastOn(hex, '#000000');   // higher = lighter
assert.ok(lum(QR_COLORS.backgroundColor) > lum(QR_COLORS.color), 'QR modules must be darker than the ground (inverted codes fail on many scanners)');
const r = contrastOn(QR_COLORS.color, QR_COLORS.backgroundColor);
assert.ok(r >= 15, `QR module/ground contrast is ${r.toFixed(2)}:1; keep it near black on white`);
assert.ok(contrastOn(QR_SCAN_OVERLAY.ink, QR_SCAN_OVERLAY.shadow) >= 15, 'the scanner hint and its shadow must be opposite ends');

for (const f of ['app/qr-contact.tsx', 'app/verify-contact.tsx', 'app/invite-link.tsx']) {
  const src = readFileSync(join(__dirname, '..', f), 'utf8');
  for (const m of src.matchAll(/<QRCode\b[^>]*>/g)) {
    assert.ok(/\{\.\.\.QR_COLORS\}/.test(m[0]), `${f}: a <QRCode> does not take QR_COLORS`);
  }
  assert.ok(!/['"`]#[0-9a-fA-F]{3,8}['"`]/.test(src), `${f} has an inline hex colour again`);
}
console.log(`qrPalette: QR ${r.toFixed(2)}:1 dark-on-light, used by every QR screen`);
