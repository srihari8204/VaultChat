/**
 * Builds real .xlsx / .docx / .pptx fixtures so the parsers are tested against
 * genuine OOXML packages rather than hand-rolled strings.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import * as XLSX from 'xlsx';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
mkdirSync(DIR, { recursive: true });

/* ---------------- xlsx (written by SheetJS, a real writer) ---------------- */
{
  const wb = XLSX.utils.book_new();
  const revenue = XLSX.utils.aoa_to_sheet([
    ['Region', 'Month', 'Revenue', 'Margin'],
    ['N. America', 'Jan 26', 412800, 0.593],
    ['N. America', 'Feb 26', 438150, 0.601],
    ['EMEA', 'Jan 26', 356900, 0.576],
    ['APAC', 'Jan 26', 248300, 0.578],
    ['Total Q1', '', 1456150, 0.587],
  ]);
  // A formula on the total cell, so formula extraction is exercised.
  revenue['C6'] = { t: 'n', v: 1456150, f: 'SUM(C2:C5)' };
  XLSX.utils.book_append_sheet(wb, revenue, 'Revenue');

  const notes = XLSX.utils.aoa_to_sheet([['internal only'], ['do not share']]);
  XLSX.utils.book_append_sheet(wb, notes, 'Scratch');
  // Mark the second sheet hidden to exercise hidden-sheet detection.
  wb.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 1 }] };

  const b64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
  writeFileSync(join(DIR, 'sample.xlsx.b64'), b64);
}

/* ---------------- docx ---------------- */
{
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Market Opportunity</w:t></w:r></w:p>
<w:p><w:r><w:t>Enterprise teams exchange </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>more than 60%</w:t></w:r><w:r><w:t> of documents inside chat.</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Phases replace the launch day</w:t></w:r></w:p>
<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>Segment</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>TAM</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>Regulated</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2.1B</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
<w:p><w:r><w:t>Security review now precedes tooling selection.</w:t></w:r></w:p>
</w:body></w:document>`;

  const zip = zipSync({
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`
    ),
    'word/document.xml': strToU8(documentXml),
  });
  writeFileSync(join(DIR, 'sample.docx.b64'), Buffer.from(zip).toString('base64'));
}

/* ---------------- pptx ---------------- */
{
  const slide = (title, body) => `<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
<p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr>
<p:txBody><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`;

  const notes = `<?xml version="1.0"?>
<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
         xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Open with the pilot numbers.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;

  const zip = zipSync({
    '[Content_Types].xml': strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`),
    'ppt/slides/slide1.xml': strToU8(slide('Atlas changes how teams ship', 'Six pilot teams, one quarter.')),
    'ppt/slides/slide2.xml': strToU8(slide('Rollout', 'Three phases, one owner each.')),
    'ppt/notesSlides/notesSlide1.xml': strToU8(notes),
  });
  writeFileSync(join(DIR, 'sample.pptx.b64'), Buffer.from(zip).toString('base64'));
}

console.log('fixtures written to', DIR);
