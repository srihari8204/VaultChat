// fix-routes.js
// Run from: C:\Users\ADMIN\Desktop\Vaultchat backup
// Fixes:
//   1. otp.tsx: /pinsetup → /pinentry, /photoupload → /profile-setup
//   2. _layout.tsx: /securityquestions → /security-questions
//   3. securityService.ts: DeviceInfo.default.getModel() → DeviceInfo.getModel()

const fs = require('fs');
const path = require('path');

const BASE = __dirname;

function fixFile(filePath, replacements) {
  if (!fs.existsSync(filePath)) {
    console.log(`SKIP (not found): ${filePath}`);
    return;
  }
  let content = fs.readFileSync(filePath, 'utf8');
  let changed = false;
  for (const [from, to] of replacements) {
    if (content.includes(from)) {
      content = content.split(from).join(to);
      console.log(`  ✅ Fixed: "${from}" → "${to}"`);
      changed = true;
    } else {
      console.log(`  ⚠️  Not found (already fixed?): "${from}"`);
    }
  }
  if (changed) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`  💾 Saved: ${filePath}\n`);
  }
}

// ── 1. otp.tsx ────────────────────────────────────────────────
console.log('📄 Fixing otp.tsx...');
fixFile(path.join(BASE, 'app', 'otp.tsx'), [
  ['/pinsetup',    '/pinentry'],
  ['/photoupload', '/profile-setup'],
]);

// ── 2. _layout.tsx ────────────────────────────────────────────
console.log('📄 Fixing _layout.tsx...');
fixFile(path.join(BASE, 'app', '_layout.tsx'), [
  ['/securityquestions',  '/security-questions'],
  ["'/securityquestions'","'/security-questions'"],
  ['"securityquestions"', '"security-questions"'],
  ['securityquestions',   'security-questions'],   // catch-all for route name strings
]);

// ── 3. securityService.ts ─────────────────────────────────────
console.log('📄 Fixing securityService.ts...');
fixFile(path.join(BASE, 'services', 'securityService.ts'), [
  ['DeviceInfo.default.getModel()',        'DeviceInfo.getModel()'],
  ['DeviceInfo.default.isRooted()',        'DeviceInfo.isRooted()'],
  ['DeviceInfo.default.getFingerprint()',  'DeviceInfo.getFingerprint()'],
  ['DeviceInfo.default.isAdbEnabled()',    'DeviceInfo.isAdbEnabled()'],
  ['DeviceInfo.default.isEmulator()',      'DeviceInfo.isEmulator()'],
  ['DeviceInfo.default.',                  'DeviceInfo.'],  // catch any others
]);

console.log('\n✅ All fixes applied. Metro will auto-reload.');
