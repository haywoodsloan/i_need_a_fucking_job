import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserTier, wantsPage } from '../../server/src/browser';
import { createFetcher, isBotCheckPage, siteOf, type FetcherOptions, type FetchTier, type TierFailure } from '../../server/src/fetcher';
import { loadCustomTiers } from '../../server/src/tiers';
import { BlockedError } from '../../src/jobs/adapters/common';
import type { FetchLike } from '../../src/jobs/types';

/** A fetcher on a fake clock: sleeping just moves time forward, so nothing in these tests waits. */
function setup(net: FetchLike, opts: FetcherOptions = {}) {
  const clock = { t: 1_000_000 };
  const slept: number[] = [];
  const calls: string[] = [];
  const fetcher = createFetcher({
    fetch: async (url, init) => {
      calls.push(url);
      return net(url, init);
    },
    now: () => clock.t,
    sleep: async (ms) => {
      slept.push(ms);
      clock.t += ms;
    },
    ...opts,
  });
  return { fetcher, clock, slept, calls };
}

const html = (body: string, status: number, headers: Record<string, string> = {}) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });

describe('fetch layer: cache tier', () => {
  it('answers a repeated request from memory until it expires', async () => {
    const { fetcher, clock, calls } = setup(async () => Response.json({ jobs: [1, 2] }), { cacheMs: 60_000 });
    expect(await (await fetcher('https://boards-api.greenhouse.io/v1/boards/x/jobs')).json()).toEqual({ jobs: [1, 2] });
    expect(await (await fetcher('https://boards-api.greenhouse.io/v1/boards/x/jobs')).json()).toEqual({ jobs: [1, 2] });
    expect(calls).toHaveLength(1);
    expect(fetcher.stats()).toMatchObject({ requests: 1, cacheHits: 1, cacheEntries: 1 });
    clock.t += 60_001;
    await fetcher('https://boards-api.greenhouse.io/v1/boards/x/jobs');
    expect(calls).toHaveLength(2);
  });

  it('treats a POST body as part of the request, as Workday searches differ only by body', async () => {
    const { fetcher, calls } = setup(async (_u, init) => Response.json({ echo: init?.body }));
    const post = (body: string) => fetcher('https://x.wd1.myworkdayjobs.com/wday/cxs/x/y/jobs', { method: 'POST', body });
    await post('{"searchText":"a"}');
    await post('{"searchText":"b"}');
    expect(await (await post('{"searchText":"a"}')).json()).toEqual({ echo: '{"searchText":"a"}' });
    expect(calls).toHaveLength(2);
  });

  it('does not keep errors', async () => {
    const { fetcher, calls } = setup(async () => new Response('nope', { status: 404 }));
    expect((await fetcher('https://api.lever.co/v0/postings/x')).status).toBe(404);
    expect((await fetcher('https://api.lever.co/v0/postings/x')).status).toBe(404);
    expect(calls).toHaveLength(2);
  });

  it('makes room by dropping the oldest answers, and skips ones too large to keep', async () => {
    const { fetcher, calls } = setup(async (url) => new Response('x'.repeat(url.endsWith('/big') ? 60 : 40)), { cacheMaxBytes: 100 });
    await fetcher('https://a.example.com/1');
    await fetcher('https://a.example.com/2');
    await fetcher('https://a.example.com/3'); // 120 bytes held: /1 is dropped
    expect(fetcher.stats().cacheEntries).toBe(2);
    await fetcher('https://a.example.com/3');
    await fetcher('https://a.example.com/1');
    expect(calls.map((u) => u.slice(-1))).toEqual(['1', '2', '3', '1']);
    expect(await (await fetcher('https://a.example.com/big')).text()).toHaveLength(60); // over half the budget: served, not kept
    await fetcher('https://a.example.com/big');
    expect(calls.filter((u) => u.endsWith('/big'))).toHaveLength(2);
  });
});

