import { describe, expect, it } from 'vitest';
// Read through Vite (`?raw`) and not node:fs: files under src/ are checked as browser code.
import basicResume from '../../test/fixtures/resumes/basic.txt?raw';
import { buildTextSource, docxHtmlToText } from './extract';
import { checkIntegrity, listFields, sourceCoverage, toApplicationProfile, updateField } from './model';
import { parseResume } from './parse';

const src = (text: string) => buildTextSource(text, { fileName: 'r.txt', mimeType: 'text/plain', kind: 'text', sha256: 'x' });

describe('parseResume on a plain-text resume', () => {
  const r = parseResume(src(basicResume));

  it('extracts contact details verbatim', () => {
    expect(r.contact.name?.value).toBe('Jordan A. Rivera');
    expect(r.contact.headline?.value).toBe('Senior Software Engineer');
    expect(r.contact.email?.value).toBe('jordan.rivera@example.com');
    expect(r.contact.phone?.value).toBe('(512) 555-0142');
    expect(r.contact.location?.value).toBe('Austin, TX');
    expect(r.contact.links.map((l) => l.value)).toEqual(['linkedin.com/in/jordanrivera', 'github.com/jrivera']);
  });

  it('extracts the summary paragraph', () => {
    expect(r.summary).toHaveLength(1);
    expect(r.summary[0].value).toMatch(/^Backend engineer with 8 years/);
  });

  it('splits experience into entries, including stacked roles', () => {
    const rows = r.experience.map((e) => [e.title?.value, e.company?.value, e.location?.value, e.dates?.value]);
    expect(rows).toEqual([
      ['Senior Software Engineer', 'Globex Corporation', 'Austin, TX', 'Jan 2021 – Present'],
      ['Software Engineer', 'Globex Corporation', undefined, 'Jun 2018 – Dec 2020'],
      ['Software Developer Intern', 'Initech LLC', 'Dallas, TX', 'May 2017 - Aug 2017'],
    ]);
    expect(r.experience[0].bullets.map((b) => b.value)).toEqual([
      'Led migration of the order pipeline from a monolith to 14 Go services, cutting p99 latency by 38%.',
      'Designed the idempotency layer used by every payment endpoint.',
    ]);
    expect(r.experience[0].dates).toMatchObject({ start: { year: 2021, month: 1 }, current: true });
    expect(r.experience[1].dates).toMatchObject({ start: { year: 2018, month: 6 }, end: { year: 2020, month: 12 } });
    expect(r.experience[2].bullets[0].value).toBe('Wrote internal tooling in Python for TPS report validation.');
  });

  it('parses education with degree, field and GPA', () => {
    expect(r.education).toHaveLength(1);
    const e = r.education[0];
    expect(e.institution?.value).toBe('University of Texas at Austin');
    expect(e.degree?.value).toBe('B.S.');
    expect(e.fieldOfStudy?.value).toBe('Computer Science');
    expect(e.dates?.value).toBe('May 2018');
    expect(e.gpa?.value).toBe('GPA: 3.7/4.0');
    expect(e.details.map((d) => d.value)).toEqual(["Dean's List, 2015–2018"]);
  });

  it('parses categorized skills without splitting inside parentheses', () => {
    expect(r.skills.map((g) => g.category?.value)).toEqual(['Languages', 'Infrastructure', 'Practices']);
    expect(r.skills[1].items.map((i) => i.value)).toEqual([
      'Kubernetes', 'Terraform', 'AWS (Lambda, SQS, DynamoDB)', 'PostgreSQL',
    ]);
  });

  it('keeps unstructured sections as line items', () => {
    const certs = r.sections.find((s) => s.kind === 'certifications');
    expect(certs?.items.map((i) => i.value)).toEqual(['AWS Certified Solutions Architect – Associate (2022)']);
  });

  it('passes the verbatim integrity check and covers the document', () => {
    expect(checkIntegrity(r)).toEqual([]);
    expect(sourceCoverage(r)).toBeGreaterThan(0.97);
  });
});

describe('integrity guarantees', () => {
  const r = parseResume(src(basicResume));

  it('flags a source field whose value no longer matches its span', () => {
    const ref = listFields(r).find((f) => f.label === 'Email')!;
    const tampered = updateField(r, ref.path, { value: 'someone.else@example.com' });
    expect(checkIntegrity(tampered).map((p) => p.label)).toEqual(['Email']);
    expect(() => toApplicationProfile(tampered)).toThrow(/integrity/);
  });

  it('allows the user to type their own words, marked as user origin', () => {
    const ref = listFields(r).find((f) => f.label === 'Email')!;
    const edited = updateField(r, ref.path, { value: 'me@new.example', origin: 'user', spans: [], status: 'verified' });
    expect(checkIntegrity(edited)).toEqual([]);
    expect(toApplicationProfile(edited).contact.email).toBe('me@new.example');
  });

  it('only exposes verified fields to applications', () => {
    expect(toApplicationProfile(r).contact.name).toBeUndefined();
    const ref = listFields(r).find((f) => f.label === 'Name')!;
    expect(toApplicationProfile(updateField(r, ref.path, { status: 'verified' })).contact.name).toBe('Jordan A. Rivera');
  });
});

describe('docx HTML conversion', () => {
  it('marks list items as bullets and keeps paragraphs as lines', () => {
    const html = '<p><strong>Experience</strong></p><p>Acme Inc. | Engineer | 2019 – 2021</p><ul><li>Shipped &amp; maintained things</li></ul>';
    const text = docxHtmlToText(html);
    expect(text.split('\n').filter(Boolean)).toEqual(['Experience', 'Acme Inc. | Engineer | 2019 – 2021', '• Shipped & maintained things']);
    const r = parseResume(src(text));
    expect(r.experience[0]).toMatchObject({ title: { value: 'Engineer' }, company: { value: 'Acme Inc.' }, dates: { value: '2019 – 2021' } });
    expect(r.experience[0].bullets[0].value).toBe('Shipped & maintained things');
  });
});
