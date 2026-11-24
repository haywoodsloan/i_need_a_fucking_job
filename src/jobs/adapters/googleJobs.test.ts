/**
 * Google for Jobs through its three routes: JSearch at its maker's own address (OpenWeb Ninja), JSearch through
 * RapidAPI, and SerpAPI. These are the edge cases, with small samples written here. Each route is also run against
 * a whole stored answer in test/sources/contract.test.ts, and reading one ordinary posting is in ../jobs.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { AdapterContext, FetchLike } from '../types';
import { SourceError } from './common';
import { jsearchOpenWebNinja, jsearchRapidApi, normalizeJSearch, normalizeSerp, serpapi } from './googleJobs';

/** A service that gives every request the same answer, and keeps what was asked. */
function service(answer: () => Response, env: Record<string, string> = {}) {
  const asked: { url: string; init?: RequestInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    asked.push({ url, init });
    return answer();
  };
  const ctx: AdapterContext = { fetch, env };
  return { ctx, asked };
}

const answering = (body: unknown, env: Record<string, string> = {}, status = 200) => service(() => Response.json(body, { status }), env);
const params = (url: string) => Object.fromEntries(new URL(url).searchParams);
const headers = (init?: RequestInit) => Object.fromEntries(new Headers(init?.headers));
const failure = (search: Promise<unknown>) => search.then(() => undefined, (e: unknown) => e as SourceError);

const NINJA = { OPENWEBNINJA_API_KEY: 'ninja-key-123' };
const RAPID = { JSEARCH_API_KEY: 'rapid-key-456' };
const nothing = { status: 'OK', request_id: 'r-1', data: { jobs: [], cursor: null } };
const posting = { job_id: 'abc', job_title: 'Backend Engineer', employer_name: 'Globex', job_publisher: 'LinkedIn', job_apply_link: 'https://www.linkedin.com/jobs/view/1' };

