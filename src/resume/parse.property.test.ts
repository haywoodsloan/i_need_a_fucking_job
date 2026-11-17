/**
 * Property tests for reading a resume. The promise of this app is that a field is the exact words of the file. The
 * tests in parse.test.ts show that for one resume. These make up hundreds of resumes, tidy and broken, and hold
 * every one of them to it. When one fails, fast-check prints the smallest resume that still fails, and the seed.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildPdfSource, buildTextSource, type RawPdfPage } from './extract';
import { checkIntegrity, listFields, sourceCoverage, toApplicationProfile, type ParsedResume, type SourceDocument } from './model';
import { parseResume } from './parse';

const HEADINGS = ['EXPERIENCE', 'Experience', 'WORK HISTORY', 'Education', 'EDUCATION', 'SKILLS', 'Technical Skills', 'SUMMARY', 'Profile', 'PROJECTS', 'Certifications', 'AWARDS', 'Volunteer', 'LANGUAGES', 'Interests', 'References', 'Publications', 'Leadership'];
const WORDS = ['Senior', 'Software', 'Engineer', 'Globex', 'Corporation', 'Inc.', 'LLC', 'University', 'of', 'Texas', 'Austin', 'TX', 'B.S.', 'M.Sc.', 'in', 'Computer', 'Science', 'Python', 'Go', 'AWS', '(Lambda,', 'SQS)', 'Led', 'built', '38%', 'GPA:', '3.7/4.0', 'Remote', 'Manager', 'and', 'the', 'C++', 'C#', 'at', 'for', 'Intern', "Dean's", 'List', 'München', '東京', 'naïve', '🚀'];
const DATES = ['Jan 2021', 'January 2021', 'Sept. 2019', '05/2019', '2018', '2018-06', "May '19", 'Summer 2022', 'Present', 'Current', 'Expected May 2027'];
const SEPARATORS = [' | ', ' — ', ' – ', ' - ', ', ', '   ', '\t', ' · ', ' to ', ': ', ' / ', ' @ '];
const BULLETS = ['• ', '- ', '* ', '● ', '– ', '▪ ', '1. ', ''];
const CONTACT = ['jordan.rivera@example.com', '(512) 555-0142', '+1 512-555-0142', 'linkedin.com/in/jordanrivera', 'https://github.com/jrivera', 'Austin, TX', 'Jordan A. Rivera', 'www.example.com'];

const word = fc.constantFrom(...WORDS);
const phrase = fc.array(word, { minLength: 1, maxLength: 8 }).map((w) => w.join(' '));
const dateRange = fc.oneof(fc.constantFrom(...DATES), fc.tuple(fc.constantFrom(...DATES), fc.constantFrom(' - ', ' – ', ' to ', '–', ' — '), fc.constantFrom(...DATES)).map((p) => p.join('')));
const piece = fc.oneof({ weight: 4, arbitrary: phrase }, { weight: 2, arbitrary: dateRange }, { weight: 1, arbitrary: fc.constantFrom(...CONTACT) }, { weight: 1, arbitrary: fc.string({ unit: 'grapheme', maxLength: 12 }) });
const line = fc.oneof(
  { weight: 2, arbitrary: fc.constantFrom(...HEADINGS) },
  { weight: 2, arbitrary: fc.constant('') },
  { weight: 5, arbitrary: fc.tuple(fc.constantFrom(...BULLETS), piece).map(([bullet, text]) => bullet + text) },
  { weight: 5, arbitrary: fc.array(fc.tuple(piece, fc.constantFrom(...SEPARATORS)), { minLength: 1, maxLength: 4 }).map((parts) => parts.flat().join('')) },
  { weight: 1, arbitrary: fc.string({ maxLength: 40 }) },
);
/** Something like a resume: headings, bullets, dates and contact details in any order, with stray text between. */
const resumeText = fc.tuple(fc.array(line, { maxLength: 40 }), fc.constantFrom('\n', '\r\n')).map(([lines, end]) => lines.join(end));

const textSource = (text: string) => buildTextSource(text, { fileName: 'r.txt', mimeType: 'text/plain', kind: 'text', sha256: 'x' });

