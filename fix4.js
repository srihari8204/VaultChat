// fix4.js
const fs = require('fs');

// ── 1. Fix duplicate pinentry in _layout.tsx ─────────────────
let layout = fs.readFileSync('app/_layout.tsx', 'utf8');

// Find all Stack.Screen name="pinentry" occurrences
const pinentryMatches = (layout.match(/<Stack\.Screen name="pinentry"[^/]*\/>/g) || []);
console.log('pinentry occurrences found:', pinentryMatches.length, pinentryMatches);

// Remove ALL pinentry entries first, then add back exactly ONE
layout = layout.replace(/<Stack\.Screen name="pinentry"[^/]*\/>\s*/g, '');

// Insert ONE pinentry after the pinsetup/profile-setup line (or after otp line)
// Find a safe insertion point — after <Stack.Screen name="otp"
if (layout.includes('<Stack.Screen name="otp"')) {
  layout = layout.replace(
    '<Stack.Screen name="otp"',
    '<Stack.Screen name="pinentry" />\n        <Stack.Screen name="otp"'
  );
  console.log('✅ Re-inserted pinentry once after a safe point');
} else {
  console.log('⚠️  Could not find insertion point — check _layout.tsx manually');
}

fs.writeFileSync('app/_layout.tsx', layout, 'utf8');

// Verify
const remaining = (layout.match(/<Stack\.Screen name="pinentry"/g) || []);
console.log('pinentry count after fix:', remaining.length, '(should be 1)');

// ── 2. Fix DeviceInfo.default in securityService.ts ──────────
let svc = fs.readFileSync('services/securityService.ts', 'utf8');

// Show all DeviceInfo.default occurrences
const lines = svc.split('\n');
lines.forEach((l, i) => {
  if (l.includes('DeviceInfo.default')) {
    console.log(`securityService line ${i+1}: ${l.trim()}`);
  }
});

// Replace all DeviceInfo.default. with DeviceInfo.
const before = svc;
svc = svc.replace(/DeviceInfo\.default\./g, 'DeviceInfo.');
if (svc !== before) {
  fs.writeFileSync('services/securityService.ts', svc, 'utf8');
  console.log('✅ Fixed DeviceInfo.default. → DeviceInfo.');
} else {
  console.log('ℹ️  No DeviceInfo.default. found in securityService.ts');
}

// Check if the issue is in _layout.tsx itself
let layoutSvc = fs.readFileSync('app/_layout.tsx', 'utf8');
const layoutDeviceInfo = layoutSvc.split('\n').filter(l => l.includes('DeviceInfo.default'));
if (layoutDeviceInfo.length > 0) {
  layoutDeviceInfo.forEach(l => console.log('_layout DeviceInfo.default:', l.trim()));
  layoutSvc = layoutSvc.replace(/DeviceInfo\.default\./g, 'DeviceInfo.');
  fs.writeFileSync('app/_layout.tsx', layoutSvc, 'utf8');
  console.log('✅ Fixed DeviceInfo.default. in _layout.tsx');
}

console.log('\n✅ Done — Metro will rebundle');
