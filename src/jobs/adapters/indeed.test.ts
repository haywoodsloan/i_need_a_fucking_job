/**
 * Reading an Indeed results page into postings. Only the reading is tested: the route that loads the page
 * (server/src/indeed.ts) is the old experimental one, off by default, and is not exercised here.
 */
import { describe, expect, it } from 'vitest';
import { indeedSearchUrl, isBotWall, parseIndeedPage, readJsonObject } from './indeed';

const page = (results: unknown[]) =>
  `<html><script>window.mosaic.providerData["mosaic-provider-jobcards"]=${JSON.stringify({ metaData: { mosaicProviderJobCardsModel: { results } } })};window.other={};</script></html>`;

describe('the address of an Indeed search', () => {
  const params = (url: string) => Object.fromEntries(new URL(url).searchParams);

  it('carries the role, the place, the distance and the age of postings', () => {
    const url = indeedSearchUrl({ role: 'software engineer', location: 'Austin, TX', distanceMiles: 25, postedWithinDays: 7 }, 20);
    expect(url.startsWith('https://www.indeed.com/jobs?')).toBe(true);
    expect(params(url)).toEqual({ q: 'software engineer', start: '20', l: 'Austin, TX', radius: '25', fromage: '7' });
  });

  it('asks for remote jobs everywhere in a remote-only search, and leaves the place out', () => {
    expect(params(indeedSearchUrl({ role: 'engineer', location: 'Austin, TX', distanceMiles: 25, workplace: ['remote'] }))).toEqual({ q: 'engineer', start: '0', sc: '0kf:attr(DSQF7);' });
  });

  it('asks for hybrid jobs near the place in a hybrid-only search', () => {
    expect(params(indeedSearchUrl({ role: 'engineer', location: 'Austin, TX', workplace: ['hybrid'] }))).toEqual({ q: 'engineer', start: '0', l: 'Austin, TX', sc: '0kf:attr(PAXZC);' });
  });

  it('has no distance without a place', () => {
    expect(params(indeedSearchUrl({ role: 'engineer', distanceMiles: 50 }))).toEqual({ q: 'engineer', start: '0' });
  });
});

describe('the postings on an Indeed results page', () => {
  it('are read from the data the page carries, with a link to each posting', () => {
    const [job] = parseIndeedPage(page([{ jobkey: 'abc', title: 'Pilot', company: 'Acme Air', formattedLocation: 'Dallas, TX', jobTypes: ['Full-time'], pubDate: 1_763_294_400_000 }]));
    expect(job).toEqual({
      id: 'indeed:abc',
      title: 'Pilot',
      company: 'Acme Air',
      location: 'Dallas, TX',
      workplace: undefined,
      employmentType: 'Full-time',
      postedAt: '2025-11-16T12:00:00.000Z',
      salary: undefined,
      descriptionText: undefined,
      descriptionPartial: true,
      listings: [{ sourceId: 'indeed-browser', via: 'Indeed', url: 'https://www.indeed.com/viewjob?jk=abc', applyUrl: 'https://www.indeed.com/viewjob?jk=abc' }],
    });
  });

  it('take the salary as numbers when the page has them, and as written when it does not', () => {
    const jobs = parseIndeedPage(
      page([
        { jobkey: 'a', title: 'A', extractedSalary: { min: 30, max: 45, type: 'hourly' }, salarySnippet: { text: '$30 - $45 an hour' } },
        { jobkey: 'b', title: 'B', salarySnippet: { text: 'From $90,000 a year' } },
        { jobkey: 'c', title: 'C', salarySnippet: {} },
      ]),
    );
    expect(jobs.map((j) => j.salary)).toEqual([{ min: 30, max: 45, currency: 'USD', period: 'hour', text: '$30 - $45 an hour' }, { text: 'From $90,000 a year' }, undefined]);
  });

  it('stand in for a missing title or company without failing', () => {
    expect(parseIndeedPage(page([{ jobkey: 'x' }]))[0]).toMatchObject({ id: 'indeed:x', title: 'Untitled', company: 'Unknown' });
  });

  it('are none on a page that has no such data, or whose data is cut short', () => {
    expect(parseIndeedPage('<html><body>No jobs here</body></html>')).toEqual([]);
    expect(parseIndeedPage('window.mosaic.providerData["mosaic-provider-jobcards"]={"metaData":{"mosaicProviderJobCardsModel":{"results":[')).toEqual([]);
    expect(parseIndeedPage('window.mosaic.providerData["mosaic-provider-jobcards"]={};')).toEqual([]);
  });
});

describe('cutting one JSON object out of a page', () => {
  it.each([
    ['x = {"a":{"b":[1,{"c":2}]}}; y = {}', '{"a":{"b":[1,{"c":2}]}}'],
    ['{"text":"a } inside a string"} tail', '{"text":"a } inside a string"}'],
    ['{"text":"an escaped \\" quote and a }"} tail', '{"text":"an escaped \\" quote and a }"}'],
    ['{"path":"C:\\\\"} tail', '{"path":"C:\\\\"}'],
    ['{}', '{}'],
  ])('from %j', (text, expected) => {
    expect(readJsonObject(text, 0)).toBe(expected);
    expect(() => JSON.parse(expected)).not.toThrow();
  });

  it('starts looking where it is told to', () => {
    expect(readJsonObject('{"first":1} {"second":2}', 11)).toBe('{"second":2}');
  });

  it('finds nothing when the object never closes, or there is none', () => {
    expect(readJsonObject('{"a":{"b":1}', 0)).toBeUndefined();
    expect(readJsonObject('{"a":"never closed}', 0)).toBeUndefined();
    expect(readJsonObject('no object here', 0)).toBeUndefined();
  });
});

describe('telling a bot check from a results page', () => {
  it.each(['<title>Just a moment...</title>', '<div class="cf-challenge"></div>', '<h1>Additional Verification Required</h1>', '<iframe src="https://hcaptcha.com/x"></iframe>', '<title>Security Check - Indeed.com</title>'])(
    'sees one in %j',
    (html) => {
      expect(isBotWall(html)).toBe(true);
    },
  );

  it('does not see one in a page of results', () => {
    expect(isBotWall(page([{ jobkey: 'abc', title: 'Security Engineer', snippet: 'Wait a moment before applying.' }]))).toBe(false);
  });
});
