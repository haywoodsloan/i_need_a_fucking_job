/**
 * Google for Jobs, via a commercial API. Google indexes postings from
 * LinkedIn, Indeed, Glassdoor, ZipRecruiter, Dice, employer career sites and
 * more, and each result lists every board it appeared on. This is the main
 * route to the big boards that have no public API.
 *
 * Three interchangeable routes. aggregate.ts uses the first one whose key is set:
 *   - JSearch from its maker, OpenWeb Ninja:     OPENWEBNINJA_API_KEY
 *   - JSearch through the RapidAPI marketplace:  JSEARCH_API_KEY
 *   - SerpAPI:                                   SERPAPI_KEY
 *
 * docs/job-sources.md says how to get a key and what a search costs.
 */
import type { AdapterContext, JobListing, JobPosting, JobQuery } from '../types';
import { SourceError, getJson, guessWorkplace, iso, normalizePeriod, type Adapter } from './common';

/**
 * How many pages of results one search asks for, ten postings to a page. Every page is one request of the plan
 * that was paid for (or of the free allowance), so this is what a search costs. GOOGLE_JOBS_PAGES changes it.
 */
const DEFAULT_PAGES = 2;
const MAX_PAGES = 20;

function pagesPerSearch(env: AdapterContext['env']): number {
  const asked = Math.floor(Number(env.GOOGLE_JOBS_PAGES));
  return asked >= 1 ? Math.min(asked, MAX_PAGES) : DEFAULT_PAGES;
}

const MAX_ID = 120;

/**
 * A posting's id, kept to a sensible length. Google's own ids are short, but some answers carry several hundred
 * characters of encoded details instead, which begin with the job's title and so start alike for two postings
 * with the same one. Cutting such an id off could give both postings the same id. So the whole id is folded
 * into a short checksum (cyrb53) that follows the cut.
 */
function shortId(id: string): string {
  if (id.length <= MAX_ID) return id;
  let a = 0xdeadbeef;
  let b = 0x41c6ce57;
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return `${id.slice(0, 64)}~${(4294967296 * (2097151 & b) + (a >>> 0)).toString(36)}`;
}

// ---------------------------------------------------------------- JSearch

