/**
 * Checks every company in the catalog against its live hiring system, because board ids go stale when a company
 * changes systems. Run it from a machine that can reach the job sites:  cd server && npm run check:catalog
 */
import './env';
import { COMPANIES, PLATFORM_LABEL } from '../../src/jobs/catalog';
import { probeBoard, probeWorkday } from './discover';

const fetch = globalThis.fetch.bind(globalThis);
const env = process.env as Record<string, string | undefined>;

async function check(c: (typeof COMPANIES)[number]): Promise<{ result: 'PASS' | 'FAIL' | 'SKIPPED'; note: string }> {
  try {
    switch (c.platform) {
      case 'greenhouse':
      case 'lever':
      case 'ashby':
      case 'smartrecruiters':
        await probeBoard(fetch, c.platform, c.board!);
        return { result: 'PASS', note: '' };
      case 'workday':
        return { result: 'PASS', note: `${await probeWorkday(fetch, c.workday!)} open postings` };
      case 'amazon': {
        const res = await fetch('https://www.amazon.jobs/en/search.json?result_limit=1', { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`answered ${res.status}`);
        return { result: 'PASS', note: `${((await res.json()) as { hits?: number }).hits ?? 0} open postings` };
      }
      case 'usajobs': {
        if (!env.USAJOBS_API_KEY || !env.USAJOBS_USER_AGENT) return { result: 'SKIPPED', note: 'needs USAJOBS_API_KEY and USAJOBS_USER_AGENT' };
        const res = await fetch(`https://data.usajobs.gov/api/search?Organization=${encodeURIComponent(c.board!)}&ResultsPerPage=1`, {
          headers: { 'Authorization-Key': env.USAJOBS_API_KEY, 'User-Agent': env.USAJOBS_USER_AGENT, Host: 'data.usajobs.gov' },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`answered ${res.status}`);
        const n = ((await res.json()) as { SearchResult?: { SearchResultCountAll?: number } }).SearchResult?.SearchResultCountAll ?? 0;
        if (!n) throw new Error(`no postings for organization code ${c.board}`);
        return { result: 'PASS', note: `${n} open postings` };
      }
      default:
        return { result: 'SKIPPED', note: 'no board id: searched through Google for Jobs' };
    }
  } catch (e) {
    return { result: 'FAIL', note: (e as Error).message };
  }
}

const rows = await Promise.all(
  COMPANIES.map(async (c) => ({ company: c.name, system: PLATFORM_LABEL[c.platform], board: c.board ?? c.workday?.host ?? '', ...(await check(c)) })),
);
console.table(rows);
const failed = rows.filter((r) => r.result === 'FAIL');
console.log(failed.length ? `\n${failed.length} catalog entr${failed.length > 1 ? 'ies need' : 'y needs'} a new board id: ${failed.map((r) => r.company).join(', ')}` : '\nEvery catalog board id resolves.');
if (failed.length) process.exitCode = 1;
