/** Finding which hiring system a typed company uses, by asking each one about a few guesses at its board id. */
import { describe, expect, it } from 'vitest';
import { PROBES, makeDiscover, probeBoard, probeWorkday } from '../../server/src/discover';
import type { FetchLike } from '../../src/jobs/types';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A network where only the listed addresses exist. Everything else is a 404, as the real services answer. */
function network(known: Record<string, unknown>) {
  const asked: string[] = [];
  const fetch: FetchLike = async (url) => {
    asked.push(url);
    return url in known ? json(known[url]) : json({ error: 'not found' }, 404);
  };
  return { fetch, asked };
}

const DAY = 86_400_000;

describe('looking a company up', () => {
  it('tries each guess at the board id on every hiring system and takes the first that answers', async () => {
    const { fetch, asked } = network({ 'https://api.lever.co/v0/postings/acme-robotics?mode=json&limit=1': [{ id: 'x' }] });
    expect(await makeDiscover(fetch)('Acme Robotics, Inc.')).toEqual({ platform: 'lever', board: 'acme-robotics' });
    // "acmerobotics" was tried on all four systems first, then "acme-robotics". The later guesses were not needed.
    expect(asked).toHaveLength(8);
    expect(asked.slice(0, 4).every((u) => u.includes('acmerobotics'))).toBe(true);
    expect(asked.some((u) => u.includes('/acme/') || u.includes('acme_robotics'))).toBe(false);
  });

  it('prefers the systems in a fixed order when a guess exists on more than one', async () => {
    const { fetch } = network({
      'https://api.ashbyhq.com/posting-api/job-board/acme': { jobs: [] },
      'https://boards-api.greenhouse.io/v1/boards/acme/jobs': { jobs: [{ id: 1 }] },
    });
    expect(await makeDiscover(fetch)('Acme')).toEqual({ platform: 'greenhouse', board: 'acme' });
  });

  it('does not take an answer that only looks like a board', async () => {
    const { fetch } = network({
      // SmartRecruiters answers 200 with nothing for a company it has never heard of.
      'https://api.smartrecruiters.com/v1/companies/acme/postings?limit=1': { totalFound: 0, content: [] },
      'https://api.lever.co/v0/postings/acme?mode=json&limit=1': [],
      'https://boards-api.greenhouse.io/v1/boards/acme/jobs': { error: 'not what was asked for' },
    });
    expect(await makeDiscover(fetch)('Acme')).toBeUndefined();
  });

  it('finds nothing, without failing, when every system is unreachable', async () => {
    const down: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await makeDiscover(down)('Acme')).toBeUndefined();
    expect(await makeDiscover(down)('  ')).toBeUndefined();
  });

  it('remembers what it found, and what it did not, for a day', async () => {
    let clock = 1_000_000;
    const { fetch, asked } = network({ 'https://boards-api.greenhouse.io/v1/boards/acme/jobs': { jobs: [] } });
    const discover = makeDiscover(fetch, () => clock);

    expect(await discover('Acme')).toEqual({ platform: 'greenhouse', board: 'acme' });
    const afterFirst = asked.length;
    expect(await discover(' ACME ')).toEqual({ platform: 'greenhouse', board: 'acme' });
    expect(asked).toHaveLength(afterFirst);

    expect(await discover('Nobody Here')).toBeUndefined();
    const afterMiss = asked.length;
    expect(await discover('nobody here')).toBeUndefined();
    expect(asked).toHaveLength(afterMiss);

    clock += DAY + 1;
    await discover('Acme');
    expect(asked.length).toBeGreaterThan(afterMiss);
  });

  it('keeps what one server looked up apart from another', async () => {
    const a = network({ 'https://boards-api.greenhouse.io/v1/boards/acme/jobs': { jobs: [] } });
    const b = network({});
    expect(await makeDiscover(a.fetch)('Acme')).toBeDefined();
    expect(await makeDiscover(b.fetch)('Acme')).toBeUndefined();
    expect(b.asked.length).toBeGreaterThan(0);
  });
});

describe('checking a board id from the catalog', () => {
  it('has one probe for each hiring system that serves a public feed', () => {
    expect(PROBES.map((p) => p.platform)).toEqual(['greenhouse', 'lever', 'ashby', 'smartrecruiters']);
  });

  it('passes a board that answers with postings', async () => {
    const { fetch, asked } = network({ 'https://api.smartrecruiters.com/v1/companies/Acme%20Co/postings?limit=1': { totalFound: 12 } });
    await expect(probeBoard(fetch, 'smartrecruiters', 'Acme Co')).resolves.toBeUndefined();
    expect(asked).toEqual(['https://api.smartrecruiters.com/v1/companies/Acme%20Co/postings?limit=1']);
  });

  it('says why a board is no good', async () => {
    const { fetch } = network({ 'https://api.lever.co/v0/postings/empty?mode=json&limit=1': [] });
    await expect(probeBoard(fetch, 'lever', 'gone')).rejects.toThrow('answered 404');
    await expect(probeBoard(fetch, 'lever', 'empty')).rejects.toThrow('no postings');
  });

  it('counts the open postings on a Workday site, and fails for a wrong or empty one', async () => {
    const board = { host: 'acme.wd1.myworkdayjobs.com', tenant: 'acme', site: 'Careers' };
    const requests: { url: string; init?: RequestInit }[] = [];
    const answer = (body: unknown, status = 200): FetchLike => async (url, init) => {
      requests.push({ url, init });
      return json(body, status);
    };
    expect(await probeWorkday(answer({ total: 42 }), board)).toBe(42);
    expect(requests[0].url).toBe('https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Careers/jobs');
    expect(requests[0].init).toMatchObject({ method: 'POST', body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: '' }) });
    await expect(probeWorkday(answer({}, 422), board)).rejects.toThrow('answered 422');
    await expect(probeWorkday(answer({ total: 0 }), board)).rejects.toThrow('no postings');
  });
});
