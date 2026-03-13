// fix2.js
const fs = require('fs');

// Fix _layout.tsx — lines 109-110
let layout = fs.readFileSync('app/_layout.tsx', 'utf8');
layout = layout.replace(
  '<Stack.Screen name="photoupload" />',
  '<Stack.Screen name="profile-setup" />'
);
layout = layout.replace(
  '<Stack.Screen name="pinsetup" />',
  '<Stack.Screen name="pinentry" />'
);
fs.writeFileSync('app/_layout.tsx', layout, 'utf8');
console.log('✅ _layout.tsx fixed');

// Fix securityService.ts — DeviceInfo.getModel().catch crash
let svc = fs.readFileSync('services/securityService.ts', 'utf8');

// The issue: getModel() returns a string in newer versions, not a Promise
// Replace any .catch() chained on getModel()
svc = svc.replace(/DeviceInfo\.getModel\(\)\s*\.catch\([^)]*\)/g, 'DeviceInfo.getModel()');
// Replace any await on getModel() 
svc = svc.replace(/await\s+DeviceInfo\.getModel\(\)/g, 'DeviceInfo.getModel()');
// Wrap bare getModel() calls in try-catch if used in async context
fs.writeFileSync('services/securityService.ts', svc, 'utf8');
console.log('✅ securityService.ts fixed');

// Verify
const layoutFixed = fs.readFileSync('app/_layout.tsx', 'utf8');
const hasPhotoupload = layoutFixed.includes('name="photoupload"');
const hasPinsetup = layoutFixed.includes('name="pinsetup"');
console.log('photoupload still present:', hasPhotoupload, '(should be false)');
console.log('pinsetup still present:', hasPinsetup, '(should be false)');
