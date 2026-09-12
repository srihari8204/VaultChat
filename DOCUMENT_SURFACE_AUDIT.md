# Document surface audit — VaultChat

Date: 2026-09-12. Branch: `hetzner-deploy`.
Method: source inspection of every entry point, plus `tsc --noEmit`, `eslint`,
and `npm test` (160 selftest suites / 237 checks). **No device was connected**
(`adb devices` empty), so nothing here is device-verified — see §5.

Status vocabulary: **FIXED** (changed in this pass) · **ALREADY CORRECT** ·
**GAP** (verified defect, not fixed) · **NOT VERIFIED**.

---

## 1. Root causes

| # | Observed | Verified cause | Fix |
|---|---|---|---|
| R1 | Files tab opens nothing, or a browser 401 | `app/media-gallery.tsx` `openFile` called `Linking.openURL(r.uri)`. Plaintext → the `/uploads` **https URL handed to the system browser**, which holds no bearer token; the auth headers resolved one line earlier were dropped. Encrypted → a `file://` path handed to another app, which Android refuses (`FileUriExposedException`). Broken in **both** branches, and it took an attachment URL out of the app. | **FIXED** — shared resolver + in-app viewer |
| R2 | Sender re-downloads their own document; encrypted file opens as garbage | `app/media-viewer.tsx` called `getMedia` with `kind: msgType === 'video' ? 'video' : 'image'` for **every** non-video attachment, and passed no `encrypted`. Wrong kind → a PDF stored as `VaultChat Images/IMG-<id>.pdf`, so the sender's `Sent/` lookup missed and the file was fetched back from the server. Missing `encrypted` → `getMedia` cannot raise `MediaKeyMissingError` and instead writes raw **ciphertext** into a file named `.pdf` (audit F-8, re-entering via the Shelf). | **FIXED** |
| R3 | In-app preview fails on a remote document while "open in another app" works | `app/file-viewer.tsx` called `FileSystem.downloadAsync` with **no Authorization header** in the two in-app loaders and in `handleShare`. `GET /uploads/{id}` is `RequireAuth` (`vaultchat-backend-go/internal/routes/uploads.go:147`), so those paths wrote the 401 JSON body to disk and parsed it — reported to the user as "this file is not a readable document". Only `openInDeviceApp` sent the token, which is exactly why the hand-off worked and reading in-app did not. | **FIXED** |
| R4 | A shopkeeper cannot read the bill they just issued | All four Shop Book PDF sites went straight from `Print.printToFileAsync` to `Sharing.shareAsync`. The OS share sheet was the **only** thing that ever displayed a Shop Book document, and where `isAvailableAsync()` is false the document went nowhere at all. | **FIXED** (3 of 4) |
| R5 | A malicious PDF can read the device's media keys | Vendored **pdfjs-dist 3.11.174** (`assets/pdfjs/README.md`), unpatched for **CVE-2024-4367** (`grep "Invalid fontMatrix"` → 0 hits; fixed upstream in 4.2.67), `isEvalSupported` defaulting **true**, rendered inside a WebView opened with `allowUniversalAccessFromFileURLs` (`components/PdfView.tsx`). A crafted `fontMatrix` reaches `new Function(...)` → arbitrary JS in the `file://` origin → can read the AsyncStorage DB holding every `vc_mk_<id>` media key and POST it out. One received PDF, opened normally. | **MITIGATED** (§4) |
| R6 | A large `.docx` kills the app | The `MAX_DOC_BYTES` (32 MB) guard is checked **inside** `extractDocText`, i.e. *after* `readDoc` has already materialised the file ~3× (base64 string + Buffer + Uint8Array). The guard could never fire; a 400 MB document OOMs first. The plain-text path already probed `getInfoAsync`; the document path did not. | **FIXED** |
| R7 | `.tsv` / `.conf` route to a viewer that shows the hand-off card | `lib/docOpen.ts`'s `DOCUMENT` list included them; `file-viewer`'s `EXT_MAP` did not, so `detectType` returned `unknown`. **Introduced by this pass**, caught by the renderer audit. | **FIXED** |
| R8 | CRLF files show a stray character per line | `textContent.split` on a bare newline left a trailing CR on every line of a Windows `.csv`/`.log`, shifting the last column and corrupting copy-paste; a UTF-8 BOM printed as a stray glyph before line 1. | **FIXED** |

