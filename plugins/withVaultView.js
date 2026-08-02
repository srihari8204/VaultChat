/**
 * withVaultView — Expo config plugin for VaultView protected media.
 *
 * Android:
 *  - copies plugins/android/VaultView*.kt + VaultMediaModule.kt into the app
 *    package (com.vaultchat.app.vaultview)
 *  - registers VaultViewPackage in MainApplication
 *
 * iOS:
 *  - copies plugins/vaultview-ios → ios/VaultView (Swift + ObjC bridge +
 *    podspec) and adds `pod 'VaultView', :path => './VaultView'` to the Podfile
 *
 * Both platforms are optional at runtime: lib/screenGuard.ts and
 * lib/trackingId.ts degrade to a documented "unavailable" state when the native
 * module is missing (Expo Go, or a build made before this plugin landed), and
 * the UI tells the user which protections are actually active rather than
 * claiming all of them.
 *
 * Run: expo prebuild --clean
 */
const { withDangerousMod, withMainApplication } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const PKG = 'com.vaultchat.app';
const VV_PKG = `${PKG}.vaultview`;
const KOTLIN = ['VaultViewModule.kt', 'VaultMediaModule.kt', 'VaultViewPackage.kt'];
const IOS_TEMPLATE = 'vaultview-ios';
const IOS_POD = 'VaultView';

function withKotlinSources(config) {
  return withDangerousMod(config, [
    'android',
    (cfg) => {
      const srcDir = path.join(cfg.modRequest.projectRoot, 'plugins', 'android');
      const destDir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app', 'src', 'main', 'java', ...VV_PKG.split('.'),
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
    if (src.includes(`${VV_PKG}.VaultViewPackage()`)) return cfg;   // already registered
    const add = `add(${VV_PKG}.VaultViewPackage())`;

    if (src.includes('// add(MyReactNativePackage())')) {
      src = src.replace('// add(MyReactNativePackage())', `// add(MyReactNativePackage())\n              ${add}`);
    } else if (src.includes('.packages.apply {')) {
      src = src.replace('.packages.apply {', `.packages.apply {\n              ${add}`);
    } else if (/val\s+packages\s*=\s*PackageList\(this\)\.packages/.test(src)) {
      src = src.replace(/(val\s+packages\s*=\s*PackageList\(this\)\.packages)/, `$1\n      packages.${add}`);
    } else {
      console.warn(`[withVaultView] could not auto-register VaultViewPackage — add \`packages.${add}\` to MainApplication.getPackages() manually`);
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
        console.warn(`[withVaultView] plugins/${IOS_TEMPLATE} not found — iOS VaultView SKIPPED`);
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
            console.warn(`[withVaultView] could not auto-add the pod — add \`${line}\` to your Podfile target manually`);
          } else {
            fs.writeFileSync(podfile, contents);
          }
        }
      }
      return cfg;
    },
  ]);
}

module.exports = function withVaultView(config) {
  config = withKotlinSources(config);
  config = withPackageRegistration(config);
  config = withIos(config);
  return config;
};
