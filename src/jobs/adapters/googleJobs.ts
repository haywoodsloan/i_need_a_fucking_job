/**
 * Google for Jobs, via a commercial API. Google indexes postings from
 * LinkedIn, Indeed, Glassdoor, ZipRecruiter, Dice, employer career sites and
 * more, and each result lists every board it appeared on. This is the main
 * route to the big boards that have no public API.
 *
 * Two interchangeable providers:
 *   - JSearch (RapidAPI): JSEARCH_API_KEY
 *   - SerpAPI:           SERPAPI_KEY
 */
import type { JobListing, JobPosting, JobQuery } from '../types';
import { getJson, guessWorkplace, iso, normalizePeriod, type Adapter } from './common';

// ---------------------------------------------------------------- JSearch

interface JSearchJob {
  job_id: string;
  job_title: string;
  employer_name: string;
  employer_logo?: string | null;
  job_publisher?: string;
  job_employment_type?: string | null;
  job_apply_link?: string;
  apply_options?: { publisher: string; apply_link: string; is_direct?: boolean }[];
  job_description?: string;
  job_is_remote?: boolean;
  job_posted_at_datetime_utc?: string | null;
  job_location?: string | null;
  job_city?: string | null;
  job_state?: string | null;
  job_country?: string | null;
  job_min_salary?: number | null;
  job_max_salary?: number | null;
  job_salary_currency?: string | null;
  job_salary_period?: string | null;
  job_google_link?: string;
}

const JSEARCH_DATE: [number, string][] = [
  [1, 'today'],
  [3, '3days'],
  [7, 'week'],
  [31, 'month'],
];

export function jsearchUrl(q: JobQuery, page = 1): string {
  const remoteOnly = q.workplace?.length === 1 && q.workplace[0] === 'remote';
  const query = [q.role, q.location && !remoteOnly ? `in ${q.location}` : ''].filter(Boolean).join(' ');
  const p = new URLSearchParams({ query, page: String(page), num_pages: '2' });
  if (remoteOnly) p.set('remote_jobs_only', 'true');
  if (q.distanceMiles && q.location && !remoteOnly) p.set('radius', String(Math.round(q.distanceMiles * 1.609)));
  if (q.postedWithinDays) {
    const d = JSEARCH_DATE.find(([n]) => q.postedWithinDays! <= n);
    p.set('date_posted', d ? d[1] : 'all');
  }
  return `https://jsearch.p.rapidapi.com/search?${p}`;
}

export function normalizeJSearch(j: JSearchJob): JobPosting {
  const listings: JobListing[] = [];
  const seen = new Set<string>();
  const push = (via: string, url: string) => {
    if (!url || seen.has(via.toLowerCase())) return;
    seen.add(via.toLowerCase());
    listings.push({ sourceId: 'google-jobs', via, url, applyUrl: url });
  };
  if (j.job_publisher && j.job_apply_link) push(j.job_publisher, j.job_apply_link);
  for (const o of j.apply_options ?? []) push(o.publisher, o.apply_link);
  const location = j.job_location ?? ([j.job_city, j.job_state].filter(Boolean).join(', ') || j.job_country || undefined);
  return {
    id: `google-jobs:${j.job_id}`,
    title: j.job_title,
    company: j.employer_name,
    companyLogo: j.employer_logo ?? undefined,
    location: location ?? undefined,
    workplace: j.job_is_remote ? 'remote' : guessWorkplace(j.job_title, location ?? ''),
    employmentType: j.job_employment_type ?? undefined,
    postedAt: iso(j.job_posted_at_datetime_utc),
    salary:
      j.job_min_salary || j.job_max_salary
        ? {
            min: j.job_min_salary ?? undefined,
            max: j.job_max_salary ?? undefined,
            currency: j.job_salary_currency ?? 'USD',
            period: normalizePeriod(j.job_salary_period),
          }
        : undefined,
    descriptionText: j.job_description,
    listings,
  };
}

