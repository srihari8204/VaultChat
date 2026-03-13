// fix-auth-testmode.js
const fs = require('fs');

let s = fs.readFileSync('app/(constants)/authService.ts', 'utf8');

// Replace the TEST_NUMBERS array with only the dedicated test number
s = s.replace(
  /const TEST_NUMBERS\s*=\s*\[[^\]]+\];/,
  'const TEST_NUMBERS = ["+919999999999"]; // Only this number uses test OTP 123456'
);

fs.writeFileSync('app/(constants)/authService.ts', s, 'utf8');

// Verify
const lines = fs.readFileSync('app/(constants)/authService.ts', 'utf8').split('\n');
lines.forEach((l, i) => {
  if (l.includes('TEST_NUMBERS') || l.includes('919')) console.log((i+1)+':', l.trim());
});
console.log('\n✅ Done.');
console.log('  +919999999999 → OTP 123456 (your test account)');
console.log('  All other numbers → real Firebase SMS');
