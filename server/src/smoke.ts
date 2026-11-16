/**
 * Live smoke test: runs one real search through every configured source and
 * prints what each returned. Run it from a machine that can reach the job
 * sites:  cd server && npm run smoke -- "software engineer" "Austin, TX"
 *
 * Results:  PASS = returned jobs · EMPTY = answered, nothing matched · FAIL = error · SKIPPED = needs a key or flag.
 * Keys and flags come from server/.env.
 */
import './env';
import { aggregate, planSearch } from '../../src/jobs/aggregate';
import { BOARDS } from '../../src/jobs/boards';
import type { SearchSettings, SourceStatus } from '../../src/jobs/types';
import { makeDiscover } from './discover';
import { createFetcher } from './fetcher';
import { closeBrowser, indeedBrowser } from './indeed';

const [role = 'software engineer', location = 'Austin, TX'] = process.argv.slice(2);
const env = process.env as Record<string, string | undefined>;
// The same fetch layer the server uses, so pacing, retries and bot-check reporting are part of the test.
const fetch = createFetcher();

// One company per hiring system, plus a typed name that has to be discovered.
const settings: SearchSettings = {
  boards: BOARDS.map((b) => b.id),
  companies: ['airbnb', 'palantir', 'openai', 'servicenow', 'visa', 'boeing', 'amazon', 'faa', 'microsoft', 'custom:Duolingo'],
  industries: [],
  allowScraping: true,
};
const ctx = { fetch, env };
const opts = { runtime: 'server' as const, extra: { 'indeed-browser': indeedBrowser }, discover: makeDiscover(fetch), timeoutMs: 45_000 };

console.log(`Searching "${role}"${location ? ` near ${location}` : ''}...\n`);
const res = await aggregate({ role, location, distanceMiles: 25 }, settings, ctx, opts);

// A source that answered with nothing may just have no such job in that city. Ask those again without the city, so
// "works, nothing nearby" reads differently from "returns nothing at all". Google for Jobs is left out: it costs credits.
const empty = new Set(res.sources.filter((s) => s.ok && s.count === 0).map((s) => s.sourceId));
const anywhere = new Map<string, number | string>();
if (location && empty.size) {
  const tasks = planSearch({ role }, settings, ctx, opts).filter((t) => empty.has(t.sourceId) && !t.skipped && !/google/i.test(t.label));
  await Promise.all(
    tasks.map(async (t) => {
      try {
        anywhere.set(t.sourceId, (await t.run()).length);
      } catch (e) {
        anywhere.set(t.sourceId, `error: ${(e as Error).message}`);
      }
    }),
  );
}

const verdict = (s: SourceStatus) => (s.skipped ? 'SKIPPED' : s.blocked ? 'BLOCKED' : !s.ok ? 'FAIL' : s.count ? 'PASS' : 'EMPTY');
console.table(
  res.sources.map((s) => ({
    source: s.label,
    result: verdict(s),
    jobs: s.count,
    'any city': anywhere.get(s.sourceId) ?? '',
    ms: s.ms,
    note: s.error ?? s.skipped ?? '',
  })),
);

const tally = (v: string) => res.sources.filter((s) => verdict(s) === v).length;
const net = fetch.stats();
console.log(`\n${tally('PASS')} passed, ${tally('EMPTY')} empty, ${tally('FAIL')} failed, ${tally('BLOCKED')} blocked, ${tally('SKIPPED')} skipped.`);
console.log(`${net.requests} requests sent, ${net.cacheHits} answered from cache, ${net.retries} retried.`);
console.log(`\n${res.jobs.length} unique jobs. First 10:`);
for (const j of res.jobs.slice(0, 10)) console.log(`- ${j.title} · ${j.company} · ${j.location ?? ''} · via ${j.listings.map((l) => l.via).join(', ')}`);
await closeBrowser().catch(() => {});
if (tally('FAIL')) process.exitCode = 1;
