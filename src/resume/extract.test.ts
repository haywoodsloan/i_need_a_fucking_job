/** Turning an uploaded file into text with positions. The text has to be exactly what the file says. */
import { describe, expect, it } from 'vitest';
import { buildPdfSource, buildTextSource, docxHtmlToText, sha256Hex, type RawPdfItem } from './extract';

const meta = { fileName: 'r.txt', mimeType: 'text/plain', kind: 'text' as const, sha256: 'x' };

describe('a plain-text resume', () => {
  it('keeps the words and only evens out line ends and odd spaces', () => {
    const source = buildTextSource('Jordan Rivera  \r\nAustin, TX\t\rEngineer\n', meta);
    expect(source.text).toBe('Jordan Rivera\nAustin, TX\nEngineer\n');
    expect(source).toMatchObject({ fileName: 'r.txt', mimeType: 'text/plain', kind: 'text', sha256: 'x' });
    expect(Date.parse(source.importedAt)).not.toBeNaN();
  });

  it('records where every line sits in the text', () => {
    const source = buildTextSource('Name\n\nSecond line\nThird', meta);
    expect(source.lines.map((l) => source.text.slice(l.start, l.end))).toEqual(['Name', '', 'Second line', 'Third']);
    expect(source.lines).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 5 },
      { start: 6, end: 17 },
      { start: 18, end: 23 },
    ]);
  });
});

