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

/** Simple relevance filter for sources that return a whole board (ATS feeds). */
export function matchesQuery(job: Pick<JobPosting, 'title' | 'location' | 'workplace' | 'postedAt'>, q: JobQuery): boolean {
  const words = q.role.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  const title = job.title.toLowerCase();
  if (words.length && !words.every((w) => title.includes(w))) return false;
  if (q.workplace?.length && job.workplace && !q.workplace.includes(job.workplace)) return false;
  if (q.location && !(q.workplace?.length === 1 && q.workplace[0] === 'remote')) {
    const loc = (job.location ?? '').toLowerCase();
    const city = q.location.toLowerCase().split(',')[0].trim();
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
