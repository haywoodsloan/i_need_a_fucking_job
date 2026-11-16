/**
 * Live smoke test: runs one real search through every configured source and
 * prints what each returned. Run it from a machine that can reach the job
 * sites:  cd server && npm run smoke -- "software engineer" "Austin, TX"
 */
import { aggregate } from '../../src/jobs/aggregate';
import { BOARDS } from '../../src/jobs/boards';
import { makeDiscover } from './discover';
import { closeBrowser, indeedBrowser } from './indeed';

const [role = 'software engineer', location = 'Austin, TX'] = process.argv.slice(2);
const env = process.env as Record<string, string | undefined>;
const fetch = globalThis.fetch.bind(globalThis);

const res = await aggregate(
  { role, location, distanceMiles: 25 },
  {
    boards: BOARDS.map((b) => b.id),
    companies: ['airbnb', 'palantir', 'openai', 'visa', 'boeing', 'amazon', 'faa', 'microsoft', 'custom:Duolingo'],
    industries: [],
    allowScraping: true,
  },
  { fetch, env },
  { runtime: 'server', extra: { 'indeed-browser': indeedBrowser }, discover: makeDiscover(fetch), timeoutMs: 45_000 },
);

console.table(res.sources.map((s) => ({ source: s.label, ok: s.ok, count: s.count, ms: s.ms, note: s.error ?? s.skipped ?? '' })));
console.log(`\n${res.jobs.length} unique jobs. First 10:`);
for (const j of res.jobs.slice(0, 10)) console.log(`- ${j.title} · ${j.company} · ${j.location ?? ''} · via ${j.listings.map((l) => l.via).join(', ')}`);
await closeBrowser().catch(() => {});