export const jsearch: Adapter = {
  id: 'google-jobs',
  label: 'Google for Jobs (JSearch)',
  requires: ['JSEARCH_API_KEY'],
  async search(q, ctx) {
    const data = await getJson<{ data: JSearchJob[] }>(ctx, jsearchUrl(q, q.page ?? 1), {
      headers: { 'X-RapidAPI-Key': ctx.env.JSEARCH_API_KEY!, 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com' },
    });
    return (data.data ?? []).map(normalizeJSearch);
  },
};

// ---------------------------------------------------------------- SerpAPI

interface SerpJob {
  job_id: string;
  title: string;
  company_name: string;
  location?: string;
  via?: string;
  description?: string;
  thumbnail?: string;
  extensions?: string[];
  detected_extensions?: { posted_at?: string; schedule_type?: string; salary?: string; work_from_home?: boolean };
  apply_options?: { title: string; link: string }[];
  share_link?: string;
}

/** "3 days ago" → ISO date. */
export function relativeToIso(s?: string, now = Date.now()): string | undefined {
  if (!s) return undefined;
  const m = s.match(/(\d+)\+?\s*(minute|hour|day|week|month)s?\s+ago/i);
  if (!m) return /just|today/i.test(s) ? new Date(now).toISOString() : undefined;
  const unit = { minute: 6e4, hour: 3.6e6, day: 8.64e7, week: 6.048e8, month: 2.592e9 }[m[2].toLowerCase()]!;
  return new Date(now - +m[1] * unit).toISOString();
}

export function parseSalaryText(text?: string) {
  if (!text) return undefined;
  const nums = [...text.matchAll(/\$?\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*([kK])?/g)].map((m) => parseFloat(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1));
  const period = /hour|hr/i.test(text) ? 'hour' : /month/i.test(text) ? 'month' : /year|yr|annual|a year/i.test(text) ? 'year' : undefined;
  return { min: nums[0], max: nums[1] ?? nums[0], currency: 'USD', period: period as 'hour' | 'month' | 'year' | undefined, text };
}

export function normalizeSerp(j: SerpJob, now = Date.now()): JobPosting {
  const listings: JobListing[] = (j.apply_options ?? []).map((o) => ({ sourceId: 'google-jobs', via: o.title, url: o.link, applyUrl: o.link }));
  if (!listings.length && j.via) listings.push({ sourceId: 'google-jobs', via: j.via.replace(/^via\s+/i, ''), url: j.share_link ?? '' });
  const ext = j.detected_extensions ?? {};
  return {
    id: `google-jobs:${j.job_id.slice(0, 120)}`,
    title: j.title,
    company: j.company_name,
    companyLogo: j.thumbnail,
    location: j.location?.trim(),
    workplace: ext.work_from_home ? 'remote' : guessWorkplace(j.title, j.location, ...(j.extensions ?? [])),
    employmentType: ext.schedule_type,
    postedAt: relativeToIso(ext.posted_at, now),
    salary: parseSalaryText(ext.salary),
    descriptionText: j.description,
    listings,
  };
}

export function serpUrl(q: JobQuery, key: string, nextPageToken?: string): string {
  const remoteOnly = q.workplace?.length === 1 && q.workplace[0] === 'remote';
  const p = new URLSearchParams({ engine: 'google_jobs', q: q.role, hl: 'en', gl: 'us', api_key: key });
  if (q.location && !remoteOnly) p.set('location', q.location);
  if (remoteOnly) p.set('ltype', '1');
  if (q.distanceMiles && q.location && !remoteOnly) p.set('lrad', String(Math.round(q.distanceMiles * 1.609)));
  if (nextPageToken) p.set('next_page_token', nextPageToken);
  return `https://serpapi.com/search.json?${p}`;
}

export const serpapi: Adapter = {
  id: 'google-jobs',
  label: 'Google for Jobs (SerpAPI)',
  requires: ['SERPAPI_KEY'],
  async search(q, ctx) {
    const out: JobPosting[] = [];
    let token: string | undefined;
    // Two pages (~20 jobs) per search keeps API usage predictable.
    for (let i = 0; i < 2; i++) {
      const data = await getJson<{ jobs_results?: SerpJob[]; serpapi_pagination?: { next_page_token?: string } }>(
        ctx,
        serpUrl(q, ctx.env.SERPAPI_KEY!, token),
      );
      out.push(...(data.jobs_results ?? []).map((j) => normalizeSerp(j)));
      token = data.serpapi_pagination?.next_page_token;
      if (!token) break;
    }
    return out;
  },
};
