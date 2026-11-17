/** Putting the fetch pipeline together from the server's settings (server/src/tiers.ts). */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildPipeline } from '../../server/src/tiers';

const dir = mkdtempSync(join(tmpdir(), 'pipeline-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

describe('the fetch pipeline a server starts with', () => {
  it('is the cache and plain requests, and nothing else, unless more is switched on', async () => {
    const pipeline = await buildPipeline({});
    expect(pipeline.fetch.tiers).toEqual(['cache', 'http']);
    await expect(pipeline.close()).resolves.toBeUndefined();
  });

  it('adds the browser tier when asked, without starting a browser until a page needs one', async () => {
    const pipeline = await buildPipeline({ ENABLE_BROWSER_TIER: '1' });
    expect(pipeline.fetch.tiers).toEqual(['cache', 'http', 'browser']);
    // Closing a browser that was never started is not an error.
    await expect(pipeline.close()).resolves.toBeUndefined();
  });

  it('puts your own tiers last, after the built-in ones', async () => {
    const file = join(dir, 'mine.mjs');
    writeFileSync(file, `export const tiers = [{ name: 'mine', fetch: async () => new Response('from mine', { headers: { 'content-type': 'text/plain' } }) }];`);
    const pipeline = await buildPipeline({ ENABLE_BROWSER_TIER: '1', FETCH_TIERS_MODULE: file });
    expect(pipeline.fetch.tiers).toEqual(['cache', 'http', 'browser', 'mine']);
    await pipeline.close();
  });

  it('refuses to start with a tier module that cannot be loaded', async () => {
    await expect(buildPipeline({ FETCH_TIERS_MODULE: join(dir, 'missing.mjs') })).rejects.toThrow('FETCH_TIERS_MODULE: could not load');
  });

  it('keeps answers for as long as CACHE_SECONDS says, and not at all when it is 0', async () => {
    let served = 0;
    const answer = async () => {
      served++;
      return new Response('{"jobs":[]}', { headers: { 'content-type': 'application/json' } });
    };
    // The pipeline is built for the real network, which the tests may not use. Stand in for it.
    vi.stubGlobal('fetch', answer);

    const kept = await buildPipeline({ CACHE_SECONDS: '600' });
    await kept.fetch('https://api.example.com/jobs');
    await kept.fetch('https://api.example.com/jobs');
    expect(served).toBe(1);
    expect(kept.fetch.stats()).toMatchObject({ requests: 1, cacheHits: 1 });

    const fresh = await buildPipeline({ CACHE_SECONDS: '0' });
    await fresh.fetch('https://api.example.com/jobs');
    await fresh.fetch('https://api.example.com/jobs');
    expect(served).toBe(3);
  });
});
