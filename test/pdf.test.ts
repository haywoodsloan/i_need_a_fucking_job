/**
 * End-to-end: generate a real PDF, extract it with pdf.js (as the browser
 * does), parse it, and check positions + verbatim integrity.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildPdfSource, type RawPdfPage } from '../src/resume/extract';
import { checkIntegrity, sourceCoverage } from '../src/resume/model';
import { parseResume } from '../src/resume/parse';

async function makePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([612, 792]);
  let y = 750;
  const line = (t: string, x = 50, f = font, size = 10) => {
    page.drawText(t, { x, y, size, font: f });
    y -= size + 4;
  };
  line('Sam Okafor', 50, bold, 16);
  // Header split into columns with wide gaps.
  page.drawText('sam.okafor@example.com', { x: 50, y, size: 10, font });
  page.drawText('312-555-0199', { x: 260, y, size: 10, font });
  page.drawText('Chicago, IL', { x: 420, y, size: 10, font });
  y -= 24;
  line('EXPERIENCE', 50, bold, 12);
  page.drawText('Data Analyst, Northwind Traders', { x: 50, y, size: 10, font: bold });
  page.drawText('Mar 2020 – Present', { x: 460, y, size: 10, font });
  y -= 14;
  line('•', 58);
  y += 14;
  line('Built weekly revenue dashboards in Looker, used by 40 regional managers to plan inventory,', 70);
  line('staffing and promotions.', 70);
  line('•', 58);
  y += 14;
  line('Automated the vendor reconciliation report, saving 6 hours a week.', 70);
  y -= 10;
  line('EDUCATION', 50, bold, 12);
  line('DePaul University', 50, bold);
  line('Bachelor of Science in Statistics, 2019');
  y -= 10;
  line('SKILLS', 50, bold, 12);
  line('SQL, Python (pandas), Looker, Excel');
  return pdf.save();
}

async function extract(bytes: Uint8Array): Promise<RawPdfPage[]> {
  const doc = await getDocument({ data: bytes, useSystemFonts: true }).promise;
  const pages: RawPdfPage[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    pages.push({
      width: vp.width,
      height: vp.height,
      items: tc.items.filter((i) => 'str' in i).map((i) => i as { str: string; transform: number[]; width: number; height: number }),
    });
  }
  return pages;
}

describe('PDF extraction + parsing', () => {
  it('rebuilds lines, joins wrapped bullets, and stays verbatim', async () => {
    const src = buildPdfSource(await extract(await makePdf()), { fileName: 'r.pdf', mimeType: 'application/pdf', sha256: 'x' });
    const r = parseResume(src);

    expect(r.contact.name?.value).toBe('Sam Okafor');
    expect(r.contact.email?.value).toBe('sam.okafor@example.com');
    expect(r.contact.phone?.value).toBe('312-555-0199');
    expect(r.contact.location?.value).toBe('Chicago, IL');

    expect(r.experience).toHaveLength(1);
    const e = r.experience[0];
    expect(e.title?.value).toBe('Data Analyst');
    expect(e.company?.value).toBe('Northwind Traders');
    expect(e.dates).toMatchObject({ value: 'Mar 2020 – Present', current: true, start: { year: 2020, month: 3 } });
    expect(e.bullets.map((b) => b.value)).toEqual([
      'Built weekly revenue dashboards in Looker, used by 40 regional managers to plan inventory, staffing and promotions.',
      'Automated the vendor reconciliation report, saving 6 hours a week.',
    ]);
    // A wrapped bullet keeps one span per visual line.
    expect(e.bullets[0].spans).toHaveLength(2);

    expect(r.education[0]).toMatchObject({
      institution: { value: 'DePaul University' },
      degree: { value: 'Bachelor of Science' },
      fieldOfStudy: { value: 'Statistics' },
      dates: { value: '2019' },
    });
    expect(r.skills[0].items.map((i) => i.value)).toEqual(['SQL', 'Python (pandas)', 'Looker', 'Excel']);

    expect(checkIntegrity(r)).toEqual([]);
    expect(sourceCoverage(r)).toBeGreaterThan(0.97);

    // Every positioned run lies inside its page.
    for (const it of src.items!) {
      expect(it.box.x).toBeGreaterThanOrEqual(0);
      expect(it.box.y).toBeGreaterThanOrEqual(0);
      expect(it.box.x + it.box.w).toBeLessThanOrEqual(612);
    }
  });
});