interface JSearchJob {
  job_id: string;
  /** Google's own id for the posting. Newer answers carry it next to a `job_id` of several hundred characters. */
  job_uid?: string | null;
  job_title: string;
  employer_name: string;
  employer_logo?: string | null;
  job_publisher?: string;
  job_employment_type?: string | null;
  job_apply_link?: string;
  apply_options?: { publisher: string; apply_link: string; is_direct?: boolean }[];
  job_description?: string | null;
  job_is_remote?: boolean | null;
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

/** What `/search-v2` answers. The service's older search answered with the list itself as `data`. */
interface JSearchAnswer {
  status?: string;
  error?: { message?: string; code?: number };
  data?: { jobs?: JSearchJob[]; cursor?: string | null } | JSearchJob[];
}

/**
 * JSearch is one service with two doors: its maker, OpenWeb Ninja, sells it on its own site and through the
 * RapidAPI marketplace. Both serve the same endpoints, parameters and answers. They differ in the address, in the
 * header that carries the key, and in which account the key belongs to.
 */
interface JSearchDoor {
  base: string;
  /** The setting that holds this door's key. */
  setting: string;
  headers(key: string): Record<string, string>;
  /** What to check when the door turns the key down. */
  whenRefused: string;
}

const OPENWEB_NINJA: JSearchDoor = {
  base: 'https://api.openwebninja.com/jsearch',
  setting: 'OPENWEBNINJA_API_KEY',
  headers: (key) => ({ 'x-api-key': key }),
  whenRefused: 'Check the key, that its account has a plan for JSearch (the free one counts), and that the plan has requests left this month.',
};

const RAPIDAPI: JSearchDoor = {
  base: 'https://jsearch.p.rapidapi.com',
  setting: 'JSEARCH_API_KEY',
  headers: (key) => ({ 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com' }),
  whenRefused: 'Check the key, and that its RapidAPI account is subscribed to JSearch with requests left this month. A key from openwebninja.com belongs in OPENWEBNINJA_API_KEY.',
};

const JSEARCH_DATE: [number, string][] = [
  [1, 'today'],
  [3, '3days'],
  [7, 'week'],
  [31, 'month'],
];

export function jsearchUrl(q: JobQuery, base = OPENWEB_NINJA.base, pages = DEFAULT_PAGES): string {
  const remoteOnly = q.workplace?.length === 1 && q.workplace[0] === 'remote';
  const query = [q.role, q.location && !remoteOnly ? `in ${q.location}` : ''].filter(Boolean).join(' ');
  const p = new URLSearchParams({ query, num_pages: String(pages) });
  if (remoteOnly) p.set('work_from_home', 'true');
  if (q.distanceMiles && q.location && !remoteOnly) p.set('radius', String(Math.round(q.distanceMiles * 1.609)));
  if (q.postedWithinDays) {
    const d = JSEARCH_DATE.find(([n]) => q.postedWithinDays! <= n);
    p.set('date_posted', d ? d[1] : 'all');
  }
  return `${base}/search-v2?${p}`;
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
    id: `google-jobs:${shortId(String(j.job_uid || j.job_id))}`,
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
    descriptionText: j.job_description ?? undefined,
    listings,
  };
}

/**
 * What the service said went wrong, in its own words and kept short, for the sentence shown with the search results.
 * The service's own errors carry `error.message`. The gateway in front of either door answers with a bare `message`.
 * Should the words repeat the key, it is taken out: the results are shown to everyone who uses this server.
 */
function itsWords(body: unknown, key: string): string {
  const b = body as { message?: unknown; error?: { message?: unknown } } | null;
  const said = [b?.error?.message, b?.message].find((m): m is string => typeof m === 'string' && m.trim() !== '');
  if (!said) return '';
  return ` (${(key ? said.split(key).join('…') : said).trim().slice(0, 200)})`;
}

/** Why a door did not answer: the status, the service's words and, for a key that was turned down, the setting to look at. */
function refusal(door: JSearchDoor, status: number, words: string): string {
  const answered = `${new URL(door.base).host} answered ${status}${words}`;
  if (status === 401 || status === 403) return `${answered}: it did not accept the key in ${door.setting}. ${door.whenRefused}`;
  if (status === 429) return `${answered}: the plan's requests are used up, or they came too fast.`;
  return answered;
}

/** A key is plain printable text. Anything else is a copying accident, and whatever sends the request would quote it in its complaint. */
const PLAIN_TEXT = /^[\x21-\x7e]+$/;

function jsearchThrough(door: JSearchDoor, label: string): Adapter {
  return {
    id: 'google-jobs',
    label,
    requires: [door.setting],
    async search(q, ctx) {
      const key = (ctx.env[door.setting] ?? '').trim();
      if (!PLAIN_TEXT.test(key)) throw new SourceError(`The key in ${door.setting} cannot be sent as it is: it is empty, or it holds a space, a line break or a character that is not plain text. Copy it in again.`);
      // The key travels in a header, never in the address, so it stays out of caches, logs and recordings.
      const res = await ctx.fetch(jsearchUrl(q, door.base, pagesPerSearch(ctx.env)), { headers: door.headers(key), signal: ctx.signal });
      if (!res.ok) throw new SourceError(refusal(door, res.status, itsWords(await res.json().catch(() => null), key)), res.status);
      const answer = (await res.json()) as JSearchAnswer;
      if (answer.status && answer.status !== 'OK') {
        const code = answer.error?.code;
        throw new SourceError(`${new URL(door.base).host} answered with an error${itsWords(answer, key)}`, typeof code === 'number' ? code : undefined);
      }
      const jobs = Array.isArray(answer.data) ? answer.data : answer.data?.jobs;
      // A posting with no id, title or employer cannot be shown, or told apart from its neighbours, so it is left out.
      return (jobs ?? []).filter((j) => j && j.job_title && j.employer_name && (j.job_uid || j.job_id)).map(normalizeJSearch);
    },
  };
}

export const jsearchOpenWebNinja = jsearchThrough(OPENWEB_NINJA, 'Google for Jobs (JSearch, OpenWeb Ninja)');
export const jsearchRapidApi = jsearchThrough(RAPIDAPI, 'Google for Jobs (JSearch, RapidAPI)');

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
    id: `google-jobs:${shortId(j.job_id)}`,
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
    // Each page is a separate request, and one search of the plan.
    const pages = pagesPerSearch(ctx.env);
    for (let i = 0; i < pages; i++) {
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
