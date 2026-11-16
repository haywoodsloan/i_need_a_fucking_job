import { describe, expect, it } from 'vitest';
import { createFetcher, siteOf, type FetcherOptions } from '../server/src/fetcher';
import { BlockedError } from '../src/jobs/adapters/common';
import type { FetchLike } from '../src/jobs/types';

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
});