describe('fetch layer: http tier', () => {
  it('retries a passing fault with backoff, then returns the answer', async () => {
    let n = 0;
    const { fetcher, slept, calls } = setup(async () => (++n < 3 ? new Response('busy', { status: 503 }) : Response.json({ ok: true })));
    expect(await (await fetcher('https://api.ashbyhq.com/posting-api/job-board/x')).json()).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
    expect(slept).toEqual([400, 800]);
    expect(fetcher.stats().retries).toBe(2);
  });

  it('retries a dropped connection, and gives the last answer back when retries run out', async () => {
    let n = 0;
    const flaky = setup(async () => {
      if (++n === 1) throw new TypeError('fetch failed');
      return Response.json({ ok: true });
    });
    expect((await flaky.fetcher('https://remoteok.com/api')).status).toBe(200);
    const down = setup(async () => new Response('down', { status: 502 }), { retries: 1 });
    expect((await down.fetcher('https://remoteok.com/api')).status).toBe(502);
    expect(down.calls).toHaveLength(2);
  });

  it('does not retry a plain refusal or a timeout', async () => {
    const notFound = setup(async () => new Response('', { status: 404 }));
    await notFound.fetcher('https://api.lever.co/v0/postings/x');
    expect(notFound.calls).toHaveLength(1);
    const slow = setup(async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    });
    await expect(slow.fetcher('https://api.lever.co/v0/postings/x')).rejects.toThrow('timed out');
    expect(slow.calls).toHaveLength(1);
  });

  it('comes back after a 429 only when the site says when, and soon', async () => {
    const bare = setup(async () => new Response('slow down', { status: 429 }));
    expect((await bare.fetcher('https://jsearch.p.rapidapi.com/search?query=x')).status).toBe(429);
    expect(bare.calls).toHaveLength(1);

    let n = 0;
    const told = setup(async () => (++n === 1 ? new Response('', { status: 429, headers: { 'retry-after': '2' } }) : Response.json({})));
    expect((await told.fetcher('https://jsearch.p.rapidapi.com/search?query=x')).status).toBe(200);
    expect(told.slept).toEqual([2000]);

    const later = setup(async () => new Response('', { status: 429, headers: { 'retry-after': '120' } }));
    expect((await later.fetcher('https://jsearch.p.rapidapi.com/search?query=x')).status).toBe(429);
    expect(later.calls).toHaveLength(1);
  });

  it('paces each site on its own: a few at a time, spaced out', async () => {
    let inFlight = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    const { fetcher, calls } = setup(
      async () => {
        peak = Math.max(peak, ++inFlight);
        await new Promise<void>((r) => release.push(r));
        inFlight--;
        return Response.json({});
      },
      { pace: { concurrency: 2, gapMs: 0 }, cacheMs: 0 },
    );
    const all = Promise.all([1, 2, 3, 4, 5].map((i) => fetcher(`https://boards-api.greenhouse.io/v1/boards/b${i}/jobs`)));
    const other = fetcher('https://api.lever.co/v0/postings/x'); // a different site is not held up
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 0));
      release.splice(0).forEach((go) => go());
    }
    await all;
    await other;
    expect(calls).toHaveLength(6);
    expect(peak).toBe(3); // two to greenhouse.io plus the one to lever.co
    expect(siteOf('https://boeing.wd1.myworkdayjobs.com/wday/cxs/boeing/x/jobs')).toBe('myworkdayjobs.com');
  });

  it('spaces LinkedIn requests out, one at a time', async () => {
    const { fetcher, slept } = setup(async () => new Response('<li></li>'), { cacheMs: 0 });
    await fetcher('https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?start=0');
    await fetcher('https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?start=10');
    expect(slept).toEqual([800]);
  });
});

describe('fetch layer: bot checks', () => {
  const url = 'https://www.indeed.com/jobs?q=engineer';

  it('reports a bot check as blocked: no retry, nothing cached', async () => {
    const challenge = setup(async () => html('<title>Just a moment...</title>', 403));
    await expect(challenge.fetcher(url)).rejects.toBeInstanceOf(BlockedError);
    await expect(challenge.fetcher(url)).rejects.toThrow('www.indeed.com turned this server away as automated traffic (403)');
    expect(challenge.calls).toHaveLength(2);
    expect(challenge.fetcher.stats()).toMatchObject({ blocked: 2, retries: 0, cacheEntries: 0 });

    const header = setup(async () => html('', 503, { 'cf-mitigated': 'challenge' }));
    await expect(header.fetcher(url)).rejects.toBeInstanceOf(BlockedError);
    expect(header.calls).toHaveLength(1);

    const linkedin = setup(async () => ({ ok: false, status: 999, headers: new Headers() }) as Response);
    await expect(linkedin.fetcher('https://www.linkedin.com/jobs-guest/x')).rejects.toBeInstanceOf(BlockedError);
  });

  it('leaves ordinary errors alone, with their body intact', async () => {
    const api = setup(async () => Response.json({ message: 'You are not subscribed to this API.' }, { status: 403 }));
    const res = await api.fetcher('https://jsearch.p.rapidapi.com/search?query=x');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: 'You are not subscribed to this API.' });
    const page = setup(async () => html('<h1>Forbidden</h1>', 403));
    expect(await (await page.fetcher(url)).text()).toBe('<h1>Forbidden</h1>');
  });

  it('recognises a bot check served with a 200 by its title, without misreading real pages', () => {
    expect(isBotCheckPage(200, '<html><head><title>Just a moment...</title>')).toBe(true);
    expect(isBotCheckPage(200, '<title>Security Check - Indeed.com</title>')).toBe(true);
    expect(isBotCheckPage(200, '<title>Access Denied</title>')).toBe(true);
    expect(isBotCheckPage(200, '<title>Security Checkpoint Officer - TSA</title><p>Solve CAPTCHAs all day</p>')).toBe(false);
    expect(isBotCheckPage(200, '<li><h3>Engineer</h3></li>')).toBe(false);
    expect(isBotCheckPage(503, '<p>Service unavailable</p>')).toBe(false);
  });
});

