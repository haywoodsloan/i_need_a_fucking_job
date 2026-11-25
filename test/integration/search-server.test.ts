/**
 * The search server over real HTTP on this machine: a request comes in, is checked, fans out to the job sources
 * through the real fetch pipeline, and the merged answer goes back. Only the job sites themselves are stand-ins
 * (the cassettes in test/fixtures/sources/).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { BoardOpts } from '../../src/jobs/adapters/ats';
import type { JobPosting, SearchResponse, SearchSettings } from '../../src/jobs/types';
import { loadCassette, replay, type Cassette, type Replay } from '../helpers/cassette';
import { startTestServer, type TestServer, type TestServerOptions } from '../helpers/server';

const greenhouse = loadCassette('greenhouse');
const remotive = loadCassette('remotive');
const remoteok = loadCassette('remoteok');
const usajobs = loadCassette('usajobs');
const openwebninja = loadCassette('openwebninja');
const smartrecruiters = loadCassette('smartrecruiters');

const employer = greenhouse.search.options as BoardOpts;
const query = greenhouse.search.query;
const noBoards: SearchSettings = { boards: [], companies: [], industries: [], allowScraping: false };
const remoteBoards: SearchSettings = { ...noBoards, boards: ['remote-boards'] };

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(o: Partial<TestServerOptions> & { cassettes?: Cassette[] } = {}): Promise<{ s: TestServer; net: Replay }> {
  const net = replay(...(o.cassettes ?? [remotive, remoteok]));
  server = await startTestServer({ network: net, ...o });
  return { s: server, net };
}

describe('searching', () => {
  it('runs every chosen source and returns one merged, newest-first list with a status per source', async () => {
    const { s, net } = await start({
      cassettes: [greenhouse, remotive, remoteok, usajobs, openwebninja],
      env: { ...usajobs.search.env, ...openwebninja.search.env },
      // The typed company is found on Greenhouse. Finding it is tested on its own in test/server/discover.test.ts.
      discover: async (name) => (name === employer.company ? { platform: 'greenhouse', board: employer.board } : undefined),
    });
    const settings: SearchSettings = { boards: ['linkedin', 'indeed', 'glassdoor', 'company-sites', 'usajobs', 'remote-boards'], companies: [`custom:${employer.company}`], industries: [], allowScraping: false };

    const reply = await s.post('/api/search', { query, settings });

    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('application/json; charset=utf-8');
    const { jobs, sources } = reply.json<SearchResponse>();
    expect(sources.map((x) => [x.sourceId, x.ok])).toEqual([
      ['google-jobs', true],
      ['usajobs', true],
      ['remotive', true],
      ['remoteok', true],
      [`company:${employer.company.toLowerCase().replace(/[^a-z0-9]/g, '')}`, true],
    ]);
    for (const source of sources) expect(source.count, source.label).toBeGreaterThan(0);
    // Merging can only fold postings together, never invent or lose one.
    const found = sources.reduce((n, x) => n + x.count, 0);
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.length).toBeLessThanOrEqual(found);
    expect(jobs.reduce((n, j) => n + j.listings.length, 0)).toBeLessThanOrEqual(found * 3);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
    const dates = jobs.map((j) => j.postedAt ?? '');
    expect(dates).toEqual([...dates].sort().reverse());
    expect(net.unused()).toEqual([]);
    expect(s.errors).toEqual([]);
  });

  it('shows the same job found on two boards once, listed on both', async () => {
    const twoBoards: Cassette = {
      ...remotive,
      exchanges: [
        {
          request: remotive.exchanges[0].request,
          response: { status: 200, json: { jobs: [{ id: 1, title: 'Software Engineer', company_name: 'Northwind Robotics', url: 'https://remotive.com/remote-jobs/1', publication_date: '2026-11-12T08:15:41', description: '<p>Short.</p>' }] } },
        },
        {
          request: remoteok.exchanges[0].request,
          response: {
            status: 200,
            json: [{ legal: 'notice' }, { id: '77', position: 'Software Engineer', company: 'Northwind Robotics, Inc.', date: '2026-11-13T00:00:00+00:00', url: 'https://remoteok.com/remote-jobs/77', description: 'A longer description of the same job, from Remote OK.' }],
          },
        },
      ],
    };
    const { s } = await start({ cassettes: [twoBoards] });
    const { jobs } = (await s.post('/api/search', { query, settings: remoteBoards })).json<SearchResponse>();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].listings.map((l) => l.via)).toEqual(['Remotive', 'Remote OK']);
    expect(jobs[0].descriptionText).toBe('A longer description of the same job, from Remote OK.');
  });

  it('answers a repeated search from memory, and asks the sources again once the answer is old', async () => {
    const { s, net } = await start({ env: { CACHE_SECONDS: '600' }, fetcher: { cacheMs: 0 } });
    const first = await s.post('/api/search', { query, settings: remoteBoards });
    const asked = net.calls.length;
    expect(asked).toBeGreaterThan(0);

    const again = await s.post('/api/search', { query, settings: remoteBoards });
    expect(again.text).toBe(first.text);
    expect(net.calls).toHaveLength(asked);

    // A different search is not the same answer.
    await s.post('/api/search', { query: { ...query, role: 'engineer' }, settings: remoteBoards }).catch(() => {});
    const afterOther = net.calls.length;
    expect(afterOther).toBeGreaterThan(asked);

    s.advance(601_000);
    await s.post('/api/search', { query, settings: remoteBoards });
    expect(net.calls.length).toBeGreaterThan(afterOther);
  });

  it('does not keep an answer in which every source failed', async () => {
    let up = false;
    const { s } = await start({ fetcher: { cacheMs: 0 }, network: async (url, init) => (up ? replay(remotive, remoteok)(url, init) : new Response('down', { status: 500 })) });
    const ran = (r: SearchResponse) => r.sources.filter((x) => !x.skipped).map((x) => [x.sourceId, x.ok, x.error]);
    const failed = (await s.post('/api/search', { query, settings: remoteBoards })).json<SearchResponse>();
    expect(ran(failed)).toEqual([
      ['remotive', false, 'remotive.com answered 500'],
      ['remoteok', false, 'remoteok.com answered 500'],
    ]);
    up = true;
    const worked = (await s.post('/api/search', { query, settings: remoteBoards })).json<SearchResponse>();
    expect(ran(worked)).toEqual([
      ['remotive', true, undefined],
      ['remoteok', true, undefined],
    ]);
  });

  it('reports a source that turned the server away as blocked, and still returns the others', async () => {
    const challenge = '<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>';
    const net = replay(remotive);
    const { s } = await start({ network: async (url, init) => (url.startsWith('https://remoteok.com/') ? new Response(challenge, { status: 403, headers: { 'content-type': 'text/html' } }) : net(url, init)) });
    const { jobs, sources } = (await s.post('/api/search', { query, settings: remoteBoards })).json<SearchResponse>();
    expect(sources.find((x) => x.sourceId === 'remoteok')).toMatchObject({ ok: false, blocked: true, count: 0, error: 'remoteok.com turned this server away as automated traffic (403)' });
    expect(sources.find((x) => x.sourceId === 'remotive')).toMatchObject({ ok: true });
    expect(jobs.length).toBeGreaterThan(0);
    expect((await s.get('/api/health')).json<{ fetch: { blocked: number } }>().fetch.blocked).toBe(1);
  });

  it('says in plain words why Google for Jobs turned the search down, and still returns the other sources', async () => {
    const others = replay(remotive, remoteok);
    const asked: { url: string; key: string | null }[] = [];
    const { s } = await start({
      env: { OPENWEBNINJA_API_KEY: 'ninja-key-123' },
      // With the retries a real server makes, to show that this is not one of the answers it tries again.
      fetcher: { retries: 2 },
      network: async (url, init) => {
        if (!url.startsWith('https://api.openwebninja.com/')) return others(url, init);
        asked.push({ url, key: new Headers(init?.headers).get('x-api-key') });
        // What the service answers to a key it does not know.
        return Response.json({ message: 'Unauthorized' }, { status: 401 });
      },
    });
    const reply = await s.post('/api/search', { query, settings: { ...noBoards, boards: ['linkedin', 'remote-boards'] } });
    const { jobs, sources } = reply.json<SearchResponse>();
    const google = sources.find((x) => x.sourceId === 'google-jobs');
    expect(google).toMatchObject({
      label: 'Google for Jobs (JSearch, OpenWeb Ninja)',
      ok: false,
      count: 0,
      error:
        'api.openwebninja.com answered 401 (Unauthorized): it did not accept the key in OPENWEBNINJA_API_KEY. ' +
        'Check the key, that its account has a plan for JSearch (the free one counts), and that the plan has requests left this month.',
    });
    // A key that is turned down is not a bot check.
    expect(google?.blocked).toBeUndefined();
    expect(jobs.length).toBeGreaterThan(0);

    // It was asked once: a refusal is not tried again. The key went in a header, and the server tells it to nobody.
    expect(asked).toHaveLength(1);
    expect(asked[0].key).toBe('ninja-key-123');
    expect(asked[0].url).toContain('/jsearch/search-v2?');
    expect(asked[0].url).not.toContain('ninja-key-123');
    const health = await s.get('/api/health');
    expect(health.json<{ sources: { googleJobs: string } }>().sources.googleJobs).toBe('Google for Jobs (JSearch, OpenWeb Ninja)');
    expect(reply.text + health.text).not.toContain('ninja-key-123');
    expect(s.errors).toEqual([]);
  });

  it('says which sources were left out, and why, when the server has no key for them', async () => {
    const { s, net } = await start();
    const { jobs, sources } = (await s.post('/api/search', { query, settings: { ...noBoards, boards: ['linkedin', 'usajobs'], companies: ['custom:Somewhere'] } })).json<SearchResponse>();
    expect(jobs).toEqual([]);
    expect(sources).toMatchObject([
      { sourceId: 'google-jobs', ok: false, skipped: 'needs OPENWEBNINJA_API_KEY, JSEARCH_API_KEY or SERPAPI_KEY on the server' },
      { sourceId: 'usajobs', ok: false, skipped: 'needs USAJOBS_API_KEY, USAJOBS_USER_AGENT on the server' },
      { sourceId: 'company:somewhere', ok: false, error: 'needs OPENWEBNINJA_API_KEY, JSEARCH_API_KEY or SERPAPI_KEY on the server' },
    ]);
    // Looking the company up was tried on every hiring system, and nothing else was asked.
    expect(net.calls.every((c) => /greenhouse|lever|ashby|smartrecruiters/.test(c.url))).toBe(true);
  });

  it('leaves the direct site routes off unless both the search and the server ask for them', async () => {
    const linkedin = loadCassette('linkedin');
    const settings: SearchSettings = { ...noBoards, boards: ['linkedin'] };
    const { s, net } = await start({ cassettes: [linkedin], env: linkedin.search.env });
    const off = (await s.post('/api/search', { query, settings })).json<SearchResponse>();
    expect(off.sources.map((x) => x.sourceId)).toEqual(['google-jobs']);
    expect(net.calls).toEqual([]);

    const on = (await s.post('/api/search', { query, settings: { ...settings, allowScraping: true } })).json<SearchResponse>();
    expect(on.sources.map((x) => [x.sourceId, x.ok])).toEqual([
      ['google-jobs', false],
      ['linkedin-guest', true],
    ]);
    expect(on.jobs.every((j: JobPosting) => j.descriptionPartial)).toBe(true);
  });
});

describe('what the server refuses', () => {
  it.each([
    ['text that is not JSON', '{"query": '],
    ['an empty body', ''],
    ['JSON that is not an object', 'null'],
    ['no role', JSON.stringify({ query: { role: '   ' }, settings: remoteBoards })],
    ['a role that is not text', JSON.stringify({ query: { role: 7 }, settings: remoteBoards })],
    ['a role of 200 characters', JSON.stringify({ query: { role: 'x'.repeat(200) }, settings: remoteBoards })],
    ['no settings', JSON.stringify({ query })],
    ['settings without lists', JSON.stringify({ query, settings: { boards: 'all', companies: [], industries: [] } })],
    ['more than 60 companies', JSON.stringify({ query, settings: { ...remoteBoards, companies: Array.from({ length: 61 }, (_, i) => `custom:c${i}`) } })],
  ])('a search with %s, as the caller\'s mistake', async (_what, body) => {
    const { s, net } = await start();
    const reply = await s.post('/api/search', body);
    expect([reply.status, reply.json()]).toEqual([400, { error: 'Invalid search' }]);
    expect(net.calls).toEqual([]);
    expect(s.errors).toEqual([]);
  });

  it('a body too large to be a search', async () => {
    const { s } = await start();
    const reply = await s.post('/api/search', JSON.stringify({ query, settings: remoteBoards, padding: 'x'.repeat(20_000) }));
    expect([reply.status, reply.json()]).toEqual([413, { error: 'Request body too large' }]);
  });

  it('more searches from one address than the limit allows, until the five minutes have passed', async () => {
    const { s } = await start({ env: { RATE_LIMIT_PER_5MIN: '2' } });
    const search = (from?: string) => s.post('/api/search', { query, settings: remoteBoards }, from ? { 'X-Forwarded-For': from } : {});
    expect((await search()).status).toBe(200);
    expect((await search()).status).toBe(200);
    const third = await search();
    expect([third.status, third.json()]).toEqual([429, { error: 'Too many searches, try again in a few minutes' }]);
    // Another address has its own count.
    expect((await search('203.0.113.9, 10.0.0.1')).status).toBe(200);
    expect((await search('203.0.113.9')).status).toBe(200);
    expect((await search('203.0.113.9')).status).toBe(429);

    s.advance(5 * 60_000 + 1);
    expect((await search()).status).toBe(200);
  });

  it('anything it has no route for', async () => {
    const { s } = await start();
    expect([(await s.get('/api/nope')).status, (await s.get('/api/search')).status, (await s.send('DELETE', '/api/job?id=x')).status]).toEqual([404, 404, 404]);
    expect((await s.get('/somewhere')).json()).toEqual({ error: 'Not found' });
  });
});

describe('the other routes', () => {
  it('health says what this server can search', async () => {
    const { s } = await start({ env: { SERPAPI_KEY: 'k', USAJOBS_API_KEY: 'k', USAJOBS_USER_AGENT: 'someone@example.com', ENABLE_LINKEDIN_GUEST: '1' } });
    expect((await s.get('/api/health')).json()).toEqual({
      ok: true,
      sources: { googleJobs: 'Google for Jobs (SerpAPI)', usajobs: true, linkedinGuest: true, playwright: false },
      tiers: ['cache', 'http'],
      fetch: { requests: 0, cacheHits: 0, retries: 0, blocked: 0, answeredBy: {}, cacheEntries: 0, cacheMb: 0 },
      accounts: false,
      applications: false,
    });
  });

  it('health says how the requests to job sources have gone, and what a bare server lacks', async () => {
    const { s } = await start();
    await s.post('/api/search', { query, settings: remoteBoards });
    const health = (await s.get('/api/health')).json<{ sources: object; fetch: object }>();
    expect(health.sources).toEqual({ googleJobs: null, usajobs: false, linkedinGuest: false, playwright: false });
    expect(health.fetch).toMatchObject({ requests: 2, cacheHits: 0, retries: 0, blocked: 0, answeredBy: { http: 2 }, cacheEntries: 2 });
  });

  it('loads the full description of a posting that came with a summary only', async () => {
    const { s } = await start({ cassettes: [smartrecruiters] });
    const board = (smartrecruiters.search.options as BoardOpts).board;
    const id = smartrecruiters.exchanges[1].request.url.split('/').pop()!;
    const reply = await s.get(`/api/job?id=${encodeURIComponent(`smartrecruiters:${board}:${id}`)}`);
    expect(reply.status).toBe(200);
    const detail = reply.json<{ descriptionHtml: string; descriptionText: string }>();
    expect(detail.descriptionHtml).toContain('<h3>');
    expect(detail.descriptionText.length).toBeGreaterThan(20);
    expect((await s.get('/api/job')).json()).toEqual({ error: 'Missing id' });
  });

  it('keeps a source that is switched off from being reached through a posting id', async () => {
    const { s, net } = await start();
    const reply = await s.get('/api/job?id=linkedin:4100000001');
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(reply.json()).toEqual({ error: 'LinkedIn route is disabled on this server' });
    expect(net.calls).toEqual([]);
  });

  it('tells the app that accounts are off when this server has none', async () => {
    const { s } = await start();
    expect((await s.get('/api/auth/session')).json()).toEqual({ available: false, user: null });
  });

  it('logs a fault and answers 500 with its message', async () => {
    const { s } = await start({ detail: async () => Promise.reject(new Error('the source fell over')) });
    const reply = await s.get('/api/job?id=workday:x:y');
    expect([reply.status, reply.json()]).toEqual([500, { error: 'the source fell over' }]);
    expect(s.errors).toHaveLength(1);
  });
});

describe('who may call it', () => {
  const origin = { Origin: 'https://app.example.com' };

  it('lets any site call the search routes when no origins are named', async () => {
    const { s } = await start();
    const reply = await s.get('/api/health', origin);
    expect(reply.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(reply.headers.vary).toBe('Origin');
    expect((await s.get('/api/health')).headers['access-control-allow-origin']).toBeUndefined();
  });

  it('lets only the named origins call it once some are named', async () => {
    const { s } = await start({ env: { ALLOWED_ORIGINS: 'https://app.example.com, https://other.example.com' } });
    expect((await s.get('/api/health', origin)).headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect((await s.get('/api/health', { Origin: 'https://evil.example.com' })).headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers a browser\'s preflight question without running anything', async () => {
    const { s, net } = await start();
    const reply = await s.send('OPTIONS', '/api/search', undefined, origin);
    expect([reply.status, reply.text]).toEqual([204, '']);
    expect(reply.headers).toMatchObject({ 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'Content-Type', 'access-control-max-age': '86400' });
    expect(net.calls).toEqual([]);
  });
});

describe('with accounts and the built app plugged in', () => {
  const accounts = {
    owns: (path: string) => path.startsWith('/api/auth/') || path.startsWith('/api/account/'),
    handle: async (req: { url?: string }, res: { writeHead(status: number, headers: object): { end(body: string): void } }) => {
      if (req.url === '/api/account/broken') throw new Error('database is gone');
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"from":"accounts"}');
    },
  };
  const builtApp = {
    handle: (_req: unknown, res: { writeHead(status: number, headers: object): { end(body: string): void } }, path: string) => {
      if (path !== '/' && path !== '/assets/app.js') return false;
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(`file ${path}`);
      return true;
    },
  };

  it('hands account routes to accounts first, without the headers that let other sites call them', async () => {
    const { s } = await start({ accounts: accounts as never, builtApp: builtApp as never });
    const reply = await s.get('/api/auth/session', { Origin: 'https://evil.example.com' });
    expect(reply.json()).toEqual({ from: 'accounts' });
    expect(reply.headers['access-control-allow-origin']).toBeUndefined();
    expect((await s.get('/api/health')).json<{ accounts: boolean }>().accounts).toBe(true);
  });

  it('keeps what went wrong inside accounts to itself', async () => {
    const { s } = await start({ accounts: accounts as never });
    const reply = await s.get('/api/account/broken');
    expect([reply.status, reply.json()]).toEqual([500, { error: 'Something went wrong on the server.' }]);
    expect(String(s.errors[0])).toContain('database is gone');
  });

  it('serves the app for everything that is not an API route, and never in place of one', async () => {
    const { s } = await start({ builtApp: builtApp as never });
    expect((await s.get('/')).text).toBe('file /');
    expect((await s.get('/assets/app.js?v=1')).text).toBe('file /assets/app.js');
    expect((await s.get('/missing.js')).status).toBe(404);
    expect((await s.get('/api/health')).json<{ ok: boolean }>().ok).toBe(true);
  });
});