/** A PDF as pdf.js reports it: runs of text at positions, in no particular order, some sharing a line. */
const pdfPages: fc.Arbitrary<RawPdfPage[]> = fc.array(
  fc.record({
    width: fc.constant(612),
    height: fc.constant(792),
    items: fc.array(
      fc.record({
        str: fc.oneof(piece, fc.constantFrom(...HEADINGS), fc.constantFrom(...BULLETS), fc.constantFrom('', ' ', '   ')),
        x: fc.integer({ min: 0, max: 560 }),
        line: fc.integer({ min: 0, max: 30 }),
        size: fc.constantFrom(8, 10, 12, 16),
        widthPerChar: fc.double({ min: 2, max: 9, noNaN: true }),
      }).map(({ str, x, line: row, size, widthPerChar }) => ({ str, transform: [size, 0, 0, size, x, 760 - row * 14], width: str.length * widthPerChar, height: size })),
      { maxLength: 40 },
    ),
  }),
  { minLength: 1, maxLength: 3 },
);

/** What must be true of every resume the parser returns, whatever it was given. */
function expectSound(resume: ParsedResume) {
  const fields = listFields(resume);
  // Every field is the exact text at its place in the file.
  expect(checkIntegrity(resume)).toEqual([]);
  expect(fields.every((f) => f.field.origin === 'source' && f.field.status === 'pending')).toBe(true);
  // No field is empty, and no two share an id (the page tells them apart by it).
  expect(fields.filter((f) => !f.field.value.trim()).map((f) => f.label)).toEqual([]);
  expect(new Set(fields.map((f) => f.field.id)).size).toBe(fields.length);
  expect(fields.every((f) => f.field.confidence >= 0 && f.field.confidence <= 1)).toBe(true);
  const coverage = sourceCoverage(resume);
  expect(coverage).toBeGreaterThanOrEqual(0);
  expect(coverage).toBeLessThanOrEqual(1);
  // Nothing is confirmed yet, so nothing may reach an application.
  const profile = toApplicationProfile(resume);
  expect([profile.contact.name, profile.contact.email, ...profile.summary, ...profile.experience.flatMap((e) => e.bullets)].filter(Boolean)).toEqual([]);
  // It is kept in the browser as JSON between visits, and must come back the same.
  expect(JSON.parse(JSON.stringify(resume))).toEqual(resume);
}

/** What must be true of the text and positions a file was turned into. */
function expectWellFormed(source: SourceDocument) {
  const { text, lines } = source;
  // The lines are the text, cut at its line ends, with nothing left over.
  expect(lines.map((l) => text.slice(l.start, l.end)).join('\n')).toBe(text);
  for (const item of source.items ?? []) {
    const run = text.slice(item.start, item.end);
    expect(item.start).toBeGreaterThanOrEqual(0);
    expect(item.end).toBeLessThanOrEqual(text.length);
    expect(run).not.toBe('');
    expect(run).toBe(run.trim());
    expect(run).not.toContain('\n');
  }
}

describe('whatever text is given as a resume', () => {
  it('is read without failing, into fields that are the exact words of the file', () => {
    fc.assert(
      fc.property(resumeText, (text) => {
        const source = textSource(text);
        expectWellFormed(source);
        expectSound(parseResume(source));
      }),
      { numRuns: 400 },
    );
  });

  it('holds for text that looks nothing like a resume', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ maxLength: 400 }), fc.string({ unit: 'grapheme', maxLength: 200 }), fc.string({ unit: 'binary', maxLength: 200 })), (text) => {
        const source = textSource(text);
        expectWellFormed(source);
        expectSound(parseResume(source));
      }),
      { numRuns: 300 },
    );
  });

  it('is read the same way every time', () => {
    const shape = (r: ParsedResume) => listFields(r).map((f) => [f.label, f.field.value, f.field.spans]);
    fc.assert(
      fc.property(resumeText, (text) => {
        expect(shape(parseResume(textSource(text)))).toEqual(shape(parseResume(textSource(text))));
      }),
      { numRuns: 100 },
    );
  });
});

describe('whatever runs of text a PDF holds', () => {
  it('become lines and positions that agree with the text, and fields that are its exact words', () => {
    fc.assert(
      fc.property(pdfPages, (pages) => {
        const source = buildPdfSource(pages, { fileName: 'r.pdf', mimeType: 'application/pdf', sha256: 'x' });
        expectWellFormed(source);
        expectSound(parseResume(source));
      }),
      { numRuns: 300 },
    );
  });
});