describe('fetch layer: pipeline of tiers', () => {
  const page = 'https://careers.example.com/jobs';
  const asPage = { headers: { Accept: 'text/html' } };
  /** A tier that records what it was handed and answers with `body`, passes, or throws. */
  const tier = (name: string, act: () => Response | undefined) => {
    const seen: { url: string; failures: TierFailure[] }[] = [];
    const t: FetchTier = {
      name,
      fetch: async ({ url, failures }) => {
        seen.push({ url, failures: [...failures] });
        return act();
      },
    };
    return { t, seen };
  };

  it('only moves on when the cheaper tier could not answer', async () => {
    const next = tier('next', () => html('<li>job</li>', 200));
    const fine = setup(async () => html('<li>from http</li>', 200), { tiers: [next.t] });
    expect(await (await fine.fetcher(page, asPage)).text()).toBe('<li>from http</li>');
    expect(next.seen).toHaveLength(0);
    // An error status is still an answer: a 404 from the source is not a reason to try something heavier.
    const missing = setup(async () => new Response('', { status: 404 }), { tiers: [next.t] });
    expect((await missing.fetcher(page, asPage)).status).toBe(404);
    expect(next.seen).toHaveLength(0);
    expect(fine.fetcher.tiers).toEqual(['cache', 'http', 'next']);
  });

  it('hands a failed request to the next tier with what went wrong, and caches its answer', async () => {
    const next = tier('next', () => html('<li>job</li>', 200));
    const { fetcher, calls } = setup(
      async () => {
        throw new TypeError('fetch failed');
      },
      { tiers: [next.t], retries: 0 },
    );
    expect(await (await fetcher(page, asPage)).text()).toBe('<li>job</li>');
    expect(await (await fetcher(page, asPage)).text()).toBe('<li>job</li>');
    expect(calls).toHaveLength(1);
    expect(next.seen).toHaveLength(1);
    expect(next.seen[0].failures).toMatchObject([{ tier: 'http', blocked: false }]);
    expect(next.seen[0].failures[0].error.message).toBe('fetch failed');
    expect(fetcher.stats()).toMatchObject({ cacheHits: 1, blocked: 0, answeredBy: { next: 1 } });
  });

  it('tells later tiers when an earlier one was turned away, and lets a tier pass', async () => {
    const passes = tier('passes', () => undefined);
    const last = tier('last', () => html('<li>job</li>', 200));
    const { fetcher } = setup(async () => html('<title>Just a moment...</title>', 403), { tiers: [passes.t, last.t] });
    expect((await fetcher(page, asPage)).status).toBe(200);
    expect(passes.seen[0].failures).toMatchObject([{ tier: 'http', blocked: true }]);
    expect(last.seen[0].failures.map((f) => f.tier)).toEqual(['http']); // passing is not a failure
  });

  it('reports blocked when no tier answers and one was turned away', async () => {
    const broken = tier('broken', () => {
      throw new Error('browser crashed');
    });
    const refused = setup(async () => html('<title>Just a moment...</title>', 403), { tiers: [broken.t] });
    await expect(refused.fetcher(page, asPage)).rejects.toBeInstanceOf(BlockedError);
    expect(refused.fetcher.stats().blocked).toBe(1);
    const down = setup(
      async () => {
        throw new TypeError('fetch failed');
      },
      { tiers: [broken.t], retries: 0 },
    );
    await expect(down.fetcher(page, asPage)).rejects.toThrow('browser crashed');
    expect(down.fetcher.stats().blocked).toBe(0);
  });

  it('does not try another tier for a search that was cancelled', async () => {
    const next = tier('next', () => html('<li>job</li>', 200));
    const ac = new AbortController();
    const { fetcher } = setup(
      async () => {
        ac.abort();
        throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      },
      { tiers: [next.t] },
    );
    await expect(fetcher(page, { ...asPage, signal: ac.signal })).rejects.toThrow('cancelled');
    expect(next.seen).toHaveLength(0);
  });
});

