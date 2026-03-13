// fix3.js — fixes the mangled line 281 in securityService.ts
const fs = require('fs');

let s = fs.readFileSync('services/securityService.ts', 'utf8');

// The broken line looks like:
// const deviceModel = DeviceInfo.getModel() => 'unknown');
// It should be:
// const deviceModel = DeviceInfo.getModel();

s = s.replace(
  /const deviceModel = DeviceInfo\.getModel\(\)[^;]*;/,
  "const deviceModel = DeviceInfo.getModel();"
);

fs.writeFileSync('services/securityService.ts', s, 'utf8');

// Verify
const lines = fs.readFileSync('services/securityService.ts', 'utf8').split('\n');
console.log('Line 279:', lines[278]);
console.log('Line 280:', lines[279]);
console.log('Line 281:', lines[280]);
console.log('Line 282:', lines[281]);
console.log('✅ Fixed securityService.ts line 281');