---

## 2. Coverage matrix

`In-app?` = does a tap reach a VaultChat renderer, rather than the OS.

| Surface | Route / component | Handler | Source | Roles | Current behaviour | In-app? | Status |
|---|---|---|---|---|---|---|---|
| 1:1 & group chat bubble | `components/chat/MessageBubble.tsx:512` | `onOpen` | attachmentId | chat participant | `getMedia`(kind file, isMine, encrypted) → `copyToCache` → `/file-viewer` | Yes | ALREADY CORRECT — now uses shared `viewerRouteFor` |
| Shared media → Files tab | `app/media-gallery.tsx:226` | `openFile` | attachmentId | chat participant | resolver → `/file-viewer`; hand-off only for types nothing renders | Yes | **FIXED (R1)** |
| Bookshelf | `app/shelf.tsx:97` → `app/media-viewer.tsx` | `open` | attachmentId | any | correct media kind; documents `router.replace` to `/file-viewer` | Yes | **FIXED (R2)** |
| Universal viewer | `app/file-viewer.tsx` | — | uri | any | PDF pages (pdf.js), Office structure, text | Yes | **FIXED (R3, R6, R7, R8)** |
| Archive browser | `app/archive-viewer.tsx:120` | entry tap | local file | any | extracts one entry → `/file-viewer` | Yes | ALREADY CORRECT |
| Shop Book — order receipt | `app/shop-book.tsx` `bill` | `previewDoc` | generated PDF | owner/staff | in-app preview; Share still in the viewer header | Yes | **FIXED (R4)** |
| Shop Book — khata bill/receipt | `app/shop-book.tsx` `shareDoc` | `previewDoc` | generated PDF | owner/staff | as above | Yes | **FIXED (R4)** |
| Shop Book — tax invoice | `app/shop-book.tsx` `sharePdf` | `previewDoc` | generated PDF | owner/staff/customer | as above | Yes | **FIXED (R4)** |
| Shop Book — counter sale | `app/shop-book.tsx` | share sheet | generated PDF | owner/staff | unchanged — `onDone()` closes the panel on the next line and would race a push | No | GAP-1 (`ponytail:` comment in place; bill re-openable from the khata list) |
| Forward / reply / quoted doc | `app/chat.tsx:1880` | `doForward` | attachmentId | chat participant | renders through the same FileBubble; no separate open path | Yes | ALREADY CORRECT |
| Composer draft (file) | `app/chat.tsx:2249` | `onPickFile` | local file | chat participant | sends immediately — no preview/confirm stage | n/a | GAP-2 |
| Encrypted Notes attachment | `app/encrypted-notes.tsx:333` | `openAttachmentFile` | encrypted blob | notes PIN holder | decrypt → cache → `Sharing.shareAsync` | **No** | GAP-3 |
| Vault → open file | `app/vault.tsx:308` | `handleOpen` | encrypted `.enc` | vault PIN holder | decrypt → cache → share sheet; `Alert` fallback leaks the temp path | **No** | GAP-4 |
| Doc scanner — recent / preview | `app/docscanner.tsx:324,411` | `sharePdf` | generated PDF | any | share sheet only | **No** | GAP-5 |
| Camera SCAN → attach | `app/camera.tsx:240` | `attachScan` | generated PDF | chat participant | sent; recipient uses FileBubble | n/a | ALREADY CORRECT |
| Finance exports (6 screens) | `utils/financeIO.ts:13,78` | `sharePdf`/`shareTextFile` | generated PDF/XLS/CSV | any | share sheet only | **No** | GAP-6 |
| VaultCheck | `app/vaultcheck.tsx:34` | `getMedia` | attachmentId | chat participant | `kind` forced to image/video, `encrypted` not passed | n/a | GAP-7 (same class as R2) |
| VaultBeam bubble "Open" | `lib/vaultBeam/openFile.ts:150` | `openLocalFile` | local 12 GB file | chat participant | Android VIEW intent, deliberately (its selftest forbids `shareAsync`) | No, by design | GAP-8 |
| Chat export (txt/json/html) | `app/chat-export.tsx:84` | `shareFile` | generated file | chat participant | share sheet | No | GAP-9 |
| Bookmarks / Scheduled | `app/bookmarks.tsx:183` | — | — | any | static file label; document not openable from the list | No | GAP-10 |
| Search / in-chat search / requests | — | — | — | — | no attachment surface at all (verified: zero matches) | n/a | none needed |
| Group & space screens | — | — | — | — | no attachment support (verified: zero matches) | n/a | none needed |
| Notifications / deep links | `lib/push.ts`, `app/_layout.tsx` | — | — | — | **no** notification or deep link opens an attachment | n/a | none needed |
| `app/scanner.tsx`, `app/vaultdrop.tsx` | — | — | — | — | non-functional mocks (`setTimeout` + `Alert`); scanner unreachable | n/a | dead code |
| `app/filevault.tsx` | — | — | — | — | redirect to `/vault` | n/a | not an entry point |

