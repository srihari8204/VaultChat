// fix-otp-testmode.js
// Makes TEST MODE only active for +919999999999
// All other numbers use real Firebase Phone Auth SMS

const fs = require('fs');

let otp = fs.readFileSync('app/otp.tsx', 'utf8');

// Show current TEST MODE lines
const lines = otp.split('\n');
lines.forEach((l, i) => {
  if (l.includes('TEST') || l.includes('123456') || l.includes('test') && l.includes('mode')) {
    console.log(`Line ${i+1}: ${l.trim()}`);
  }
});

// Replace hardcoded TEST_MODE = true with phone-specific check
// Pattern 1: const TEST_MODE = true;
otp = otp.replace(
  /const TEST_MODE\s*=\s*true;/,
  "const TEST_MODE = phone === '+919999999999'; // Only test number bypasses SMS"
);

// Pattern 2: const isTestMode = true;
otp = otp.replace(
  /const isTestMode\s*=\s*true;/,
  "const isTestMode = phone === '+919999999999';"
);

// Pattern 3: inline if (TEST_MODE) or if (testMode)
// If TEST_MODE is checked but not defined as const, add the const at top of component
if (!otp.includes("phone === '+919999999999'")) {
  // Find the first use of TEST_MODE in the file to understand the pattern
  const testModeMatch = otp.match(/if\s*\(\s*TEST_MODE\s*\)/);
  if (testModeMatch) {
    // Add const before first usage
    otp = otp.replace(
      'if (TEST_MODE)',
      "const TEST_MODE = phone === '+919999999999'; // Only test number\n  if (TEST_MODE)"
    );
    console.log('✅ Injected TEST_MODE const before first usage');
  }
}

fs.writeFileSync('app/otp.tsx', otp, 'utf8');

// Verify
const result = fs.readFileSync('app/otp.tsx', 'utf8');
const testLines = result.split('\n').filter(l => 
  l.includes('TEST_MODE') || l.includes('isTestMode') || l.includes('919999999999')
);
console.log('\n✅ TEST MODE now restricted to +919999999999 only');
console.log('Relevant lines:');
testLines.forEach(l => console.log('  ', l.trim()));
console.log('\nAll other phone numbers → real Firebase SMS OTP');
