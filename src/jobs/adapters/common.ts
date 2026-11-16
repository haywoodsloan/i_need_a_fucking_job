import type { AdapterContext, JobPosting, JobQuery, Salary, Workplace } from '../types';

export interface Adapter<Opts = void> {
  id: string;
  label: string;
  /** Env vars required on the server; the adapter is skipped without them. */
  requires?: string[];
  /** Can run straight from the browser (public CORS-enabled API). */
  browserSafe?: boolean;
  search(q: JobQuery, ctx: AdapterContext, opts: Opts): Promise<JobPosting[]>;
}

export class SourceError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

/**
 * The site refused this server as automated traffic (a bot check, a CAPTCHA page, LinkedIn's 999). That is the
 * site's answer: nothing here tries to get around it, and the search reports the source as blocked.
 */
export class BlockedError extends SourceError {
  constructor(
    public host: string,
    status?: number,
  ) {
    super(`${host} turned this server away as automated traffic${status ? ` (${status})` : ''}`, status);
  }
}

export async function getJson<T>(ctx: AdapterContext, url: string, init?: RequestInit): Promise<T> {
  const res = await ctx.fetch(url, { ...init, signal: ctx.signal });
  if (!res.ok) throw new SourceError(`${new URL(url).host} answered ${res.status}`, res.status);
  return (await res.json()) as T;
}

export function htmlToText(html: string): string {
  return decodeHtml(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<\/(p|div|h[1-6]|ul|ol|li|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

export function decodeHtml(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

const REMOTE_RE = /\bremote\b|work from home|\bwfh\b|anywhere/i;
const HYBRID_RE = /\bhybrid\b/i;

export function guessWorkplace(...hints: (string | undefined | null)[]): Workplace | undefined {
  const s = hints.filter(Boolean).join(' ');
  if (HYBRID_RE.test(s)) return 'hybrid';
  if (REMOTE_RE.test(s)) return 'remote';
  if (/on-?site|in[- ]office/i.test(s)) return 'onsite';
  return undefined;
}

export function normalizePeriod(p?: string | null): Salary['period'] {
  if (!p) return undefined;
  const s = p.toLowerCase();
  if (s.startsWith('h') || s === 'ph' || s.includes('hour')) return 'hour';
  if (s.startsWith('d') || s.includes('day')) return 'day';
  if (s.startsWith('w') || s.includes('week')) return 'week';
  if (s.startsWith('m') || s.includes('month')) return 'month';
  if (s.startsWith('y') || s.startsWith('a') || s.includes('year') || s === 'pa') return 'year';
  return undefined;
}

export const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

export interface Place {
  /** Title-cased, because some sources match city names case-sensitively. */
  city: string;
  stateCode?: string;
  stateName?: string;
}

const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, pre: string, c: string) => pre + c.toUpperCase());

/** "austin, tx", "Austin, Texas" and "Austin TX" all become { city: 'Austin', stateCode: 'TX', stateName: 'Texas' }. */
export function parsePlace(text: string): Place | undefined {
  const t = text.trim().replace(/\s+/g, ' ');
  if (!t) return undefined;
  let city = t;
  let state = '';
  const comma = t.indexOf(',');
  if (comma >= 0) {
    city = t.slice(0, comma).trim();
    state = t.slice(comma + 1).split(',')[0].trim();
  } else {
    const m = t.match(/^(.+) ([A-Za-z]{2})$/);
    if (m && US_STATES[m[2].toUpperCase()]) [, city, state] = m;
  }
  if (!city) return undefined;
  const code = state.toUpperCase().replace(/\./g, '');
  const entry = US_STATES[code] ? [code, US_STATES[code]] : Object.entries(US_STATES).find(([, name]) => name.toLowerCase() === state.toLowerCase());
  return entry ? { city: titleCase(city), stateCode: entry[0], stateName: entry[1] } : { city: titleCase(city) };
}

const STOP_WORDS = new Set(['of', 'and', 'the', 'in', 'for', 'to', 'at', 'with', 'or']);

/**
 * Relevance filter applied to what a source returns.
 * `title: 'all'` (default) is for whole-board feeds, where nothing has been filtered yet: every role word must be in
 * the title. `title: 'any'` is for sources that already ran their own search and only need the stray matches removed.
 */
export function matchesQuery(
  job: Pick<JobPosting, 'title' | 'location' | 'workplace' | 'postedAt'>,
  q: JobQuery,
  opts: { title?: 'all' | 'any' } = {},
): boolean {
  const words = q.role.toLowerCase().split(/\s+/).filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  const title = job.title.toLowerCase();
  if (words.length && !(opts.title === 'any' ? words.some((w) => title.includes(w)) : words.every((w) => title.includes(w)))) return false;
  if (q.workplace?.length && job.workplace && !q.workplace.includes(job.workplace)) return false;
  if (q.location && !(q.workplace?.length === 1 && q.workplace[0] === 'remote')) {
    const loc = (job.location ?? '').toLowerCase();
    const city = parsePlace(q.location)?.city.toLowerCase();
    if (city && loc && !loc.includes(city) && job.workplace !== 'remote' && !REMOTE_RE.test(loc)) return false;
  }
  if (q.postedWithinDays && job.postedAt) {
    const age = (Date.now() - Date.parse(job.postedAt)) / 86_400_000;
    if (age > q.postedWithinDays) return false;
  }
  return true;
}

export const iso = (v: string | number | undefined | null): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const d = new Date(typeof v === 'number' && v < 1e12 ? v * 1000 : v);
  return isNaN(+d) ? undefined : d.toISOString();
};
