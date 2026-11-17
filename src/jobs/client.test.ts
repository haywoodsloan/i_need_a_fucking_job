// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BOARDS } from './boards';

/** The default is worked out once, when the module loads, so each case loads it afresh. */
async function load(o: { builtFor?: string; servedByServer?: boolean } = {}) {
  vi.resetModules();
  vi.stubEnv('VITE_API_URL', o.builtFor ?? '');
  document.head.innerHTML = o.servedByServer ? '<meta name="job-hunt-server" content="on" />' : '';
  return import('./client');
}

afterEach(() => {
  vi.unstubAllEnvs();
  document.head.innerHTML = '';
});

describe('the search server the app starts with', () => {
  it('is none for a copy on a static host, which searches from the browser', async () => {
    const { DEFAULT_API_URL, DEFAULT_SETTINGS } = await load();
    expect(DEFAULT_API_URL).toBe('');
    expect(DEFAULT_SETTINGS.apiUrl).toBe('');
  });

  it("is the page's own address when the search server served the page", async () => {
    const { DEFAULT_SETTINGS } = await load({ servedByServer: true });
    expect(DEFAULT_SETTINGS.apiUrl).toBe(window.location.origin);
    expect(DEFAULT_SETTINGS.apiUrl).toMatch(/^http:\/\/localhost(:\d+)?$/);
  });

  it('is the one named when the app was built, wherever the page came from', async () => {
    expect((await load({ builtFor: 'https://search.example.com' })).DEFAULT_API_URL).toBe('https://search.example.com');
    expect((await load({ builtFor: 'https://search.example.com', servedByServer: true })).DEFAULT_API_URL).toBe('https://search.example.com');
  });
});

/** Stands in for the browser's fetch, and keeps what was asked. */
function server(answer: (url: string) => Response) {
  const asked: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    asked.push({ url, init });
    return answer(url);
  });
  return asked;
}

describe('searching', () => {
  it('asks the search server when one is set, with the query and the settings but not the address', async () => {
    const { searchJobs, DEFAULT_SETTINGS } = await load();
    const found = { jobs: [], sources: [{ sourceId: 'usajobs', label: 'USAJOBS', ok: true, count: 0, ms: 12 }] };
    const asked = server(() => Response.json(found));
    const cancel = new AbortController();

    expect(await searchJobs({ role: 'pilot', location: 'Austin, TX' }, { ...DEFAULT_SETTINGS, apiUrl: 'http://localhost:8787/' }, cancel.signal)).toEqual(found);

    expect(asked).toHaveLength(1);
    expect(asked[0].url).toBe('http://localhost:8787/api/search');
    expect(asked[0].init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: cancel.signal });
    expect(JSON.parse(asked[0].init!.body as string)).toEqual({
      query: { role: 'pilot', location: 'Austin, TX' },
      settings: { boards: DEFAULT_BOARDS, companies: [], industries: [], allowScraping: false },
    });
  });

  it("fails with the server's own words, or with its status when it gave none", async () => {
    const { searchJobs, DEFAULT_SETTINGS } = await load();
    const settings = { ...DEFAULT_SETTINGS, apiUrl: 'http://localhost:8787' };

    server(() => Response.json({ error: 'Too many searches. Try again in a few minutes.' }, { status: 429 }));
    await expect(searchJobs({ role: 'pilot' }, settings)).rejects.toThrow('Too many searches. Try again in a few minutes.');

    server(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    await expect(searchJobs({ role: 'pilot' }, settings)).rejects.toThrow('Search server answered 502');
  });

  it('searches from the browser when no server is set, using only the sources a browser can reach', async () => {
    const { searchJobs, DEFAULT_SETTINGS } = await load();
    const asked = server(() =>
      Response.json({ jobs: [{ id: 7, url: 'https://remotive.com/remote-jobs/7', title: 'Senior Pilot Trainer', company_name: 'Acme Air' }] }),
    );

    const out = await searchJobs({ role: 'pilot' }, { ...DEFAULT_SETTINGS, apiUrl: '', boards: ['remote-boards', 'usajobs'] });

    expect(asked.map((a) => a.url)).toEqual(['https://remotive.com/api/remote-jobs?search=pilot&limit=50']);
    expect(out.jobs.map((j) => j.id)).toEqual(['remotive:7']);
    const status = Object.fromEntries(out.sources.map((s) => [s.sourceId, s.skipped ?? (s.ok ? 'ok' : s.error)]));
    expect(status).toEqual({ 'google-jobs': 'runs on the backend', usajobs: 'runs on the backend', remotive: 'ok', remoteok: 'runs on the backend' });
  });
});

describe('the full description of a posting', () => {
  it('is asked of the search server by the id of the posting', async () => {
    const { fetchJobDetail } = await load();
    const asked = server(() => Response.json({ descriptionText: 'Fly planes.' }));
    expect(await fetchJobDetail('workday:acme:/job/Austin TX/Pilot_R-1', 'http://localhost:8787/')).toEqual({ descriptionText: 'Fly planes.' });
    expect(asked[0].url).toBe('http://localhost:8787/api/job?id=workday%3Aacme%3A%2Fjob%2FAustin%20TX%2FPilot_R-1');
  });

  it("fails with the server's own words, or with its status when it gave none", async () => {
    const { fetchJobDetail } = await load();
    server(() => Response.json({ error: 'LinkedIn route is disabled on this server' }, { status: 500 }));
    await expect(fetchJobDetail('linkedin:1', 'http://localhost:8787')).rejects.toThrow('LinkedIn route is disabled on this server');
    server(() => new Response('', { status: 404 }));
    await expect(fetchJobDetail('linkedin:1', 'http://localhost:8787')).rejects.toThrow('Server answered 404');
  });
});

describe('asking a search server what it can do', () => {
  it('returns what the server says about itself', async () => {
    const { fetchHealth } = await load();
    const health = { ok: true, sources: { googleJobs: null, usajobs: false, linkedinGuest: false, playwright: false } };
    const asked = server(() => Response.json(health));
    expect(await fetchHealth('http://localhost:8787/')).toEqual(health);
    expect(asked[0].url).toBe('http://localhost:8787/api/health');
    // The settings panel must not hang on a server that never answers.
    expect(asked[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('fails when the address is not a search server', async () => {
    const { fetchHealth } = await load();
    server(() => new Response('Not found', { status: 404 }));
    await expect(fetchHealth('http://localhost:8787')).rejects.toThrow('Server answered 404');
  });
});
