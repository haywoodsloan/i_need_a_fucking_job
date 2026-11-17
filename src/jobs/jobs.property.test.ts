/**
 * Property tests for the job search: rules that must hold for any list of postings and any text a job site sends,
 * checked on hundreds of made-up cases. When one fails, fast-check prints the smallest case that still fails, and
 * the seed to run it again.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeHtml, guessWorkplace, htmlToText, iso, matchesQuery, normalizePeriod, parsePlace } from './adapters/common';
import { parseSalaryText, relativeToIso } from './adapters/googleJobs';
import { parseIndeedPage, readJsonObject } from './adapters/indeed';
import { dedupeKey, mergeJobs } from './aggregate';
import { boardsForPublisher, BOARDS } from './boards';
import { searchCatalog, slugCandidates } from './catalog';
import type { JobListing, JobPosting } from './types';

// Few companies, titles and places, so that the same job really does turn up more than once.
const listing: fc.Arbitrary<JobListing> = fc.record({
  sourceId: fc.constantFrom('google-jobs', 'greenhouse', 'lever', 'linkedin-guest'),
  via: fc.constantFrom('LinkedIn', 'linkedin', 'Indeed', 'Acme', 'Acme Careers', 'Glassdoor'),
  url: fc.webUrl(),
});
const posting: fc.Arbitrary<JobPosting> = fc.record(
  {
    id: fc.string({ minLength: 1, maxLength: 12 }),
    title: fc.constantFrom('Software Engineer', 'software engineer', 'Staff Engineer', 'Pilot'),
    company: fc.constantFrom('Acme', 'ACME, Inc.', 'Acme LLC', 'Globex', 'Globex Corporation', 'Initech'),
    location: fc.constantFrom('Austin, TX', 'Austin, Texas', 'Austin (Hybrid)', 'Dallas, TX', 'Remote'),
    workplace: fc.constantFrom('remote', 'hybrid', 'onsite'),
    employmentType: fc.constantFrom('Full-time', 'Contract'),
    postedAt: fc.date({ min: new Date('2026-01-01T00:00:00Z'), max: new Date('2026-11-17T00:00:00Z'), noInvalidDate: true }).map((d) => d.toISOString()),
    salary: fc.record({ min: fc.integer({ min: 1, max: 300_000 }) }),
    descriptionText: fc.string({ maxLength: 60 }),
    companyLogo: fc.webUrl(),
    listings: fc.array(listing, { minLength: 1, maxLength: 3 }),
  },
  { requiredKeys: ['id', 'title', 'company', 'listings'] },
) as fc.Arbitrary<JobPosting>;
const lists = fc.array(fc.array(posting, { maxLength: 8 }), { maxLength: 4 });

const boardsOf = (job: JobPosting) => new Set(job.listings.map((l) => l.via.toLowerCase()));

describe('merging any lists of postings', () => {
  it('gives each job once, and loses none', () => {
    fc.assert(
      fc.property(lists, (input) => {
        const merged = mergeJobs(input);
        const keys = merged.map(dedupeKey);
        expect(new Set(keys).size).toBe(keys.length);
        expect(new Set(keys)).toEqual(new Set(input.flat().map(dedupeKey)));
      }),
    );
  });

  it('keeps every board a job was seen on, once each', () => {
    fc.assert(
      fc.property(lists, (input) => {
        for (const job of mergeJobs(input)) {
          const seen = new Set(input.flat().filter((j) => dedupeKey(j) === dedupeKey(job)).flatMap((j) => [...boardsOf(j)]));
          expect(boardsOf(job)).toEqual(seen);
          expect(job.listings.length).toBeGreaterThanOrEqual(seen.size);
        }
      }),
    );
  });

  it('keeps the longest description of each job, and never drops a fact some copy had', () => {
    fc.assert(
      fc.property(lists, (input) => {
        for (const job of mergeJobs(input)) {
          const copies = input.flat().filter((j) => dedupeKey(j) === dedupeKey(job));
          expect((job.descriptionText ?? '').length).toBe(Math.max(...copies.map((j) => (j.descriptionText ?? '').length)));
          for (const fact of ['salary', 'workplace', 'postedAt', 'companyLogo', 'employmentType'] as const) {
            if (copies.some((j) => j[fact] !== undefined)) expect(job[fact], fact).toBeDefined();
          }
          // Its name, company and id are those of the first copy that was seen.
          expect(job).toMatchObject({ id: copies[0].id, title: copies[0].title, company: copies[0].company });
        }
      }),
    );
  });

  it('puts newer postings before older ones, and undated ones last', () => {
    fc.assert(
      fc.property(lists, (input) => {
        const times = mergeJobs(input).map((j) => (j.postedAt ? Date.parse(j.postedAt) : -Infinity));
        expect(times).toEqual([...times].sort((a, b) => b - a));
      }),
    );
  });

  it('changes nothing it was given, and changes nothing more when its result is merged again', () => {
    fc.assert(
      fc.property(lists, (input) => {
        const before = structuredClone(input);
        const merged = mergeJobs(input);
        expect(input).toEqual(before);
        expect(mergeJobs([merged])).toEqual(merged);
      }),
    );
  });
});

describe('cutting a JSON object out of a page', () => {
  const object = fc.dictionary(fc.string({ maxLength: 8 }), fc.jsonValue({ maxDepth: 3 }), { maxKeys: 6 });
  const noBrace = fc.string({ maxLength: 30 }).map((s) => s.replace(/\{/g, '('));

  it('returns exactly the object, whatever braces and quotes its strings hold', () => {
    fc.assert(
      fc.property(noBrace, object, fc.string({ maxLength: 30 }), (before, value, after) => {
        const json = JSON.stringify(value);
        expect(readJsonObject(before + json + after, 0)).toBe(json);
      }),
      { numRuns: 300 },
    );
  });

  it('never fails on a page that is cut short or is not the page it expected', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), fc.integer({ min: 0, max: 220 }), (page, from) => {
        const found = readJsonObject(page, from);
        if (found !== undefined) {
          expect(found.startsWith('{') && found.endsWith('}')).toBe(true);
          expect(page).toContain(found);
        }
        // A page without the marker has no postings. It is not an error.
        expect(parseIndeedPage(page)).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });
});

describe('reading whatever text a job site sends', () => {
  const anything = fc.oneof(fc.string(), fc.string({ unit: 'grapheme' }), fc.string({ unit: 'binary' }));

  it('never fails, and gives an answer of the kind it promises', () => {
    fc.assert(
      fc.property(anything, (text) => {
        expect(typeof htmlToText(text)).toBe('string');
        expect(typeof decodeHtml(text)).toBe('string');
        expect([undefined, 'remote', 'hybrid', 'onsite']).toContain(guessWorkplace(text));
        expect([undefined, 'hour', 'day', 'week', 'month', 'year']).toContain(normalizePeriod(text));
        const when = iso(text);
        if (when !== undefined) expect(new Date(when).toISOString()).toBe(when);
        const posted = relativeToIso(text, Date.parse('2026-11-17T12:00:00Z'));
        if (posted !== undefined) expect(new Date(posted).toISOString()).toBe(posted);
        const salary = parseSalaryText(text);
        if (salary?.min !== undefined) expect(Number.isFinite(salary.min)).toBe(true);
        const place = parsePlace(text);
        if (place) expect(place.city.trim()).not.toBe('');
        expect(typeof matchesQuery({ title: text, location: text }, { role: text, location: text })).toBe('boolean');
        for (const slug of slugCandidates(text)) expect(slug).toMatch(/^[a-z0-9_-]{2,}$/);
        expect(Array.isArray(searchCatalog(text))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('leaves no tag in the plain text of a description', () => {
    const tag = fc.constantFrom('p', 'div', 'li', 'ul', 'b', 'br', 'script', 'style', 'h2', 'span', 'a');
    const word = fc.constantFrom('Fly', 'planes', 'and', 'train', 'pilots.', 'R&amp;D', '5 &gt; 3', 'caf&#233;');
    const html = fc.array(fc.oneof(word, tag.map((t) => `<${t}>`), tag.map((t) => `</${t}>`), tag.map((t) => `<${t} class="x" data-a='1'>`)), { maxLength: 30 }).map((parts) => parts.join(' '));
    fc.assert(
      fc.property(html, (source) => {
        expect(htmlToText(source)).not.toMatch(/<\/?[a-z][^>]*>/i);
      }),
      { numRuns: 300 },
    );
  });

  it('files every publisher under at least one board that exists', () => {
    const known = new Set(BOARDS.map((b) => b.id));
    fc.assert(
      fc.property(fc.oneof(anything, fc.constantFrom(...BOARDS.flatMap((b) => b.publishers)).map((p) => `via ${p}`)), (publisher) => {
        const boards = boardsForPublisher(publisher);
        expect(boards.length).toBeGreaterThan(0);
        expect(boards.every((b) => known.has(b))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