describe('JSearch, asked at either of its two addresses', () => {
  it("is asked at its maker's own address, with the key in a header and never in the address", async () => {
    const { ctx, asked } = answering(nothing, NINJA);
    await jsearchOpenWebNinja.search({ role: 'data analyst', location: 'Chicago, IL', distanceMiles: 25, postedWithinDays: 7 }, ctx);
    expect(asked).toHaveLength(1);
    expect(asked[0].url.startsWith('https://api.openwebninja.com/jsearch/search-v2?')).toBe(true);
    expect(params(asked[0].url)).toEqual({ query: 'data analyst in Chicago, IL', num_pages: '2', radius: '40', date_posted: 'week' });
    expect(headers(asked[0].init)).toEqual({ 'x-api-key': 'ninja-key-123' });
    expect(asked[0].url).not.toContain('ninja-key-123');
  });

  it("is asked for the same search through RapidAPI, with that marketplace's two headers", async () => {
    const { ctx, asked } = answering(nothing, RAPID);
    await jsearchRapidApi.search({ role: 'data analyst', location: 'Chicago, IL', distanceMiles: 25, postedWithinDays: 7 }, ctx);
    expect(asked).toHaveLength(1);
    expect(asked[0].url.startsWith('https://jsearch.p.rapidapi.com/search-v2?')).toBe(true);
    expect(params(asked[0].url)).toEqual({ query: 'data analyst in Chicago, IL', num_pages: '2', radius: '40', date_posted: 'week' });
    expect(headers(asked[0].init)).toEqual({ 'x-rapidapi-key': 'rapid-key-456', 'x-rapidapi-host': 'jsearch.p.rapidapi.com' });
    expect(asked[0].url).not.toContain('rapid-key-456');
  });

  it('uses only its own key, whatever other keys the server holds', async () => {
    const { ctx, asked } = answering(nothing, { ...NINJA, ...RAPID, SERPAPI_KEY: 'serp-key-789' });
    await jsearchOpenWebNinja.search({ role: 'pilot' }, ctx);
    await jsearchRapidApi.search({ role: 'pilot' }, ctx);
    expect(asked.map((a) => new URL(a.url).host)).toEqual(['api.openwebninja.com', 'jsearch.p.rapidapi.com']);
    expect(JSON.stringify(headers(asked[0].init))).not.toMatch(/rapid-key|serp-key/);
    expect(JSON.stringify(headers(asked[1].init))).not.toMatch(/ninja-key|serp-key/);
  });

  it('asks for work from home, and no place, in a remote-only search', async () => {
    const { ctx, asked } = answering(nothing, NINJA);
    await jsearchOpenWebNinja.search({ role: 'designer', location: 'Chicago, IL', distanceMiles: 25, workplace: ['remote'] }, ctx);
    expect(params(asked[0].url)).toEqual({ query: 'designer', num_pages: '2', work_from_home: 'true' });
    // Remote together with another kind of workplace is not a remote-only search: the place stays.
    await jsearchOpenWebNinja.search({ role: 'designer', location: 'Chicago, IL', workplace: ['remote', 'hybrid'] }, ctx);
    expect(params(asked[1].url)).toEqual({ query: 'designer in Chicago, IL', num_pages: '2' });
  });

  it("turns the age asked for into the nearest of the service's steps that covers it", async () => {
    const { ctx, asked } = answering(nothing, NINJA);
    for (const postedWithinDays of [1, 2, 3, 5, 7, 14, 31, 90, undefined]) await jsearchOpenWebNinja.search({ role: 'pilot', postedWithinDays }, ctx);
    expect(asked.map((a) => params(a.url).date_posted)).toEqual(['today', '3days', '3days', 'week', 'week', 'month', 'month', 'all', undefined]);
  });

  it('asks for as many pages as GOOGLE_JOBS_PAGES says, two when it says nothing sensible, and never more than twenty', async () => {
    const pagesFor = async (setting?: string) => {
      const { ctx, asked } = answering(nothing, { ...NINJA, ...(setting === undefined ? {} : { GOOGLE_JOBS_PAGES: setting }) });
      await jsearchOpenWebNinja.search({ role: 'pilot' }, ctx);
      // However many pages are asked for, it is one request: the service counts the pages against the plan itself.
      expect(asked).toHaveLength(1);
      return params(asked[0].url).num_pages;
    };
    expect(await pagesFor()).toBe('2');
    expect(await pagesFor('1')).toBe('1');
    expect(await pagesFor('3')).toBe('3');
    expect(await pagesFor('2.9')).toBe('2');
    expect(await pagesFor('500')).toBe('20');
    for (const odd of ['', '0', '-3', 'many']) expect(await pagesFor(odd), `GOOGLE_JOBS_PAGES=${odd}`).toBe('2');
  });

  it('lets the search be cancelled', async () => {
    const cancel = new AbortController();
    const { ctx, asked } = answering(nothing, NINJA);
    await jsearchOpenWebNinja.search({ role: 'pilot' }, { ...ctx, signal: cancel.signal });
    expect(asked[0].init?.signal).toBe(cancel.signal);
  });

  it('reads the postings out of the answer, in the shape it has today and in the older one', async () => {
    const today = answering({ status: 'OK', data: { jobs: [posting, { ...posting, job_id: 'def' }], cursor: 'eyJwYWdlIjozfQ==' } }, NINJA);
    expect((await jsearchOpenWebNinja.search({ role: 'engineer' }, today.ctx)).map((j) => j.id)).toEqual(['google-jobs:abc', 'google-jobs:def']);
    // The search this one replaced answered with the list itself.
    const older = answering({ status: 'OK', data: [posting] }, RAPID);
    expect((await jsearchRapidApi.search({ role: 'engineer' }, older.ctx)).map((j) => j.id)).toEqual(['google-jobs:abc']);
  });

  it('leaves out a posting that has no title, no employer or no id, and keeps the others', async () => {
    const broken = [{ ...posting, job_title: null }, { ...posting, employer_name: '' }, { ...posting, job_id: undefined }, null];
    const { ctx } = answering({ status: 'OK', data: { jobs: [...broken, posting, { ...posting, job_id: 7 }] } }, NINJA);
    // The last one has a number where its id should be text. It is still one posting, with an id of its own.
    expect((await jsearchOpenWebNinja.search({ role: 'engineer' }, ctx)).map((j) => j.id)).toEqual(['google-jobs:abc', 'google-jobs:7']);
  });

  it('finds nothing, without failing, in an answer that holds no postings', async () => {
    for (const empty of [nothing, { status: 'OK', data: { cursor: null } }, { status: 'OK', data: null }, { status: 'OK' }, {}]) {
      expect(await jsearchOpenWebNinja.search({ role: 'engineer' }, answering(empty, NINJA).ctx), JSON.stringify(empty)).toEqual([]);
    }
  });
});

