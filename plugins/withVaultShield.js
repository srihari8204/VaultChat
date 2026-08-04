/**
 * withVaultShield — Expo config plugin for the VaultShield device-integrity
 * detectors (native half of the Device Security & Monitoring module).
 *
 * Cloned from withVaultView.js — same copy + register pattern.
 *
 * Android:
 *  - copies plugins/android/VaultShield*.kt into the app package
 *    (com.vaultchat.app.vaultshield)
 *  - registers VaultShieldPackage in MainApplication
 *
 * iOS:
 *  - copies plugins/vaultshield-ios → ios/VaultShield (Swift + ObjC bridge +
 *    podspec) and adds `pod 'VaultShield', :path => './VaultShield'` to the Podfile
 *
 * Both platforms are OPTIONAL at runtime: services/security/deviceSecurity/
 * nativeSecurity.ts degrades to a documented "unavailable" state (every native
 * signal → pending) when the module is missing (Expo Go, or a build made before
 * this plugin landed). The dashboard then honestly shows "Not evaluated" rather
 * than a fake "clear".
 *
 * Run: expo prebuild --clean
 */
const { withDangerousMod, withMainApplication } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const PKG = 'com.vaultchat.app';
const VS_PKG = `${PKG}.vaultshield`;
const KOTLIN = ['VaultShieldModule.kt', 'VaultShieldPackage.kt'];
const IOS_TEMPLATE = 'vaultshield-ios';
const IOS_POD = 'VaultShield';

function withKotlinSources(config) {
  return withDangerousMod(config, [
    'android',
    (cfg) => {
      const srcDir = path.join(cfg.modRequest.projectRoot, 'plugins', 'android');
      const destDir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app', 'src', 'main', 'java', ...VS_PKG.split('.'),
      );
      fs.mkdirSync(destDir, { recursive: true });
      for (const f of KOTLIN) {
        const from = path.join(srcDir, f);
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(destDir, f));
      }
      return cfg;
    },
  ]);
}

function withPackageRegistration(config) {
  return withMainApplication(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (src.includes(`${VS_PKG}.VaultShieldPackage()`)) return cfg;   // already registered
    const add = `add(${VS_PKG}.VaultShieldPackage())`;

    if (src.includes('// add(MyReactNativePackage())')) {
      src = src.replace('// add(MyReactNativePackage())', `// add(MyReactNativePackage())\n              ${add}`);
    } else if (src.includes('.packages.apply {')) {
      src = src.replace('.packages.apply {', `.packages.apply {\n              ${add}`);
    } else if (/val\s+packages\s*=\s*PackageList\(this\)\.packages/.test(src)) {
      src = src.replace(/(val\s+packages\s*=\s*PackageList\(this\)\.packages)/, `$1\n      packages.${add}`);
    } else {
      console.warn(`[withVaultShield] could not auto-register VaultShieldPackage — add \`packages.${add}\` to MainApplication.getPackages() manually`);
    }
    cfg.modResults.contents = src;
    return cfg;
  });
}

function withIos(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const src = path.join(cfg.modRequest.projectRoot, 'plugins', IOS_TEMPLATE);
      if (!fs.existsSync(src)) {
        console.warn(`[withVaultShield] plugins/${IOS_TEMPLATE} not found — iOS VaultShield SKIPPED`);
        return cfg;
      }
      const dest = path.join(cfg.modRequest.platformProjectRoot, IOS_POD);
      fs.cpSync(src, dest, { recursive: true });

      const podfile = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      if (fs.existsSync(podfile)) {
        let contents = fs.readFileSync(podfile, 'utf8');
        const line = `pod '${IOS_POD}', :path => './${IOS_POD}'`;
        if (!contents.includes(line)) {
          contents = contents.replace(/(use_expo_modules!\s*\n)/, (m) => `${m}  ${line}\n`);
          if (!contents.includes(line)) {
            console.warn(`[withVaultShield] could not auto-add the pod — add \`${line}\` to your Podfile target manually`);
          } else {
            fs.writeFileSync(podfile, contents);
          }
        }
      }
      return cfg;
    },
  ]);
}

module.exports = function withVaultShield(config) {
  config = withKotlinSources(config);
  config = withPackageRegistration(config);
  config = withIos(config);
  return config;
};
