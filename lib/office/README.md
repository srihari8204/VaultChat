# On-device Office rendering

Excel, Word and PowerPoint files are parsed and drawn **on the device**. Nothing is
uploaded.

This replaced an implementation that built a `docs.google.com/gview?url=…` link and
loaded it in a WebView. That could never work here: Google's servers have to fetch the
URL themselves, but VaultChat's files are local or vault-protected — and routing them
through Google would mean vault contents leaving the device, which the product promises
never happens.

## Layout

| File | Role |
|---|---|
| `types.ts` | Plain data shapes shared by the parsers and the renderers |
| `ooxml.ts` | Unzip + XML helpers (a .docx/.pptx is a ZIP of XML parts) |
| `xlsx.ts` | Workbook → sheets, cells, formulas, frozen panes, hidden sheets |
| `docx.ts` | Document → ordered blocks: headings, paragraphs, lists, tables |
| `pptx.ts` | Deck → slides with title, body, speaker notes, media flag |

The parsers are pure: they take base64 and return data, touching no React Native APIs.
That is what makes them testable in Node.

Renderers live in `components/office/` (`SpreadsheetView`, `DocumentView`, `DeckView`)
and are selected by `app/file-viewer.tsx`.

## Tests

```bash
node lib/office/__tests__/make-fixtures.mjs   # writes real .xlsx/.docx/.pptx fixtures
npx tsc lib/office/*.ts --outDir lib/office/dist-test --module esnext \
  --target es2020 --moduleResolution bundler --skipLibCheck
node lib/office/__tests__/parsers.test.mjs
```

23 assertions cover cell types and formulas, hidden sheets, document block order,
run formatting, table extraction, slide titles/notes, and clean failure on a
non-Office file.

## Known gaps

- Embedded images inside .docx/.pptx are not drawn yet (text, tables and structure are).
- Charts inside workbooks are not rendered; the underlying cells are.
- Legacy binary `.doc`/`.xls`/`.ppt` (pre-2007) are not covered — only the OOXML formats.