describe('a JSearch posting', () => {
  it("takes its id from Google's short one when the answer carries it next to a long one", () => {
    const long = 'x'.repeat(600);
    expect(normalizeJSearch({ ...posting, job_id: long, job_uid: 'woj2gE2S_6LqvmLAAAAAAA==' }).id).toBe('google-jobs:woj2gE2S_6LqvmLAAAAAAA==');
    expect(normalizeJSearch({ ...posting, job_id: 'woj2gE2S_6LqvmLAAAAAAA==', job_uid: null }).id).toBe('google-jobs:woj2gE2S_6LqvmLAAAAAAA==');
    expect(normalizeJSearch({ ...posting, job_id: 'woj2gE2S_6LqvmLAAAAAAA==', job_uid: '' }).id).toBe('google-jobs:woj2gE2S_6LqvmLAAAAAAA==');
  });

  it('keeps two postings apart whose long ids only differ at the far end, with an id that stays short and the same', () => {
    const start = 'eyJqb2JfdGl0bGUiOiJTb2Z0d2FyZSBFbmdpbmVlciIsImNvbXBhbnlfbmFtZSI6Ikdsb2JleCJ9'.repeat(4);
    const first = normalizeJSearch({ ...posting, job_id: `${start}-austin` });
    const second = normalizeJSearch({ ...posting, job_id: `${start}-dallas` });
    expect(first.id).not.toBe(second.id);
    expect(first.id).toMatch(/^google-jobs:eyJqb2JfdGl0bGUi[\w=]+~[0-9a-z]+$/);
    expect(first.id.length).toBeLessThan(100);
    expect(normalizeJSearch({ ...posting, job_id: `${start}-austin` }).id).toBe(first.id);
    // An id that is not too long is left exactly as the service gave it.
    const fits = 'a'.repeat(120);
    expect(normalizeJSearch({ ...posting, job_id: fits }).id).toBe(`google-jobs:${fits}`);
  });

  it('leaves out whatever the service sends as null', () => {
    const job = normalizeJSearch({
      ...posting,
      employer_logo: null,
      job_employment_type: null,
      job_description: null,
      job_is_remote: null,
      job_posted_at_datetime_utc: null,
      job_location: null,
      job_city: null,
      job_state: null,
      job_country: null,
      job_min_salary: null,
      job_max_salary: null,
      job_salary_currency: null,
      job_salary_period: null,
    });
    expect(job).toEqual({
      id: 'google-jobs:abc',
      title: 'Backend Engineer',
      company: 'Globex',
      companyLogo: undefined,
      location: undefined,
      workplace: undefined,
      employmentType: undefined,
      postedAt: undefined,
      salary: undefined,
      descriptionText: undefined,
      listings: [{ sourceId: 'google-jobs', via: 'LinkedIn', url: 'https://www.linkedin.com/jobs/view/1', applyUrl: 'https://www.linkedin.com/jobs/view/1' }],
    });
  });

  it('says where the job is from the place as written, else the city and state, else the country', () => {
    const where = (place: Partial<Parameters<typeof normalizeJSearch>[0]>) => normalizeJSearch({ ...posting, ...place }).location;
    expect(where({ job_location: 'Austin, TX', job_city: 'Austin', job_state: 'Texas', job_country: 'US' })).toBe('Austin, TX');
    expect(where({ job_location: null, job_city: 'Round Rock', job_state: 'Texas', job_country: 'US' })).toBe('Round Rock, Texas');
    expect(where({ job_location: null, job_city: null, job_state: null, job_country: 'US' })).toBe('US');
  });

  it('reads the pay by the hour or the year, and takes dollars when no currency is named', () => {
    expect(normalizeJSearch({ ...posting, job_min_salary: 70, job_max_salary: 85, job_salary_period: 'HOUR' }).salary).toEqual({ min: 70, max: 85, currency: 'USD', period: 'hour' });
    expect(normalizeJSearch({ ...posting, job_min_salary: null, job_max_salary: 175000, job_salary_currency: 'CAD', job_salary_period: 'YEAR' }).salary).toEqual({ min: undefined, max: 175000, currency: 'CAD', period: 'year' });
  });

  it('is remote when the service says so, and otherwise when its title or place does', () => {
    expect(normalizeJSearch({ ...posting, job_is_remote: true, job_location: 'Anywhere' }).workplace).toBe('remote');
    expect(normalizeJSearch({ ...posting, job_is_remote: false, job_title: 'Backend Engineer (Hybrid)' }).workplace).toBe('hybrid');
    expect(normalizeJSearch({ ...posting, job_is_remote: false, job_location: 'Austin, TX' }).workplace).toBeUndefined();
  });
});

