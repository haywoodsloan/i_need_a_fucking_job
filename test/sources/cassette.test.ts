/**
 * The replay helper and the recorder's trimming. A wrong recorder writes wrong fixtures without anyone noticing,
 * so the tooling is tested like everything else.
 */
import { describe, expect, it } from 'vitest';
import { recordSource, trimAnswer } from '../../server/src/record-fixtures';
import type { FetchLike } from '../../src/jobs/types';
import { recording, replay, scrubUrl, toResponse, type Cassette } from '../helpers/cassette';
import { SOURCES, sourceByName } from '../helpers/sources';

const cassette = (exchanges: Cassette['exchanges']): Cassette => ({ source: 'sample', origin: 'handwritten', date: '2026-11-17', search: { query: { role: 'software engineer' } }, exchanges });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-secret-trace': 'abc' } });

describe('replaying a cassette', () => {
  const tape = cassette([
    { request: { method: 'GET', url: 'https://api.example.com/jobs?q=a' }, response: { status: 200, json: { jobs: [1] } } },
    { request: { method: 'POST', url: 'https://api.example.com/search', body: '{"page":1}' }, response: { status: 200, json: { page: 1 } } },
    { request: { method: 'POST', url: 'https://api.example.com/search', body: '{"page":2}' }, response: { status: 200, json: { page: 2 } } },
    { request: { method: 'GET', url: 'https://www.example.com/page' }, response: { status: 404, text: '<h1>Gone</h1>' } },
  ]);

  it('answers a request with what was stored for that method, address and body', async () => {
    const net = replay(tape);
    expect(await (await net('https://api.example.com/jobs?q=a')).json()).toEqual({ jobs: [1] });
    expect(await (await net('https://api.example.com/search', { method: 'POST', body: '{"page":2}' })).json()).toEqual({ page: 2 });
    expect(await (await net('https://api.example.com/search', { method: 'post', body: '{"page":1}' })).json()).toEqual({ page: 1 });
    const gone = await net('https://www.example.com/page');
    expect([gone.status, gone.ok, gone.headers.get('content-type'), await gone.text()]).toEqual([404, false, 'text/html; charset=utf-8', '<h1>Gone</h1>']);
  });

  it('keeps count of what was asked and what was never asked', async () => {
    const net = replay(tape);
    await net('https://api.example.com/jobs?q=a');
    await net('https://api.example.com/jobs?q=a');
    expect(net.calls).toEqual([
      { method: 'GET', url: 'https://api.example.com/jobs?q=a' },
      { method: 'GET', url: 'https://api.example.com/jobs?q=a' },
    ]);
    expect(net.unused().map((e) => e.request.url)).toEqual(['https://api.example.com/search', 'https://api.example.com/search', 'https://www.example.com/page']);
  });

  it('fails a request it has no answer for, and says what it does have', async () => {
    const net = replay(tape);
    const asking = net('https://api.example.com/jobs?q=b');
    await expect(asking).rejects.toThrow('No recorded answer for this request:\n    GET https://api.example.com/jobs?q=b');
    await expect(asking).rejects.toThrow('POST https://api.example.com/search\n      body: {"page":1}');
    await expect(net('https://api.example.com/search', { method: 'POST', body: '{"page":3}' })).rejects.toThrow('No recorded answer');
  });

  it('never needs a real key: keys in an address are blanked on both sides', async () => {
    expect(scrubUrl('https://serpapi.com/search.json?q=x&api_key=live-key-123')).toBe('https://serpapi.com/search.json?q=x&api_key=REDACTED');
    expect(scrubUrl('https://api.example.com/v1?token=t&key=k&page=2')).toBe('https://api.example.com/v1?token=REDACTED&key=REDACTED&page=2');
    expect(scrubUrl('https://api.example.com/v1?monkey=1')).toBe('https://api.example.com/v1?monkey=1');
    const net = replay(cassette([{ request: { method: 'GET', url: 'https://serpapi.com/search.json?q=x&api_key=REDACTED' }, response: { status: 200, json: {} } }]));
    expect((await net('https://serpapi.com/search.json?q=x&api_key=whatever-the-test-has')).status).toBe(200);
  });

  it('stops for a search that was cancelled', async () => {
    const net = replay(tape);
    await expect(net('https://api.example.com/jobs?q=a', { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('can stand in for answers a real Response cannot be built with', async () => {
    const refused = toResponse({ status: 999, text: '' });
    expect([refused.status, refused.ok]).toEqual([999, false]);
    expect(toResponse({ status: 204 }).body).toBeNull();
  });
});

describe('recording', () => {
  it('stores each different request once, with no headers of the request and only harmless ones of the answer', async () => {
    const live: FetchLike = async (url) => (url.endsWith('/page') ? new Response('<p>hello</p>', { headers: { 'content-type': 'text/html', 'set-cookie': 'session=secret' } }) : json({ ok: true }));
    const tape = recording(live);
    await tape('https://api.example.com/a?api_key=live-key', { headers: { Authorization: 'Bearer live-token', 'X-RapidAPI-Key': 'live-key' } });
    await tape('https://api.example.com/a?api_key=live-key');
    await tape('https://www.example.com/page');
    expect(tape.exchanges).toEqual([
      { request: { method: 'GET', url: 'https://api.example.com/a?api_key=REDACTED' }, response: { status: 200, headers: { 'content-type': 'application/json' }, json: { ok: true } } },
      { request: { method: 'GET', url: 'https://www.example.com/page' }, response: { status: 200, headers: { 'content-type': 'text/html' }, text: '<p>hello</p>' } },
    ]);
    expect(JSON.stringify(tape.exchanges)).not.toMatch(/live-|secret/);
  });

  it('hands the caller the trimmed answer, so the recorded search is the replayed search', async () => {
    const tape = recording(async () => json({ jobs: [1, 2, 3] }), { json: (j) => ({ jobs: (j as { jobs: number[] }).jobs.slice(0, 1) }) });
    expect(await (await tape('https://api.example.com/a')).json()).toEqual({ jobs: [1] });
  });
});

describe('cutting a live answer down', () => {
  const posting = (title: string, extra: object = {}) => ({ title, ...extra });
  const many = [...Array.from({ length: 6 }, (_, i) => posting(`Software Engineer ${i}`)), posting('Recruiter'), posting('Sales Lead')];

  it('keeps a few postings that match the role and one that does not', () => {
    const cut = trimAnswer({ total: 8, jobs: many, facets: [{ id: 'kept as it is' }] }, ['jobs'], 'software engineer') as { total: number; jobs: { title: string }[]; facets: unknown };
    expect(cut.jobs.map((j) => j.title)).toEqual(['Software Engineer 0', 'Software Engineer 1', 'Software Engineer 2', 'Recruiter']);
    expect(cut.total).toBe(8);
    expect(cut.facets).toEqual([{ id: 'kept as it is' }]);
  });

  it('finds the list wherever the service puts it', () => {
    expect((trimAnswer(many, [], 'software engineer') as unknown[]).length).toBe(4);
    const nested = trimAnswer({ SearchResult: { SearchResultItems: many.map((m) => ({ MatchedObjectDescriptor: { PositionTitle: m.title } })) } }, ['SearchResult', 'SearchResultItems'], 'software engineer');
    expect((nested as { SearchResult: { SearchResultItems: unknown[] } }).SearchResult.SearchResultItems).toHaveLength(4);
    // An answer of another shape (one posting's detail) passes through.
    expect(trimAnswer({ jobAd: { sections: {} } }, ['content'], 'software engineer')).toEqual({ jobAd: { sections: {} } });
  });

  it('keeps rows that are not postings, like the notice Remote OK puts first', () => {
    const cut = trimAnswer([{ legal: 'notice' }, ...many], [], 'software engineer') as object[];
    expect(cut[0]).toEqual({ legal: 'notice' });
    expect(cut).toHaveLength(5);
  });

  it('shortens long descriptions and leaves short text alone', () => {
    const long = 'x'.repeat(4000);
    const cut = trimAnswer({ jobs: [posting('Software Engineer', { content: long, location: { name: 'Austin, TX' } })] }, ['jobs'], 'software engineer') as { jobs: { content: string; location: { name: string } }[] };
    expect(cut.jobs[0].content).toHaveLength(1501);
    expect(cut.jobs[0].content.endsWith('…')).toBe(true);
    expect(cut.jobs[0].location.name).toBe('Austin, TX');
  });
});

describe('recording a source', () => {
  const plan = sourceByName('remotive')!;
  const remotiveJob = (id: number, title: string) => ({ id, url: `https://remotive.com/remote-jobs/${id}`, title, company_name: 'Northwind', publication_date: '2026-11-12T08:15:41', description: '<p>Text</p>' });

  it('writes down the search, proves it replays, and marks where it came from', async () => {
    const live: FetchLike = async () => json({ jobs: [remotiveJob(1, 'Software Engineer'), remotiveJob(2, 'Senior Software Engineer'), remotiveJob(3, 'Designer')] });
    const made = await recordSource(plan, live, {});
    expect(made).toMatchObject({ source: 'remotive', origin: 'recorded', search: { query: { role: 'software engineer' } } });
    expect(made.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(made.exchanges).toHaveLength(1);
    const again = await plan.search(made.search.query, { fetch: replay(made), env: {} }, undefined);
    expect(again.map((j) => j.title)).toEqual(['Software Engineer', 'Senior Software Engineer']);
  });

  it('refuses to keep a search that found nothing', async () => {
    await expect(recordSource(plan, async () => json({ jobs: [remotiveJob(3, 'Designer')] }), {})).rejects.toThrow('returned no postings');
  });

  it('refuses to keep an answer the app could not show', async () => {
    const broken: FetchLike = async () => json({ jobs: [{ ...remotiveJob(1, 'Software Engineer'), url: 'not a web address' }] });
    await expect(recordSource(plan, broken, {})).rejects.toThrow("a listing's address is not a web address");
  });

  it('stores placeholders for the settings a source needs, never the real ones', async () => {
    const usajobs = sourceByName('usajobs')!;
    const item = { MatchedObjectId: '1', MatchedObjectDescriptor: { PositionTitle: 'IT Specialist', PositionURI: 'https://www.usajobs.gov/job/1', UserArea: { Details: { JobSummary: 'Summary' } } } };
    const made = await recordSource(usajobs, async () => json({ SearchResult: { SearchResultItems: [item] } }), { USAJOBS_API_KEY: 'live-key', USAJOBS_USER_AGENT: 'real.person@example.org' });
    expect(made.search.env).toEqual({ USAJOBS_API_KEY: 'REDACTED', USAJOBS_USER_AGENT: 'someone@example.com' });
    expect(JSON.stringify(made)).not.toMatch(/live-key|real\.person/);
  });

  it('has a cassette on file for every source in the table', () => {
    expect(SOURCES.map((s) => s.name)).toEqual(['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workday', 'amazon', 'remotive', 'remoteok', 'usajobs', 'jsearch', 'serpapi', 'linkedin']);
  });
});
