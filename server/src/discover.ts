/**
 * Auto-discovery: given a typed company name, find which ATS hosts its job
 * board by probing each platform's public API with slug guesses. Results are
 * cached for a day, so each company costs a handful of requests at most once.
 */
import { slugCandidates, type CompanyDef, type WorkdayBoard } from '../../src/jobs/catalog';
import type { FetchLike } from '../../src/jobs/types';

type Found = Pick<CompanyDef, 'platform' | 'board'>;
const DAY = 86_400_000;

type Probed = 'greenhouse' | 'lever' | 'ashby' | 'smartrecruiters';

/** One cheap request per platform that tells whether a board id exists and has postings. */
export const PROBES: { platform: Probed; url: (s: string) => string; ok: (j: unknown) => boolean }[] = [
  { platform: 'greenhouse', url: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`, ok: (j) => Array.isArray((j as { jobs?: unknown[] }).jobs) },
  { platform: 'lever', url: (s) => `https://api.lever.co/v0/postings/${s}?mode=json&limit=1`, ok: (j) => Array.isArray(j) && j.length > 0 },
  { platform: 'ashby', url: (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`, ok: (j) => Array.isArray((j as { jobs?: unknown[] }).jobs) },
  {
    platform: 'smartrecruiters',
    // Unknown ids answer 200 with totalFound 0, so "found" has to mean "has postings".
    url: (s) => `https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=1`,
    ok: (j) => ((j as { totalFound?: number }).totalFound ?? 0) > 0,
  },
];

/** Throws with the reason when the board does not answer or is empty. */
export async function probeBoard(fetch: FetchLike, platform: Probed, board: string): Promise<void> {
  const p = PROBES.find((x) => x.platform === platform)!;
  const res = await fetch(p.url(encodeURIComponent(board)), { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`answered ${res.status}`);
  if (!p.ok(await res.json())) throw new Error('no postings');
}

/** Number of open postings on a Workday site. Throws when the tenant or site id is wrong (Workday answers 422). */
export async function probeWorkday(fetch: FetchLike, b: WorkdayBoard): Promise<number> {
  const res = await fetch(`https://${b.host}/wday/cxs/${b.tenant}/${b.site}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: '' }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`answered ${res.status}`);
  const total = ((await res.json()) as { total?: number }).total ?? 0;
  if (!total) throw new Error('no postings');
  return total;
}

/** Each lookup function remembers what it found for a day, including "nothing", so a name is not probed twice. */
export function makeDiscover(fetch: FetchLike, now: () => number = Date.now) {
  const cache = new Map<string, { at: number; v: Found | undefined }>();
  return async (name: string): Promise<Found | undefined> => {
    const key = name.toLowerCase().trim();
    const hit = cache.get(key);
    if (hit && now() - hit.at < DAY) return hit.v;
    let found: Found | undefined;
    outer: for (const slug of slugCandidates(name)) {
      const attempts = await Promise.allSettled(
        PROBES.map(async (p) => {
          const res = await fetch(p.url(slug), { signal: AbortSignal.timeout(6000) });
          if (!res.ok) throw new Error(String(res.status));
          if (!p.ok(await res.json())) throw new Error('empty');
          return { platform: p.platform, board: slug } as Found;
        }),
      );
      for (const a of attempts) {
        if (a.status === 'fulfilled') {
          found = a.value;
          break outer;
        }
      }
    }
    cache.set(key, { at: now(), v: found });
    return found;
  };
}