describe('fetch layer: browser tier', () => {
  const page = 'https://careers.example.com/jobs';
  const run = (load: Parameters<typeof browserTier>[0], init?: RequestInit) => browserTier(load).fetch({ url: page, init, failures: [] });
  const asPage = { headers: { Accept: 'text/html,application/xhtml+xml' } };

  it('takes page requests only, and leaves API calls to the other tiers', async () => {
    expect(wantsPage(asPage)).toBe(true);
    expect(wantsPage({ headers: new Headers({ accept: 'text/html' }) })).toBe(true);
    expect(wantsPage(undefined)).toBe(false);
    expect(wantsPage({ headers: { Accept: 'application/json' } })).toBe(false);
    expect(wantsPage({ method: 'POST', headers: { Accept: 'text/html' } })).toBe(false);
    let loads = 0;
    const load = async () => (loads++, { status: 200, html: '<li>job</li>' });
    expect(await run(load, { headers: { Accept: 'application/json' } })).toBeUndefined();
    expect(loads).toBe(0);
  });

  it('returns the rendered page', async () => {
    const res = await run(async () => ({ status: 200, html: '<html><title>Careers</title><li>job</li></html>' }), asPage);
    expect(res!.status).toBe(200);
    expect(res!.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res!.text()).toContain('<li>job</li>');
    expect((await run(async () => ({ status: 0, html: '' }), asPage))!.status).toBe(502);
  });

  it('stops at a bot check instead of returning it as a page', async () => {
    await expect(run(async () => ({ status: 403, html: '<title>Just a moment...</title>' }), asPage)).rejects.toBeInstanceOf(BlockedError);
    await expect(run(async () => ({ status: 200, html: '<title>Security Check - Indeed.com</title>' }), asPage)).rejects.toBeInstanceOf(BlockedError);
    await expect(run(async () => ({ status: 999, html: '' }), asPage)).rejects.toThrow('careers.example.com turned this server away as automated traffic (999)');
  });

  it('gets a page request after plain HTTP was turned away, and the source is blocked if it is turned away too', async () => {
    const served = setup(async () => html('<p>captcha</p>', 403), { tiers: [browserTier(async () => ({ status: 200, html: '<li>job</li>' }))] });
    expect(await (await served.fetcher(page, asPage)).text()).toBe('<li>job</li>');
    expect(served.fetcher.stats()).toMatchObject({ blocked: 0, answeredBy: { browser: 1 } });
    const refused = setup(async () => html('<p>captcha</p>', 403), { tiers: [browserTier(async () => ({ status: 403, html: '<title>Attention Required! | Cloudflare</title>' }))] });
    await expect(refused.fetcher(page, asPage)).rejects.toBeInstanceOf(BlockedError);
    expect(refused.fetcher.stats().blocked).toBe(1);
  });
});

describe('fetch layer: your own tiers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiers-'));
  const write = (name: string, source: string) => {
    writeFileSync(join(dir, name), source);
    return name;
  };

  it('is off unless FETCH_TIERS_MODULE is set', async () => {
    expect(await loadCustomTiers({}, dir)).toEqual([]);
    expect(await loadCustomTiers({ FETCH_TIERS_MODULE: '  ' }, dir)).toEqual([]);
  });

  it('loads tiers from a module, as a list or as a function of the environment', async () => {
    const list = write('list.mjs', `export const tiers = [{ name: 'mine', fetch: async () => new Response('from mine') }];`);
    const [mine] = await loadCustomTiers({ FETCH_TIERS_MODULE: list }, dir);
    expect(mine.name).toBe('mine');
    const { fetcher } = setup(
      async () => {
        throw new TypeError('fetch failed');
      },
      { tiers: [mine], retries: 0 },
    );
    expect(await (await fetcher('https://careers.example.com/jobs')).text()).toBe('from mine');

    const fn = write('fn.mjs', `export default (env) => [{ name: env.NAME, fetch: async () => undefined }];`);
    expect((await loadCustomTiers({ FETCH_TIERS_MODULE: fn, NAME: 'configured' }, dir)).map((t) => t.name)).toEqual(['configured']);
  });

  it('refuses a module that is missing, malformed or reuses a built-in name', async () => {
    await expect(loadCustomTiers({ FETCH_TIERS_MODULE: 'nope.mjs' }, dir)).rejects.toThrow(/FETCH_TIERS_MODULE: could not load/);
    await expect(loadCustomTiers({ FETCH_TIERS_MODULE: write('bad.mjs', `export const tiers = [{ name: 'x' }];`) }, dir)).rejects.toThrow(/must export `tiers`/);
    await expect(loadCustomTiers({ FETCH_TIERS_MODULE: write('clash.mjs', `export const tiers = [{ name: 'http', fetch: async () => undefined }];`) }, dir)).rejects.toThrow(/"http" is already used/);
    rmSync(dir, { recursive: true, force: true });
  });
});