describe('the fingerprint of an uploaded file', () => {
  it('is the SHA-256 of its bytes, in hex', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc').buffer)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256Hex(new ArrayBuffer(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('a Word resume, as HTML', () => {
  const lines = (html: string) => docxHtmlToText(html).split('\n').filter(Boolean);

  it('becomes one line per paragraph, heading, list item and table row', () => {
    // The shape mammoth really gives a table: the text of each cell is in a paragraph (test/integration/docx.test.ts).
    const html = '<h1>Sam Okafor</h1><p>Chicago, IL<br/>312-555-0199</p><table><tr><td><p>Data Analyst</p></td><td><p>Mar 2020 – Present</p></td></tr></table><ol><li>First</li><li>Second</li></ol>';
    expect(lines(html)).toEqual(['Sam Okafor', 'Chicago, IL', '312-555-0199', 'Data Analyst   Mar 2020 – Present', '• First', '• Second']);
  });

  it('reads a table row as one line, with a wide gap between its cells and none for an empty cell', () => {
    expect(lines('<table><tr><td>Acme</td><td>Austin, TX</td></tr><tr><th><p><strong>Engineer</strong></p></th><td><p></p></td><td colspan="2"><p>2019 – 2021</p></td></tr></table>')).toEqual(['Acme   Austin, TX', 'Engineer   2019 – 2021']);
  });

  it('reads a table that lays out the page, with more than a line in a cell, one cell after the other', () => {
    const html = '<table><tr><td><p>Sam Okafor</p><p>Chicago, IL</p></td><td><p>EXPERIENCE</p><ul><li>Led the team</li></ul></td></tr></table>';
    expect(lines(html)).toEqual(['Sam Okafor', 'Chicago, IL', 'EXPERIENCE', '• Led the team']);
    // A table inside a cell: its own rows are still read as lines.
    expect(lines('<table><tr><td><p>Left</p><table><tr><td><p>Title</p></td><td><p>2020</p></td></tr></table></td><td><p>Right</p></td></tr></table>')).toEqual(['Left', 'Title   2020', 'Right']);
  });

  it('turns character codes back into the characters, once', () => {
    expect(docxHtmlToText('<p>R&amp;D &lt;lead&gt; &quot;A&quot; &#39;B&#39; 2019&#8211;2021 caf&#xe9;&nbsp;bar</p>')).toBe('R&D <lead> "A" \'B\' 2019–2021 café bar');
    // "&amp;lt;" is the text "&lt;", not a "<".
    expect(docxHtmlToText('<p>&amp;lt;b&amp;gt;</p>')).toBe('&lt;b&gt;');
  });

  it('drops formatting tags and leaves no more than one empty line in a row', () => {
    expect(docxHtmlToText('<p><strong>Experience</strong></p><p></p><p></p><p></p><p><em>Acme</em> <a href="https://acme.example">site</a></p>')).toBe('Experience\n\nAcme site');
  });
});

describe('a PDF resume, as positioned runs of text', () => {
  /** A run of 10pt text. Its width is 5 for each character, and y is measured up from the bottom of the page as in a PDF. */
  const run = (str: string, x: number, y: number): RawPdfItem => ({ str, transform: [10, 0, 0, 10, x, y], width: str.length * 5, height: 10 });
  const pdfMeta = { fileName: 'r.pdf', mimeType: 'application/pdf', sha256: 'x' };

  it('is read top to bottom and left to right, whatever order the runs came in', () => {
    const source = buildPdfSource([{ width: 612, height: 792, items: [run('EXPERIENCE', 50, 700), run('Okafor', 75, 750), run('Sam', 50, 750)] }], pdfMeta);
    expect(source.text).toBe('Sam Okafor\nEXPERIENCE');
    expect(source.kind).toBe('pdf');
    expect(source.pages).toEqual([{ width: 612, height: 792 }]);
  });

  it('joins runs that touch, puts a space in a small gap and a column break in a wide one', () => {
    const source = buildPdfSource(
      [{ width: 612, height: 792, items: [run('sam.okafor', 50, 700), run('@example.com', 100, 700), run('312-555-0199', 260, 700), run('Chicago,', 420, 700), run('IL', 465, 700)] }],
      pdfMeta,
    );
    expect(source.text).toBe('sam.okafor@example.com   312-555-0199   Chicago, IL');
  });

  it('keeps for every run where it is in the text and where it is on the page', () => {
    const source = buildPdfSource([{ width: 612, height: 792, items: [run('Data Analyst ', 50, 700), run('Mar 2020', 460, 700), run('   ', 50, 650)] }], pdfMeta);
    expect(source.text).toBe('Data Analyst   Mar 2020');
    expect(source.items!.map((i) => source.text.slice(i.start, i.end))).toEqual(['Data Analyst', 'Mar 2020']);
    // The top of a 10pt run sits 8 above its baseline, measured down from the top of the page.
    expect(source.items![1]).toMatchObject({ page: 0, box: { x: 460, y: 792 - 700 - 8, w: 40, h: 10 } });
    expect(source.lines).toEqual([{ start: 0, end: 23, page: 0, box: { x: 50, y: 84, w: 450, h: 10 } }]);
  });

  it('puts an empty line between pages and says which page each line is on', () => {
    const source = buildPdfSource(
      [
        { width: 612, height: 792, items: [run('Page one', 50, 700)] },
        { width: 612, height: 792, items: [run('Page two', 50, 700)] },
      ],
      pdfMeta,
    );
    expect(source.text).toBe('Page one\n\nPage two');
    expect(source.lines.map((l) => [source.text.slice(l.start, l.end), l.page])).toEqual([
      ['Page one', 0],
      ['', 1],
      ['Page two', 1],
    ]);
  });

  it('keeps a line that begins with an empty run, then a wide gap, apart from the line above it', () => {
    // Found by the property tests in parse.property.test.ts: the gap used to be trimmed back into the line above.
    const source = buildPdfSource([{ width: 612, height: 792, items: [run('Summary', 50, 760), run(' ', 0, 634), run('• Led the team', 40, 634)] }], pdfMeta);
    expect(source.text).toBe('Summary\n • Led the team');
    expect(source.lines.map((l) => source.text.slice(l.start, l.end))).toEqual(['Summary', ' • Led the team']);
    expect(source.items!.map((i) => source.text.slice(i.start, i.end))).toEqual(['Summary', '• Led the team']);
  });

  it('has no text for a PDF that is only a picture', () => {
    const source = buildPdfSource([{ width: 612, height: 792, items: [] }], pdfMeta);
    expect(source.text).toBe('');
    expect(source.lines).toEqual([]);
    expect(source.items).toEqual([]);
  });
});
