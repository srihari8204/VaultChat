# Vendored pdf.js

`pdf.min.pdfjs` and `pdf.worker.min.pdfjs` are **pdfjs-dist 4.10.38**, bundled
from the `legacy/build` **ESM** files into classic IIFE scripts, then renamed so
Metro treats them as assets rather than as source (see `assetExts` in
metro.config.js).

## Why this version

**3.11.174 was vulnerable.** It is unpatched for **CVE-2024-4367**: its
`FontFaceObject.getPathGenerator` builds a glyph renderer with `new Function(...)`
whenever `isEvalSupported` is on, so a crafted `fontMatrix` in an attacker's PDF
executes arbitrary JavaScript in the viewer's origin. Mozilla fixed it in 4.2.67
and never backported to the 3.x line, so no 3.x release is safe.

4.10.38 does not patch that code path — it **removes** it. `getPathGenerator` is
now `new Path2D(cmds || "")`, with no eval branch at all, which is why the fix is
structural rather than a guard that could be bypassed. Verify with:

```
grep -c 'new Path2D' pdf.min.pdfjs            # non-zero
grep -c 'isEvalSupported' pdf.min.pdfjs       # the font eval path must be gone
```

4.x rather than 5.x/6.x deliberately: this app ships to Android 11 devices whose
System WebView can be well behind Chrome stable, and the 4.x `legacy` build still
targets that range. Revisit when the minimum supported WebView moves up.

## Why bundled, not copied

pdf.js 4+ ships **only** `.mjs`. A WebView loading `<script type="module">` from
a `file://` origin is blocked by CORS, so the ESM files silently fail to load —
which is the reason the v3 UMD build was used before. esbuild resolves this: it
turns the ESM into a classic IIFE that exposes the `pdfjsLib` global, so
`viewer.html` keeps its plain `<script src>` and nothing else changes.

One post-bundle patch is applied: pdf.js 4 constructs its worker as
`new Worker(url, { type: "module" })`, and a **module** worker is also blocked
from `file://`. Without the patch pdf.js silently falls back to its main-thread
"fake worker" — pages still render, but parsing blocks the UI. The bundled
worker is a classic script, so the `{ type: "module" }` argument is dropped.

Still vendored rather than depended on: `npm install pdfjs-dist` fails on this
repo's pre-existing `@any-routing` peer conflict and would re-resolve the whole
lockfile. Nothing imports pdfjs-dist at runtime — only these two files are used.

## Rebuilding after an upgrade

```sh
npm pack pdfjs-dist@<version>
tar -xzf pdfjs-dist-<version>.tgz

npx esbuild package/legacy/build/pdf.min.mjs \
  --bundle --format=iife --global-name=pdfjsLib \
  --target=es2018 --legal-comments=inline --outfile=pdf.min.pdfjs

npx esbuild package/legacy/build/pdf.worker.min.mjs \
  --bundle --format=iife \
  --target=es2018 --legal-comments=inline --outfile=pdf.worker.min.pdfjs
```

Then, in order:

1. Replace `new Worker(x, { type: "module" })` with `new Worker(x)` in
   `pdf.min.pdfjs` (one occurrence).
2. Re-prepend the upstream `@licstart … @licend` block to **both** files —
   esbuild drops it despite `--legal-comments=inline`, and Apache-2.0 requires
   it. It is the first comment in each upstream `.mjs`.
3. Check the bundle is still a classic script: `grep -c '^export ' *.pdfjs`
   must be `0` for both.
4. Confirm the global exists: `grep -c 'var pdfjsLib' pdf.min.pdfjs` is `1`.

## Verifying what actually shipped

A version string in this file proves nothing about the running app. `viewer.html`
posts the live `pdfjsLib.version` in its `ready` message, `components/PdfView.tsx`
surfaces it through `onReady`, and it is logged in dev builds as
`[pdfjs] rendering with <version> · <n> pages`. That is the number to trust.

SHA-256 of the files committed with this README:

```
5a1e1f9e6465feebf7c2f17e4113e5030d2990ea0b6afe51c039c4cf238bab3e  pdf.min.pdfjs
56baacf0d63b56ed502e9a792769bdc160b042faff0dd2dc1ebd680a5e9e2a98  pdf.worker.min.pdfjs
```

Apache-2.0, Mozilla Foundation. The license header is intact at the top of each
file; keep it there.
