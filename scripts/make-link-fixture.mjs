// Generates e2e/fixtures/links.pdf — a two-page deck carrying one external and
// one internal link annotation.
//
// Written by hand rather than with a PDF library: the fixture's whole job is to
// contain link annotations of a known shape at known coordinates, and the specs
// assert on those coordinates. A generator with no dependencies keeps the
// fixture reproducible (`node scripts/make-link-fixture.mjs`) without pulling a
// PDF toolchain into the repo root.
//
// Page 1 carries both links, in the top half of the page:
//   - external → https://example.com/ at rect [72 700 540 740]
//   - internal → page 2            at rect [72 620 540 660]
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(__dirname, "../e2e/fixtures/links.pdf");

const page1 = `BT /F1 24 Tf 72 745 Td (Page 1 - link fixture) Tj ET
BT /F1 18 Tf 72 712 Td (External link to example.com) Tj ET
BT /F1 18 Tf 72 632 Td (Internal link to page 2) Tj ET`;

const page2 = `BT /F1 24 Tf 72 745 Td (Page 2 - jump target) Tj ET`;

const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
    "/Resources << /Font << /F1 9 0 R >> >> /Contents 4 0 R /Annots [7 0 R 8 0 R] >>",
  `<< /Length ${page1.length} >>\nstream\n${page1}\nendstream`,
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
    "/Resources << /Font << /F1 9 0 R >> >> /Contents 6 0 R >>",
  `<< /Length ${page2.length} >>\nstream\n${page2}\nendstream`,
  // Border [0 0 0] so no visible frame is drawn — the overlay under test is the
  // only affordance, exactly as in a real deck.
  "<< /Type /Annot /Subtype /Link /Rect [72 700 540 740] /Border [0 0 0] " +
    "/A << /S /URI /URI (https://example.com/) >> >>",
  "<< /Type /Annot /Subtype /Link /Rect [72 620 540 660] /Border [0 0 0] " +
    "/Dest [5 0 R /XYZ null null null] >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];

let pdf = "%PDF-1.4\n";
const offsets = [];
objects.forEach((body, i) => {
  offsets.push(pdf.length);
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});

const xrefAt = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, pdf, "latin1");
console.log(`wrote ${out} (${pdf.length} bytes, ${objects.length} objects)`);
