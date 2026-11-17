/**
 * Planning which sources a search runs, and merging what they return. The search as a whole, over HTTP and with
 * recorded answers, is in test/integration/search-server.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlockedError, type Adapter } from './adapters/common';
import { aggregate, dedupeKey, googleJobsAdapter, mergeJobs, planSearch } from './aggregate';
import { COMPANIES } from './catalog';
import type { AdapterContext, FetchLike, JobPosting, SearchSettings } from './types';

afterEach(() => {
  vi.useRealTimers();
});

const job = (over: Partial<JobPosting> = {}): JobPosting => ({ id: 'x:1', title: 'Engineer', company: 'Acme', location: 'Austin, TX', listings: [], ...over });
const settings = (over: Partial<SearchSettings> = {}): SearchSettings => ({ boards: [], companies: [], industries: [], allowScraping: false, ...over });
const offline: FetchLike = async () => {
  throw new Error('no request was expected');
};
const ctx = (env: Record<string, string> = {}, fetch: FetchLike = offline): AdapterContext => ({ fetch, env });
const plan = (s: Partial<SearchSettings>, env: Record<string, string> = {}, o: Parameters<typeof planSearch>[3] = { runtime: 'server' }) =>
  planSearch({ role: 'engineer' }, settings(s), ctx(env), o).map((t) => [t.sourceId, t.skipped ?? 'runs']);

describe('telling the same job apart from a different one', () => {
  it('sees through how the company and the place are written', () => {
    const key = dedupeKey(job());
    for (const same of [{ company: 'ACME, Inc.' }, { company: 'Acme LLC' }, { company: 'Acme Corporation' }, { company: 'acme ltd' }, { location: 'Austin, Texas, United States' }, { location: 'Austin (Hybrid)' }, { title: 'ENGINEER' }]) {
      expect(dedupeKey(job(same)), JSON.stringify(same)).toBe(key);
    }
  });

  it('keeps apart jobs that differ in company, title or city', () => {
    const key = dedupeKey(job());
    for (const other of [{ company: 'Acme Robotics' }, { title: 'Engineer II' }, { location: 'Dallas, TX' }, { location: undefined }]) {
      expect(dedupeKey(job(other)), JSON.stringify(other)).not.toBe(key);
    }
  });
});

describe('merging what the sources returned', () => {
  const li = { sourceId: 'google-jobs', via: 'LinkedIn', url: 'https://l/1' };

  it('lists a board once for a job, however often that board reported it', () => {
    const merged = mergeJobs([[job({ listings: [li] })], [job({ listings: [{ ...li, via: 'linkedin', url: 'https://l/2' }, { sourceId: 'greenhouse', via: 'Acme', url: 'https://a/1' }] })]]);
    expect(merged).toHaveLength(1);
    expect(merged[0].listings.map((l) => l.url)).toEqual(['https://l/1', 'https://a/1']);
  });

  it('fills in what the first copy of a job lacked, without overwriting what it had', () => {
    const first = job({ id: 'a:1', salary: { text: '$100k' }, descriptionText: 'A long description of the job.', descriptionHtml: '<p>A long description of the job.</p>' });
    const second = job({ id: 'b:2', salary: { text: '$1' }, workplace: 'hybrid', postedAt: '2026-11-10T00:00:00.000Z', companyLogo: 'https://logo.example/a.png', employmentType: 'Full-time', descriptionText: 'Short.', descriptionPartial: true });
    const [merged] = mergeJobs([[first], [second]]);
    expect(merged).toMatchObject({
      id: 'a:1',
      salary: { text: '$100k' },
      workplace: 'hybrid',
      postedAt: '2026-11-10T00:00:00.000Z',
      companyLogo: 'https://logo.example/a.png',
      employmentType: 'Full-time',
      descriptionText: 'A long description of the job.',
      descriptionHtml: '<p>A long description of the job.</p>',
    });
    expect(merged.descriptionPartial).toBeUndefined();
  });

  it('takes the longer description whole: its HTML, and whether it is only a part', () => {
    const [merged] = mergeJobs([[job({ descriptionText: 'Short.', descriptionHtml: '<p>Short.</p>' })], [job({ descriptionText: 'A snippet that is longer…', descriptionPartial: true })]]);
    expect(merged).toMatchObject({ descriptionText: 'A snippet that is longer…', descriptionHtml: undefined, descriptionPartial: true });
  });

  it('does not change the lists it was given', () => {
    const original = job({ listings: [li] });
    const copy = structuredClone(original);
    mergeJobs([[original], [job({ listings: [{ sourceId: 'lever', via: 'Acme', url: 'https://a/1' }], workplace: 'remote' })]]);
    expect(original).toEqual(copy);
  });

  it('puts the newest postings first and the undated ones last', () => {
    const merged = mergeJobs([[job({ title: 'Old', postedAt: '2026-10-01T00:00:00.000Z' }), job({ title: 'Undated' }), job({ title: 'New', postedAt: '2026-11-15T00:00:00.000Z' })]]);
    expect(merged.map((j) => j.title)).toEqual(['New', 'Old', 'Undated']);
  });
});

describe('choosing the sources for a search', () => {
  it('uses JSearch for Google for Jobs when both keys are set, and SerpAPI when only that one is', () => {
    expect(googleJobsAdapter(ctx({ JSEARCH_API_KEY: 'a', SERPAPI_KEY: 'b' }))?.label).toBe('Google for Jobs (JSearch)');
    expect(googleJobsAdapter(ctx({ SERPAPI_KEY: 'b' }))?.label).toBe('Google for Jobs (SerpAPI)');
    expect(googleJobsAdapter(ctx())).toBeUndefined();
  });

  it('makes one Google for Jobs request cover every chosen board that is reached that way', () => {
    const tasks = planSearch({ role: 'engineer' }, settings({ boards: ['linkedin', 'indeed', 'usajobs', 'remote-boards'] }), ctx({ SERPAPI_KEY: 'k' }), { runtime: 'server' });
    const google = tasks.filter((t) => t.sourceId === 'google-jobs');
    expect(google).toHaveLength(1);
    expect(google[0]).toMatchObject({ label: 'Google for Jobs (SerpAPI)', skipped: undefined });
    expect([...google[0].boardFilter!].sort()).toEqual(['indeed', 'linkedin', 'remote-boards', 'usajobs']);
  });

  it('says which keys a source is waiting for', () => {
    expect(plan({ boards: ['linkedin', 'usajobs'] })).toEqual([
      ['google-jobs', 'needs JSEARCH_API_KEY or SERPAPI_KEY on the server'],
      ['usajobs', 'needs USAJOBS_API_KEY, USAJOBS_USER_AGENT on the server'],
    ]);
    expect(plan({ boards: ['usajobs'] }, { USAJOBS_API_KEY: 'k' })).toEqual([
      ['google-jobs', 'needs JSEARCH_API_KEY or SERPAPI_KEY on the server'],
      ['usajobs', 'needs USAJOBS_USER_AGENT on the server'],
    ]);
  });

  it('plans nothing when nothing is chosen', () => {
    expect(plan({})).toEqual([]);
  });

  it('adds the page-reading routes only when the search and the server both allow them', () => {
    const indeed: Adapter = { id: 'indeed-browser', label: 'Indeed (browser)', requires: ['ENABLE_PLAYWRIGHT'], search: async () => [] };
    const boards = ['linkedin', 'indeed'];
    const env = { JSEARCH_API_KEY: 'k' };
    const extra = { 'indeed-browser': indeed };

    expect(plan({ boards, allowScraping: false }, env, { runtime: 'server', extra })).toEqual([['google-jobs', 'runs']]);
    expect(plan({ boards, allowScraping: true }, env, { runtime: 'server', extra })).toEqual([
      ['google-jobs', 'runs'],
      ['linkedin-guest', 'needs ENABLE_LINKEDIN_GUEST on the server'],
      ['indeed-browser', 'needs ENABLE_PLAYWRIGHT on the server'],
    ]);
    expect(plan({ boards, allowScraping: true }, { ...env, ENABLE_LINKEDIN_GUEST: '1' }, { runtime: 'server' })).toEqual([
      ['google-jobs', 'runs'],
      ['linkedin-guest', 'runs'],
    ]);
    expect(plan({ boards, allowScraping: true }, env, { runtime: 'browser', extra })).toEqual([['google-jobs', 'runs on the backend']]);
  });

  it('searches a company once, whether it was picked by name, by industry or both', () => {
    const aviation = COMPANIES.filter((c) => c.industries.includes('Aerospace & Aviation'));
    expect(aviation.length).toBeGreaterThan(1);
    const tasks = plan({ companies: [aviation[0].id, 'no-such-company'], industries: ['Aerospace & Aviation'] }, { JSEARCH_API_KEY: 'k', USAJOBS_API_KEY: 'k', USAJOBS_USER_AGENT: 'a' });
    expect(tasks).toHaveLength(aviation.length);
    expect(new Set(tasks.map(([id]) => id)).size).toBe(aviation.length);
  });

  it('leaves a typed company for the server to look up', () => {
    expect(plan({ companies: ['custom:Acme Robotics'] }, {}, { runtime: 'browser' })).toEqual([['company:acmerobotics', 'company lookup runs on the backend']]);
    expect(plan({ companies: ['custom:Acme Robotics'] }, {}, { runtime: 'server' })).toEqual([['company:acmerobotics', 'company lookup runs on the backend']]);
    expect(plan({ companies: ['custom:Acme Robotics'] }, {}, { runtime: 'server', discover: async () => undefined })).toEqual([['company:acmerobotics', 'runs']]);
  });
});

describe('running a search', () => {
  const custom = settings({ companies: ['custom:Acme Robotics'] });

  it('searches the hiring system a typed company was found on', async () => {
    const asked: string[] = [];
    const fetch: FetchLike = async (url) => {
      asked.push(url);
      return Response.json({ jobs: [{ id: 1, title: 'Robotics Engineer', location: { name: 'Austin, TX' }, absolute_url: 'https://boards.greenhouse.io/acme/jobs/1' }] });
    };
    const looked: string[] = [];
    const out = await aggregate({ role: 'engineer' }, custom, ctx({}, fetch), {
      runtime: 'server',
      discover: async (name) => {
        looked.push(name);
        return { platform: 'greenhouse', board: 'acme-robotics' };
      },
    });
    expect(looked).toEqual(['Acme Robotics']);
    expect(asked[0]).toContain('/boards/acme-robotics/');
    expect(out.sources).toMatchObject([{ sourceId: 'company:acmerobotics', label: 'Acme Robotics', ok: true, count: 1 }]);
    expect(out.jobs[0]).toMatchObject({ company: 'Acme Robotics', title: 'Robotics Engineer' });
  });

  it('falls back to Google for Jobs for a company found nowhere, keeping only that employer', async () => {
    const fetch: FetchLike = async () =>
      Response.json({
        data: [
          { job_id: '1', job_title: 'Engineer', employer_name: 'Acme Robotics, Inc.', job_publisher: 'LinkedIn', job_apply_link: 'https://l/1' },
          { job_id: '2', job_title: 'Engineer', employer_name: 'Other Robotics', job_publisher: 'LinkedIn', job_apply_link: 'https://l/2' },
        ],
      });
    const out = await aggregate({ role: 'engineer' }, custom, ctx({ JSEARCH_API_KEY: 'k' }, fetch), { runtime: 'server', discover: async () => undefined });
    expect(out.jobs.map((j) => j.company)).toEqual(['Acme Robotics, Inc.']);
    expect(out.sources[0]).toMatchObject({ ok: true, count: 1 });
  });

  it('reports why a typed company could not be searched', async () => {
    const out = await aggregate({ role: 'engineer' }, custom, ctx(), { runtime: 'server', discover: async () => undefined });
    expect(out.jobs).toEqual([]);
    expect(out.sources).toMatchObject([{ sourceId: 'company:acmerobotics', ok: false, count: 0, error: 'needs JSEARCH_API_KEY or SERPAPI_KEY on the server' }]);
  });

  it('gives up on a source that does not answer in time, and still returns the rest', async () => {
    vi.useFakeTimers();
    const fetch: FetchLike = (url) => (url.includes('remotive.com') ? new Promise<Response>(() => {}) : Promise.resolve(Response.json([{ legal: 'notice' }, { id: '1', position: 'Engineer', company: 'Acme' }])));
    const search = aggregate({ role: 'engineer' }, settings({ boards: ['remote-boards'] }), ctx({ JSEARCH_API_KEY: '' }, fetch), { runtime: 'server' });
    await vi.advanceTimersByTimeAsync(25_000);
    const out = await search;
    const by = Object.fromEntries(out.sources.map((s) => [s.sourceId, s]));
    expect(by.remotive).toMatchObject({ ok: false, count: 0, error: 'timed out after 25s' });
    expect(by.remoteok).toMatchObject({ ok: true, count: 1 });
    expect(out.jobs.map((j) => j.id)).toEqual(['remoteok:1']);
  });

  it('marks a source that was turned away as blocked, which is not the same as broken', async () => {
    const fetch: FetchLike = async (url) => {
      if (url.includes('remotive.com')) throw new BlockedError('remotive.com', 403);
      return new Response('oops', { status: 500 });
    };
    const out = await aggregate({ role: 'engineer' }, settings({ boards: ['remote-boards'] }), ctx({ SERPAPI_KEY: '' }, fetch), { runtime: 'server' });
    const by = Object.fromEntries(out.sources.map((s) => [s.sourceId, s]));
    expect(by.remotive).toMatchObject({ ok: false, blocked: true, error: 'remotive.com turned this server away as automated traffic (403)' });
    expect(by.remoteok).toMatchObject({ ok: false, error: 'remoteok.com answered 500' });
    expect(by.remoteok.blocked).toBeUndefined();
  });
});