describe('JSearch turning a search down', () => {
  const ask = { role: 'engineer' };

  it("says what the service said, and which setting holds the key it did not accept", async () => {
    // What api.openwebninja.com answers to a request with no key or a wrong one (seen on 2026-11-24).
    const refused = await failure(jsearchOpenWebNinja.search(ask, answering({ message: 'Unauthorized' }, NINJA, 401).ctx));
    expect(refused).toBeInstanceOf(SourceError);
    expect(refused).toMatchObject({
      status: 401,
      message:
        'api.openwebninja.com answered 401 (Unauthorized): it did not accept the key in OPENWEBNINJA_API_KEY. ' +
        'Check the key, that its account has a plan for JSearch (the free one counts), and that the plan has requests left this month.',
    });
  });

  it('points a key that RapidAPI does not know at the setting it may belong in', async () => {
    const refused = await failure(jsearchRapidApi.search(ask, answering({ message: 'You are not subscribed to this API.' }, RAPID, 403).ctx));
    expect(refused).toMatchObject({
      status: 403,
      message:
        'jsearch.p.rapidapi.com answered 403 (You are not subscribed to this API.): it did not accept the key in JSEARCH_API_KEY. ' +
        'Check the key, and that its RapidAPI account is subscribed to JSearch with requests left this month. A key from openwebninja.com belongs in OPENWEBNINJA_API_KEY.',
    });
  });

  it("says that the plan's requests are used up, or came too fast, on a 429", async () => {
    const refused = await failure(jsearchOpenWebNinja.search(ask, answering({ message: 'Limit Exceeded' }, NINJA, 429).ctx));
    expect(refused).toMatchObject({ status: 429, message: "api.openwebninja.com answered 429 (Limit Exceeded): the plan's requests are used up, or they came too fast." });
  });

  it("passes any other failure on with its status, and with the service's own words when it gave some", async () => {
    const itsOwn = await failure(jsearchOpenWebNinja.search(ask, answering({ status: 'ERROR', request_id: 'r-2', error: { message: 'Missing query', code: 400 } }, NINJA, 400).ctx));
    expect(itsOwn).toMatchObject({ status: 400, message: 'api.openwebninja.com answered 400 (Missing query)' });

    const noWords = service(() => new Response('<html><body>Bad gateway</body></html>', { status: 502, headers: { 'content-type': 'text/html' } }), RAPID);
    expect(await failure(jsearchRapidApi.search(ask, noWords.ctx))).toMatchObject({ status: 502, message: 'jsearch.p.rapidapi.com answered 502' });

    const emptyWords = await failure(jsearchOpenWebNinja.search(ask, answering({ message: '   ', error: { message: 7 } }, NINJA, 500).ctx));
    expect(emptyWords).toMatchObject({ status: 500, message: 'api.openwebninja.com answered 500' });
  });

  it('treats an answer that says ERROR as a failure, even when it arrives as a success', async () => {
    const withWords = await failure(jsearchOpenWebNinja.search(ask, answering({ status: 'ERROR', error: { message: 'Something went wrong', code: 500 } }, NINJA).ctx));
    expect(withWords).toBeInstanceOf(SourceError);
    expect(withWords).toMatchObject({ status: 500, message: 'api.openwebninja.com answered with an error (Something went wrong)' });

    const bare = await failure(jsearchRapidApi.search(ask, answering({ status: 'ERROR', error: { code: 'E_UNKNOWN' } }, RAPID).ctx));
    expect(bare).toMatchObject({ status: undefined, message: 'jsearch.p.rapidapi.com answered with an error' });
  });

  it('sends nothing, and does not repeat the key, when the key could not travel in a header', async () => {
    // A key copied with something invisible in it, or with a line break. Whatever sends the request would refuse
    // such a header, and may quote it while doing so.
    for (const key of ['ninja-key\u200b-123', 'ninja-key\n-123', 'ninja key 123', 'clé-123', '   ']) {
      const { ctx, asked } = answering(nothing, { OPENWEBNINJA_API_KEY: key });
      const refused = await failure(jsearchOpenWebNinja.search(ask, ctx));
      expect(refused, JSON.stringify(key)).toBeInstanceOf(SourceError);
      expect(refused?.message).toBe('The key in OPENWEBNINJA_API_KEY cannot be sent as it is: it is empty, or it holds a space, a line break or a character that is not plain text. Copy it in again.');
      expect(asked).toEqual([]);
    }
    // Space around a key is not part of it.
    const padded = answering(nothing, { JSEARCH_API_KEY: '  rapid-key-456\t' });
    await jsearchRapidApi.search(ask, padded.ctx);
    expect(headers(padded.asked[0].init)['x-rapidapi-key']).toBe('rapid-key-456');
  });

  it('never repeats the key, and keeps a long complaint short', async () => {
    // The sentence is shown with the search results, to everyone who uses the server.
    const echoed = await failure(jsearchOpenWebNinja.search(ask, answering({ message: 'The key ninja-key-123 is not valid. Sent: ninja-key-123' }, NINJA, 403).ctx));
    expect(echoed?.message).toContain('(The key … is not valid. Sent: …)');
    expect(echoed?.message).not.toContain('ninja-key-123');

    const inSuccess = await failure(jsearchRapidApi.search(ask, answering({ status: 'ERROR', error: { message: 'Quota exceeded for rapid-key-456' } }, RAPID).ctx));
    expect(inSuccess?.message).toBe('jsearch.p.rapidapi.com answered with an error (Quota exceeded for …)');

    const long = await failure(jsearchOpenWebNinja.search(ask, answering({ message: 'no '.repeat(500) }, NINJA, 500).ctx));
    expect(long?.message.length).toBeLessThan(260);
  });
});

