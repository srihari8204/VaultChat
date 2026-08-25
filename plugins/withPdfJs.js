// plugins/withPdfJs.js — put pdf.js where a WebView can actually load it.
//
// WHY NOT A METRO ASSET
// ---------------------
// The obvious route — add `pdfjs` to metro's assetExts and `require()` the files
// — builds and packages fine, and then fails on device with:
//
//     ExpoAsset.downloadAsync … Unable to download asset from url:      (empty)
//
// Metro puts non-image assets under `res/` (they arrived as `res/hz.pdfjs`), and
// expo-asset resolves embedded assets to `file:///android_res/<type>/<name>`.
// There is no resource type for `.pdfjs`, so the URL comes back empty and the
// asset can never be read. Verified on device, not guessed.
//
// Android's `assets/` directory has no such constraint: anything copied there is
// readable at `file:///android_asset/...`, which is exactly what a WebView wants.
//
// All three files land in ONE directory on purpose — pdf.js starts a Web Worker,
// and a worker will not start from a different origin than the page.
//
// android/ is GITIGNORED (.gitignore line 43), so the copies under it are local
// build output, not committed files. On a machine that has already prebuilt, a
// plain `gradlew assembleRelease` works because they are still sitting there;
// on a fresh clone android/ does not exist at all. This plugin is what puts
// them back — both on the first prebuild and after `expo prebuild --clean`
// wipes the directory. assets/pdfjs/ is the committed source of truth.

const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

// source name in assets/pdfjs → name inside android/app/src/main/assets/pdfjs
const FILES = {
  'pdf.min.pdfjs': 'pdf.min.js',
  'pdf.worker.min.pdfjs': 'pdf.worker.min.js',
  'viewer.html': 'viewer.html',
  'thumb.html': 'thumb.html',
};

module.exports = function withPdfJs(config) {
  return withDangerousMod(config, [
    'android',
    (cfg) => {
      const src = path.join(cfg.modRequest.projectRoot, 'assets', 'pdfjs');
      const dest = path.join(
        cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'assets', 'pdfjs',
      );
      fs.mkdirSync(dest, { recursive: true });
      for (const [from, to] of Object.entries(FILES)) {
        const s = path.join(src, from);
        if (!fs.existsSync(s)) {
          // Loud, not silent: a missing file here means the PDF viewer ships
          // broken, and it would only show up as a fallback to the text reader.
          throw new Error(`withPdfJs: missing ${s} — see assets/pdfjs/README.md`);
        }
        fs.copyFileSync(s, path.join(dest, to));
      }
      return cfg;
    },
  ]);
};
