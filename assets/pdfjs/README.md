# Vendored pdf.js

`pdf.min.pdfjs` and `pdf.worker.min.pdfjs` are pdfjs-dist **3.11.174**, the
`legacy/build` UMD files, renamed so Metro treats them as assets rather than as
source (see `assetExts` in metro.config.js).

Why this version and this build:

* **UMD, not ESM.** pdf.js 4+ ships only `.mjs`. A WebView loading
  `<script type="module">` from a `file://` origin is blocked by CORS, so the
  ESM builds silently fail to load. The v3 legacy build is a classic script and
  exposes a `pdfjsLib` global.
* **Vendored, not a dependency.** `npm install pdfjs-dist` fails on this repo's
  pre-existing `@any-routing` peer conflict and would re-resolve the whole
  lockfile. Nothing imports pdfjs-dist at runtime — only these two files are
  used — so the files are committed instead.

Apache-2.0, Mozilla Foundation. The license header is intact at the top of each
file; keep it there.

To update: `npm pack pdfjs-dist@<version>`, extract `package/legacy/build/`,
copy the two files here under the same names, and re-check that the build is
still UMD (`grep -c '^export ' pdf.min.pdfjs` must be 0).
