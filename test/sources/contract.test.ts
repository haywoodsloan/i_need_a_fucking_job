/**
 * Every job source, run end to end against a stored answer from its service (test/fixtures/sources/).
 *
 * These checks hold for any honest answer, so they still pass after a cassette is recorded again from the live
 * service. What a source does with one odd field belongs in a unit test with a small inline sample
 * (src/jobs/jobs.test.ts), not here.
 */
import { describe, expect, it } from 'vitest';
import { loadCassette, replay } from '../helpers/cassette';
import { SOURCES, postingProblems } from '../helpers/sources';

const roleWords = (role: string) => role.toLowerCase().split(/\s+/).filter(Boolean);

describe.each(SOURCES)('the $name source', (plan) => {
  const cassette = loadCassette(plan.name);
  const { query, options } = cassette.search;
  const env = cassette.search.env ?? {};

  it('is the cassette for this source, with nothing secret in it', () => {
    expect(cassette.source).toBe(plan.name);
    expect(['recorded', 'handwritten']).toContain(cassette.origin);
    expect(cassette.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(cassette.exchanges.length).toBeGreaterThan(0);
    // A replay only needs the settings to be present. Real keys never belong in the repository.
    for (const [name, value] of Object.entries(env)) expect(['REDACTED', '1', 'someone@example.com'], name).toContain(value);
    expect(JSON.stringify(cassette.exchanges)).not.toMatch(/api_key=(?!REDACTED)/);
    for (const { request } of cassette.exchanges) expect(Object.keys(request).sort()).toEqual(request.body === undefined ? ['method', 'url'] : ['body', 'method', 'url']);
  });

  it('asks for what was recorded, and returns postings that are fit to show', async () => {
    const net = replay(cassette);
    const jobs = await plan.search(query, { fetch: net, env }, options);

    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.flatMap((j) => postingProblems(j, plan.sourceId))).toEqual([]);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);

    if (plan.titleFilter) {
      const words = roleWords(query.role);
      for (const job of jobs) {
        const title = job.title.toLowerCase();
        const relevant = plan.titleFilter === 'all' ? words.every((w) => title.includes(w)) : words.some((w) => title.includes(w));
        expect(relevant, `"${job.title}" came back for "${query.role}"`).toBe(true);
      }
    }

    if (plan.detail) {
      const detail = await plan.detail(jobs[0], { fetch: net, env }, options);
      expect(detail.descriptionText?.trim()).toBeTruthy();
    }

    // Every stored request was made: the source did not quietly stop asking for something.
    expect(net.unused().map((e) => `${e.request.method} ${e.request.url}`)).toEqual([]);
  });

  it('passes a failure from the service on as an error, with the status', async () => {
    const down = replay({ ...cassette, exchanges: cassette.exchanges.map((e) => ({ request: e.request, response: { status: 500, json: { message: 'Internal Server Error' } } })) });
    await expect(plan.search(query, { fetch: down, env }, options)).rejects.toMatchObject({ status: 500 });
  });
});
