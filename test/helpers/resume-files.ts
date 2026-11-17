/**
 * Real resume files, made on the spot: a PDF and a Word document that say the same thing. Tests feed them to the
 * same readers the app uses (pdf.js and mammoth), so what those libraries really produce is what gets tested.
 *
 * They are built in code so that the test shows exactly what is in the file, and so no binary file has to be
 * kept in the repository.
 */
import { crc32 } from 'node:zlib';
import { PDFDocument, StandardFonts } from 'pdf-lib';

/** What both files say, for tests to compare against. */
export const RESUME = {
  name: 'Sam Okafor',
  email: 'sam.okafor@example.com',
  phone: '312-555-0199',
  location: 'Chicago, IL',
  title: 'Data Analyst',
  company: 'Northwind Traders',
  dates: 'Mar 2020 – Present',
  bullets: [
    'Built weekly revenue dashboards in Looker, used by 40 regional managers to plan inventory, staffing and promotions.',
    'Automated the vendor reconciliation report, saving 6 hours a week.',
  ],
  school: 'DePaul University',
  degree: 'Bachelor of Science in Statistics, 2019',
  skills: ['SQL', 'Python (pandas)', 'Looker', 'Excel'],
};

/** One US Letter page: a header in three columns, a job with a wrapped bullet, education and skills. */
export async function resumePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([612, 792]);
  let y = 750;
  const line = (t: string, x = 50, f = font, size = 10) => {
    page.drawText(t, { x, y, size, font: f });
    y -= size + 4;
  };
  line(RESUME.name, 50, bold, 16);
  // Header split into columns with wide gaps.
  page.drawText(RESUME.email, { x: 50, y, size: 10, font });
  page.drawText(RESUME.phone, { x: 260, y, size: 10, font });
  page.drawText(RESUME.location, { x: 420, y, size: 10, font });
  y -= 24;
  line('EXPERIENCE', 50, bold, 12);
  page.drawText(`${RESUME.title}, ${RESUME.company}`, { x: 50, y, size: 10, font: bold });
  page.drawText(RESUME.dates, { x: 460, y, size: 10, font });
  y -= 14;
  line('•', 58);
  y += 14;
  // The first bullet is wrapped over two lines, as a real resume's would be.
  line('Built weekly revenue dashboards in Looker, used by 40 regional managers to plan inventory,', 70);
  line('staffing and promotions.', 70);
  line('•', 58);
  y += 14;
  line(RESUME.bullets[1], 70);
  y -= 10;
  line('EDUCATION', 50, bold, 12);
  line(RESUME.school, 50, bold);
  line(RESUME.degree);
  y -= 10;
  line('SKILLS', 50, bold, 12);
  line(RESUME.skills.join(', '));
  return pdf.save();
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

const run = (text: string, bold = false) => `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
const paragraph = (text: string, o: { style?: string; bullet?: boolean; bold?: boolean } = {}) =>
  `<w:p><w:pPr>${o.style ? `<w:pStyle w:val="${o.style}"/>` : ''}${o.bullet ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : ''}</w:pPr>${run(text, o.bold)}</w:p>`;
const row = (...cells: string[]) => `<w:tbl><w:tr>${cells.map((c) => `<w:tc>${paragraph(c)}</w:tc>`).join('')}</w:tr></w:tbl>`;

/**
 * The same resume as a Word file, laid out the way Word users lay one out: a heading for the name, tables to put
 * dates at the right-hand edge, section headings, and a real bulleted list.
 */
export function resumeDocx(): Uint8Array {
  const body = [
    paragraph(RESUME.name, { style: 'Heading1' }),
    row(RESUME.email, RESUME.phone, RESUME.location),
    paragraph('EXPERIENCE', { style: 'Heading2' }),
    row(`${RESUME.title}, ${RESUME.company}`, RESUME.dates),
    ...RESUME.bullets.map((b) => paragraph(b, { bullet: true })),
    paragraph('EDUCATION', { style: 'Heading2' }),
    paragraph(RESUME.school, { bold: true }),
    paragraph(RESUME.degree),
    paragraph('SKILLS', { style: 'Heading2' }),
    paragraph(RESUME.skills.join(', ')),
  ].join('');
  const style = (id: string, name: string) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/></w:style>`;
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  return zip({
    '[Content_Types].xml':
      `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>',
    '_rels/.rels': `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/_rels/document.xml.rels':
      `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${rel}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${rel}/numbering" Target="numbering.xml"/></Relationships>`,
    'word/document.xml': `${head}<w:document ${W}><w:body>${body}</w:body></w:document>`,
    // Word names its heading styles in lower case.
    'word/styles.xml': `${head}<w:styles ${W}>${style('Heading1', 'heading 1')}${style('Heading2', 'heading 2')}</w:styles>`,
    'word/numbering.xml':
      `${head}<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum>` +
      '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>',
  });
}

/** A ZIP archive of text files, stored without compression. A .docx is one. */
function zip(files: Record<string, string>): Uint8Array {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const path = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    // Shared by the file's own header and its directory entry: version, flags (UTF-8 names), no compression,
    // time, date, checksum, size stored, size, name length, extra length.
    const common = Buffer.alloc(26);
    common.writeUInt16LE(20, 0);
    common.writeUInt16LE(0x0800, 2);
    common.writeUInt16LE(0, 4);
    common.writeUInt16LE(0, 6);
    common.writeUInt16LE(0x21, 8); // 1 January 1980, the earliest date a ZIP can hold
    common.writeUInt32LE(crc32(data), 10);
    common.writeUInt32LE(data.length, 14);
    common.writeUInt32LE(data.length, 18);
    common.writeUInt16LE(path.length, 22);
    common.writeUInt16LE(0, 24);
    const local = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), common, path, data]);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    common.copy(entry, 6);
    entry.writeUInt32LE(offset, 42);
    parts.push(local);
    directory.push(Buffer.concat([entry, path]));
    offset += local.length;
  }
  const dir = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(directory.length, 8);
  end.writeUInt16LE(directory.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, dir, end]));
}
