/**
 * withVaultPdf — Expo config plugin for the native PDF renderer.
 *
 * Copies the Kotlin sources from plugins/android into com.vaultchat.app.vaultpdf
 * and registers VaultPdfPackage in MainApplication.getPackages().
 *
 * WHY THERE IS A NATIVE RENDERER AT ALL
 * -------------------------------------
 * PDFs were rendered by pdf.js in a WebView loaded over file://. pdf.js needs a
 * Web Worker, Chrome will not start a Worker from a file:// origin, and pdf.js
 * responds to that by silently falling back to its "fake worker" — the same
 * parsing and rasterising, on the MAIN THREAD. Every PDF therefore blocked the
 * UI; a large one blocked it until Android killed the app. Confirmed on device
 * as data_app_anr with libwebviewchromium.so on the stuck main thread, and it
 * predates the pdf.js 3->4 upgrade.
 *
 * android.graphics.pdf.PdfRenderer is the platform's own pdfium (API 21+). React
 * Native runs @ReactMethod calls on its native executor, so rendering is off the
 * UI thread by construction rather than by hoping a Worker starts.
 *
 * No new permission, no new dependency, no manifest entry: PdfRenderer is part
 * of the framework and this module only reads files the app already owns.
 *
 * Run: expo prebuild --clean   (the plugin runs during prebuild)
 */
const { withDangerousMod, withMainApplication } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const PKG = 'com.vaultchat.app';
const PDF_PKG = `${PKG}.vaultpdf`;
const KOTLIN = ['VaultPdfModule.kt', 'VaultPdfPackage.kt'];

function withKotlinSources(config) {
  return withDangerousMod(config, [
    'android',
    (cfg) => {
      const srcDir = path.join(cfg.modRequest.projectRoot, 'plugins', 'android');
      const destDir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app', 'src', 'main', 'java', ...PDF_PKG.split('.'),
      );
      fs.mkdirSync(destDir, { recursive: true });
      for (const f of KOTLIN) {
        const from = path.join(srcDir, f);
        // Loud, not silent: a missing source here means PDFs fall back to the
        // text reader on every device, and that would look like a content bug
        // rather than a missing build step.
        if (!fs.existsSync(from)) {
          throw new Error(`withVaultPdf: missing ${from}`);
        }
        fs.copyFileSync(from, path.join(destDir, f));
      }
      return cfg;
    },
  ]);
}

function withPackageRegistration(config) {
  return withMainApplication(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (src.includes(`${PDF_PKG}.VaultPdfPackage()`)) return cfg; // idempotent
    const add = `add(${PDF_PKG}.VaultPdfPackage())`;

    // Same insertion points as withVaultChatCalls / withVaultBeamStream — the
    // `// add(MyReactNativePackage())` marker survives each plugin's edit, so
    // the order these run in does not matter.
    if (src.includes('// add(MyReactNativePackage())')) {
      src = src.replace('// add(MyReactNativePackage())', `// add(MyReactNativePackage())\n              ${add}`);
    } else if (src.includes('.packages.apply {')) {
      src = src.replace('.packages.apply {', `.packages.apply {\n              ${add}`);
    } else if (/val\s+packages\s*=\s*PackageList\(this\)\.packages/.test(src)) {
      src = src.replace(/(val\s+packages\s*=\s*PackageList\(this\)\.packages)/, `$1\n      packages.${add}`);
    } else {
      console.warn(`[withVaultPdf] could not auto-register VaultPdfPackage — add \`packages.${add}\` to MainApplication.getPackages() manually`);
    }
    cfg.modResults.contents = src;
    return cfg;
  });
}

module.exports = function withVaultPdf(config) {
  return withPackageRegistration(withKotlinSources(config));
};
