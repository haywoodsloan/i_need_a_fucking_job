/**
 * Auto-discovery: given a typed company name, find which ATS hosts its job
 * board by probing each platform's public API with slug guesses. Results are
 * cached for a day, so each company costs a handful of requests at most once.
 */
import { slugCandidates, type CompanyDef } from '../../src/jobs/catalog';
import type { FetchLike } from '../../src/jobs/types';

type Found = Pick<CompanyDef, 'platform' | 'board'>;
const cache = new Map<string, { at: number; v: Found | undefined }>();
const DAY = 86_400_000;

const PROBES: { platform: CompanyDef['platform']; url: (s: string) => string; ok: (j: unknown) => boolean }[] = [
  { platform: 'greenhouse', url: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`, ok: (j) => Array.isArray((j as { jobs?: unknown[] }).jobs) },
  { platform: 'lever', url: (s) => `https://api.lever.co/v0/postings/${s}?mode=json&limit=1`, ok: (j) => Array.isArray(j) && j.length > 0 },
  { platform: 'ashby', url: (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`, ok: (j) => Array.isArray((j as { jobs?: unknown[] }).jobs) },
  {
    platform: 'smartrecruiters',
    url: (s) => `https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=1`,
    ok: (j) => ((j as { totalFound?: number }).totalFound ?? 0) > 0,
  },
];

export function makeDiscover(fetch: FetchLike) {
  return async (name: string): Promise<Found | undefined> => {
    const key = name.toLowerCase().trim();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < DAY) return hit.v;
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
    cache.set(key, { at: Date.now(), v: found });
    return found;
  };
}