---

## 3. Renderer capability matrix

Verified by reading the parsers, not by opening files on a device.

| Format | Level | Handler | Drops |
|---|---|---|---|
| `.pdf` | **FULL VISUAL PREVIEW — Android only** | `components/PdfView.tsx` → `assets/pdfjs/viewer.html` | iOS/web fall back to text (`plugins/withPdfJs.js` registers only the Android mod) |
| `.pdf` (fallback) | SIMPLIFIED | `lib/docText.ts:336` | all vector/raster graphics; Indic scripts fail (hex `<FEFF…>` strings never matched) |
| `.docx` | SIMPLIFIED | `lib/docBlocks.ts:95` | images, charts, colours, headers/footers, footnotes, tracked changes, list numbering |
| `.xlsx` | SIMPLIFIED | `lib/docBlocks.ts:167` | **number formats and dates** (a date cell renders as `45678`), formulas, merged cells, charts |
| `.pptx` | SIMPLIFIED | `lib/docBlocks.ts:199` | layout, images, tables, SmartArt, notes, animations |
| `.doc` / `.xls` / `.ppt` | **UNSUPPORTED** | `lib/docText.ts:33` → hand-off card | everything (legacy binary formats; no parser) |
| `.txt` `.log` `.md` `.json` `.xml` | SIMPLIFIED (raw text) | `file-viewer` `renderText` | no markdown render, no pretty-print; syntax highlighting declared but unused |
| `.csv` / `.tsv` | SIMPLIFIED (raw text, **not a grid**) | `renderText` | no delimiter parsing in the viewer. A correct quoted-field CSV parser exists at `app/finance/io.tsx:167` but is not reachable from it |
| `.rtf` `.odt` `.ods` `.odp` | UNSUPPORTED | hand-off | — |

Good news the audit confirmed: **no numeric corruption.** XLSX and CSV cell text
reaches the screen as the raw string — the only `Number()` calls are on the
shared-string index and the column letter — so `007` and 16-digit identifiers
survive intact. Cells render through React Native `<Text>`, which cannot
interpret a formula, so there is no CSV-injection surface in the viewer.

---

