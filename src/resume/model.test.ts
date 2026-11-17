/**
 * The rules every resume field lives by: a value is the exact text at its place in the source, or the user typed it.
 * Reading a resume into fields is tested in parse.test.ts.
 */
import { describe, expect, it } from 'vitest';
import basicResume from '../../test/fixtures/resumes/basic.txt?raw';
import { buildTextSource } from './extract';
import { checkIntegrity, listFields, normalizeWs, reviewStats, sourceCoverage, textOfSpans, toApplicationProfile, updateField, type Field, type ParsedResume } from './model';
import { parseResume } from './parse';

const parsed = () => parseResume(buildTextSource(basicResume, { fileName: 'r.txt', mimeType: 'text/plain', kind: 'text', sha256: 'abc123' }));
const ref = (r: ParsedResume, label: string) => listFields(r).find((f) => f.label === label)!;
const at = (r: ParsedResume, path: (string | number)[]) => path.reduce<unknown>((o, key) => (o as Record<string | number, unknown>)[key], r) as Field;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

describe('the list of fields in a resume', () => {
  const r = parsed();
  const fields = listFields(r);

  it('names every field, in the order the review screen shows them', () => {
    const labels = fields.map((f) => f.label);
    expect(labels.slice(0, 7)).toEqual(['Name', 'Headline', 'Email', 'Phone', 'Location', 'Link 1', 'Link 2']);
    expect(labels).toEqual(expect.arrayContaining(['Summary 1', 'Experience 1 · Title', 'Experience 1 · Bullet 2', 'Experience 3 · Dates', 'Education 1 · GPA', 'Skills · Languages · Category', 'Skills · Infrastructure · 3', 'CERTIFICATIONS · 1']));
    expect(new Set(labels).size).toBe(labels.length);
    expect(fields.find((f) => f.label === 'Experience 2 · Company')?.group).toBe('Experience 2');
  });

  it('gives each field a path that leads back to that same field', () => {
    for (const f of fields) expect(at(r, f.path), f.label).toBe(f.field);
  });

  it('gives every field its own id', () => {
    const ids = fields.map((f) => f.field.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('changing one field', () => {
  it('changes that field only, in a copy, and leaves the resume it was given untouched', () => {
    const before = deepFreeze(parsed());
    const target = ref(before, 'Experience 1 · Bullet 2');

    const after = updateField(before, target.path, { status: 'verified' });

    expect(at(after, target.path)).toEqual({ ...target.field, status: 'verified' });
    expect(at(before, target.path).status).toBe('pending');
    const changed = listFields(after).filter((f, i) => f.field !== listFields(before)[i].field);
    expect(changed.map((f) => f.label)).toEqual(['Experience 1 · Bullet 2']);
    // What was not on the way to the field is the very same object, so the screen does not redraw it.
    expect(after.education).toBe(before.education);
    expect(after.experience[1]).toBe(before.experience[1]);
    expect(Date.parse(after.updatedAt)).not.toBeNaN();
  });
});

describe('the check that nothing was reworded', () => {
  const r = parsed();
  const name = ref(r, 'Name');

  it('passes a field whose value is the text at its place, however the spaces fall', () => {
    expect(checkIntegrity(updateField(r, name.path, { value: '  Jordan   A.\tRivera ' }))).toEqual([]);
  });

  it.each([
    ['a changed word', { value: 'Jordan B. Rivera' }, 'Value differs from source text "Jordan A. Rivera"'],
    ['a different case', { value: 'JORDAN A. RIVERA' }, 'Value differs from source text "Jordan A. Rivera"'],
    ['no place in the source', { spans: [] }, 'No source location recorded'],
    ['a place past the end of the source', { spans: [{ start: 0, end: 1_000_000 }] }, 'Source location is out of range'],
    ['a place before the start of the source', { spans: [{ start: -1, end: 5 }] }, 'Source location is out of range'],
    ['an empty place', { spans: [{ start: 5, end: 5 }] }, 'Source location is out of range'],
  ])('fails a field with %s', (_what, patch, reason) => {
    const problems = checkIntegrity(updateField(r, name.path, patch));
    expect(problems).toEqual([{ fieldId: name.field.id, label: 'Name', reason }]);
  });

  it("does not hold the user's own typing to the source", () => {
    expect(checkIntegrity(updateField(r, name.path, { value: 'J. Rivera', origin: 'user', spans: [] }))).toEqual([]);
  });

  it('reads a value spread over several places as those pieces joined by a space', () => {
    expect(textOfSpans('Built dashboards in Looker,\n   used by 40 managers.', [{ start: 0, end: 27 }, { start: 31, end: 51 }])).toBe('Built dashboards in Looker, used by 40 managers.');
    expect(normalizeWs(' a \n b\t c ')).toBe('a b c');
  });
});

describe('how far the review has come', () => {
  it('counts the fields by what the user has decided', () => {
    let r = parsed();
    const total = listFields(r).length;
    expect(reviewStats(r)).toEqual({ total, verified: 0, rejected: 0, pending: total, userEdited: 0 });

    r = updateField(r, ref(r, 'Name').path, { status: 'verified' });
    r = updateField(r, ref(r, 'Headline').path, { status: 'rejected' });
    r = updateField(r, ref(r, 'Email').path, { value: 'me@new.example', origin: 'user', spans: [], status: 'verified' });
    expect(reviewStats(r)).toEqual({ total, verified: 2, rejected: 1, pending: total - 3, userEdited: 1 });
  });
});

describe('how much of the source the fields account for', () => {
  it('goes down when a field is rejected, because its text is then in no field', () => {
    const r = parsed();
    const whole = sourceCoverage(r);
    const without = sourceCoverage(updateField(r, ref(r, 'Summary 1').path, { status: 'rejected' }));
    expect(whole).toBeGreaterThan(0.97);
    expect(without).toBeLessThan(whole - 0.05);
  });

  it('is complete for a source with nothing in it to account for', () => {
    const empty = parseResume(buildTextSource(' \n • \n', { fileName: 'empty.txt', mimeType: 'text/plain', kind: 'text', sha256: 'x' }));
    expect(sourceCoverage(empty)).toBe(1);
  });
});

describe('what an application may use', () => {
  it('is nothing until the user has verified it', () => {
    const profile = toApplicationProfile(parsed());
    expect(profile).toMatchObject({ resumeId: expect.any(String), sourceSha256: 'abc123' });
    expect(profile.contact).toEqual({ name: undefined, headline: undefined, email: undefined, phone: undefined, location: undefined, links: [] });
    expect(profile.summary).toEqual([]);
    expect(profile.experience.map((e) => e.bullets)).toEqual([[], [], []]);
    expect(profile.skills.every((s) => s.items.length === 0)).toBe(true);
  });

  it('is each verified field, word for word, with the dates also read into month and year', () => {
    let r = parsed();
    for (const label of ['Experience 1 · Title', 'Experience 1 · Dates', 'Experience 1 · Bullet 1', 'Skills · Languages · Category', 'Skills · Languages · 1', 'CERTIFICATIONS · 1']) {
      r = updateField(r, ref(r, label).path, { status: 'verified' });
    }
    const profile = toApplicationProfile(r);
    expect(profile.experience[0]).toEqual({
      title: 'Senior Software Engineer',
      company: undefined,
      location: undefined,
      dates: { text: 'Jan 2021 – Present', start: { year: 2021, month: 1 }, end: undefined, current: true },
      bullets: ['Led migration of the order pipeline from a monolith to 14 Go services, cutting p99 latency by 38%.'],
    });
    expect(profile.skills[0]).toEqual({ category: 'Languages', items: ['Go'] });
    expect(profile.otherSections).toEqual([{ kind: 'certifications', heading: 'CERTIFICATIONS', items: ['AWS Certified Solutions Architect – Associate (2022)'] }]);
  });

  it('leaves out a field the user rejected', () => {
    let r = parsed();
    r = updateField(r, ref(r, 'Phone').path, { status: 'rejected' });
    r = updateField(r, ref(r, 'Email').path, { status: 'verified' });
    expect(toApplicationProfile(r).contact).toMatchObject({ email: 'jordan.rivera@example.com', phone: undefined });
  });

  it('is refused altogether when any field fails the check, verified or not', () => {
    const r = parsed();
    const tampered = updateField(r, ref(r, 'Experience 2 · Title').path, { value: 'Staff Software Engineer' });
    expect(() => toApplicationProfile(tampered)).toThrow('Resume failed integrity check: Experience 2 · Title');
  });
});