describe('SerpAPI', () => {
  const env = { SERPAPI_KEY: 'serp-key-789' };
  const result = (n: number) => ({ job_id: `id-${n}`, title: 'Engineer', company_name: 'Globex', apply_options: [{ title: 'LinkedIn', link: `https://www.linkedin.com/jobs/view/${n}` }] });

  /** A service with `pages` pages of one posting each, every page but the last naming the next one. */
  function paged(pages: number, settings: Record<string, string> = {}) {
    const asked: string[] = [];
    const fetch: FetchLike = async (url) => {
      asked.push(url);
      const n = asked.length;
      return Response.json({ jobs_results: [result(n)], ...(n < pages ? { serpapi_pagination: { next_page_token: `page-${n + 1}` } } : {}) });
    };
    const ctx: AdapterContext = { fetch, env: { ...env, ...settings } };
    return { ctx, asked };
  }

  it('asks for two pages, each one a request, and follows the service from one page to the next', async () => {
    const { ctx, asked } = paged(5);
    const jobs = await serpapi.search({ role: 'engineer', location: 'Austin, TX' }, ctx);
    expect(jobs.map((j) => j.id)).toEqual(['google-jobs:id-1', 'google-jobs:id-2']);
    expect(asked.map((url) => params(url).next_page_token)).toEqual([undefined, 'page-2']);
  });

  it('asks for as many pages as GOOGLE_JOBS_PAGES says, and stops early when the service has no more', async () => {
    const one = paged(5, { GOOGLE_JOBS_PAGES: '1' });
    await serpapi.search({ role: 'engineer' }, one.ctx);
    expect(one.asked).toHaveLength(1);

    const four = paged(5, { GOOGLE_JOBS_PAGES: '4' });
    expect(await serpapi.search({ role: 'engineer' }, four.ctx)).toHaveLength(4);
    expect(four.asked).toHaveLength(4);

    const short = paged(2, { GOOGLE_JOBS_PAGES: '4' });
    expect(await serpapi.search({ role: 'engineer' }, short.ctx)).toHaveLength(2);
    expect(short.asked).toHaveLength(2);
  });

  it('keeps two postings apart whose long ids only differ at the far end', () => {
    // SerpAPI's ids are long by nature: encoded text that begins with the job's title. Found by reading the code,
    // not seen in use: the id was cut off at 120 characters, so these two would have been one posting to the
    // results list, and choosing the second would have shown the first.
    const start = 'eyJqb2JfdGl0bGUiOiJTZW5pb3IgU29mdHdhcmUgRW5naW5lZXIsIE1hY2hpbmUgTGVhcm5pbmcgSW5mcmFzdHJ1Y3R1cmUiLCJjb21wYW55X25hbWUiOiJHbG9iZXgi';
    const austin = normalizeSerp({ ...result(1), job_id: `${start}LCJhZGRyZXNzX2NpdHkiOiJBdXN0aW4sIFRYIn0=` });
    const dallas = normalizeSerp({ ...result(1), job_id: `${start}LCJhZGRyZXNzX2NpdHkiOiJEYWxsYXMsIFRYIn0=` });
    expect(start.length).toBeGreaterThan(120);
    expect(austin.id).not.toBe(dallas.id);
    expect(austin.id.length).toBeLessThan(100);
    expect(normalizeSerp({ ...result(1), job_id: 'short-id' }).id).toBe('google-jobs:short-id');
  });
});