## 4. Security findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| S1 | **Critical** | CVE-2024-4367 in vendored pdf.js 3.11.174 combined with `allowUniversalAccessFromFileURLs` → one malicious PDF reads every media key (see R5) | **MITIGATED** — `isEvalSupported: false` added to `assets/pdfjs/viewer.html` and `assets/pdfjs/thumb.html`. This is the documented CVE mitigation, **not** the real fix: the bundle still needs upgrading, and the WebView's universal-file-access flags should be dropped in favour of copying the PDF next to the viewer. |
| S2 | High | Every opened document is copied to the app cache as plaintext under its original filename and **never cleaned up**: `lib/mediaCacheGC.ts` sweeps only `dec_`/`enc_`/`mp_`/`vo_`/`vv_` prefixes, `lib/storageRoots.ts` deliberately excludes the cache dir from `purgeUserContent()`, and `purgeLocalCopies` (revoke) does not scan it. A revoked or view-once document, and every document of a signed-out account, survives on disk. | **NOT FIXED** — needs a prefix convention plus three call-site additions; touches the logout path, so out of scope for this pass. |
| S3 | High | View-once is client-enforced: `uploadsGet` never writes `viewed_at`; only the recipient's voluntary `POST /uploads/{id}/viewed` does. A held bearer token re-fetches indefinitely. | **NOT FIXED** — backend change, and production deploys need separate authorization. |
| S4 | Medium | Download authorization joins on client-supplied `meta.attachmentId`, and the send path never checks that the sender may reference that attachment — so an ex-group-member who knows an attachment UUID can re-grant themselves access by posting it into a self-chat. `stories.go:392` enforces the ownership check `chats_helpers.go` omits. | **NOT FIXED** — backend change; fix is to reuse `uploadsIsRecipient`. |
| S5 | Low | `console.warn` survives release builds (only `console.log` is stripped), so four `file-viewer` warns put **filenames** into logcat. | **NOT FIXED** — one `__DEV__` guard each. |
| S6 | — | Shop Book document authorization is **correct**: `sbLoadInvoice` resolves the shop owner and rejects unless the caller is that owner or the named customer; both the JSON and render routes go through it. Shop A cannot read shop B; a customer cannot read another customer's invoice. | ALREADY CORRECT |

---

## 5. Verification status

| Level | What was actually done |
|---|---|
| BUILD-VERIFIED | `npx tsc --noEmit` → **0 errors** (clean before and after) |
| BUILD-VERIFIED | `npx eslint` on all 9 changed files → **0 errors**, 19 warnings, all pre-existing |
| SOURCE + TEST VERIFIED | `npm test` → **160 suites, 237/237 checks passed** |
| SOURCE + TEST VERIFIED | New `lib/docOpen.selftest.ts` → 28 assertions covering extension parsing (unicode names, dotted names, no extension), routing per format, extension-beats-mime, and mime-only fallback |
| SOURCE-VERIFIED | Every root cause R1–R8 and every matrix row above |
| **NOT VERIFIED** | **All 28 device scenarios.** `adb devices` returned no devices and no emulator is configured here. Not executed: sender preview before/during/after send, receiver download+open, restart persistence, offline, group/forward paths, Shop Book owner↔customer, cross-account isolation, password-protected and corrupt fixtures, large-file and low-storage, orientation, account switching. |
| **NOT VERIFIED** | iOS and web entirely — no build attempted; `PdfView` is Android-only by construction |
| **NOT VERIFIED** | Migration suite skipped — Docker daemon not running (pre-existing, unrelated) |
| **NOT VERIFIED** | Whether pdfjs 3.11.174 carries advisories beyond CVE-2024-4367 |

---

## 6. Rollback

Every change is additive or a single-expression substitution, across 9 files,
with no schema change, no dependency added, and no protocol touched.

```
git revert <commit>          # the whole upgrade
```

Per-file, if only one surface misbehaves: `lib/docOpen.ts` and
`lib/docOpen.selftest.ts` are new — deleting them and reverting the three import
sites restores the previous per-screen routing. For `assets/pdfjs/*.html`,
removing `isEvalSupported: false` restores the old (vulnerable) behaviour; do not
do that without upgrading the bundle first.

No data migration, so no data is at risk either way.
