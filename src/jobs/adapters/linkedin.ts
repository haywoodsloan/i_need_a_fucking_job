/**
 * LinkedIn's logged-out ("guest") job search pages.
 *
 * These are the same HTML fragments linkedin.com/jobs serves to anonymous
 * visitors. No account or cookie is ever used. LinkedIn's terms prohibit
 * automated access and it rate-limits by IP, so this route is off unless the
 * server sets ENABLE_LINKEDIN_GUEST=1, and the Google for Jobs route is
 * preferred for LinkedIn listings.
 */
import type { JobPosting, JobQuery } from '../types';
import { decodeHtml, guessWorkplace, htmlToText, iso, SourceError, type Adapter } from './common';
import { parseSalaryText } from './googleJobs';

const WT: Record<string, string> = { onsite: '1', remote: '2', hybrid: '3' };

export function linkedinSearchUrl(q: JobQuery, start = 0): string {
  const p = new URLSearchParams({ keywords: q.role, start: String(start) });
  const remoteOnly = q.workplace?.length === 1 && q.workplace[0] === 'remote';
  p.set('location', q.location && !remoteOnly ? q.location : 'United States');
  if (q.distanceMiles && q.location && !remoteOnly) p.set('distance', String(q.distanceMiles));
  if (q.workplace?.length) p.set('f_WT', q.workplace.map((w) => WT[w]).join(','));
  if (q.postedWithinDays) p.set('f_TPR', `r${q.postedWithinDays * 86400}`);
  return `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${p}`;
}

const pick = (html: string, re: RegExp) => {
  const m = html.match(re);
  return m ? decodeHtml(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() : undefined;
};

export function parseLinkedinCards(html: string): JobPosting[] {
  const out: JobPosting[] = [];
  for (const chunk of html.split(/<li[\s>]/).slice(1)) {
    const id = chunk.match(/urn:li:jobPosting:(\d+)/)?.[1];
    const title = pick(chunk, /class="base-search-card__title"[^>]*>([\s\S]*?)<\/h3>/);
    if (!id || !title) continue;
    const company = pick(chunk, /class="base-search-card__subtitle"[^>]*>([\s\S]*?)<\/h4>/) ?? 'Unknown';
    const location = pick(chunk, /class="job-search-card__location"[^>]*>([\s\S]*?)<\/span>/);
    const salary = pick(chunk, /class="job-search-card__salary-info"[^>]*>([\s\S]*?)<\/span>/);
    const date = chunk.match(/<time[^>]*datetime="([^"]+)"/)?.[1];
    const logo = chunk.match(/data-delayed-url="([^"]+)"/)?.[1];
    const url = `https://www.linkedin.com/jobs/view/${id}/`;
    out.push({
      id: `linkedin:${id}`,
      title,
      company,
      companyLogo: logo ? decodeHtml(logo) : undefined,
      location,
      workplace: guessWorkplace(location, title),
      postedAt: iso(date),
      salary: parseSalaryText(salary),
      descriptionPartial: true,
      listings: [{ sourceId: 'linkedin-guest', via: 'LinkedIn', url, applyUrl: url }],
    });
  }
  return out;
}

export function parseLinkedinDetail(html: string) {
  const m = html.match(/class="show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  const descriptionHtml = m ? m[1].trim() : undefined;
  const criteria: Record<string, string> = {};
  for (const c of html.matchAll(/job-criteria-subheader[^>]*>([\s\S]*?)<\/h3>\s*<span[^>]*>([\s\S]*?)<\/span>/g)) {
    criteria[decodeHtml(c[1]).trim().toLowerCase()] = decodeHtml(c[2]).replace(/\s+/g, ' ').trim();
  }
  return {
    descriptionHtml,
    descriptionText: descriptionHtml ? htmlToText(descriptionHtml) : undefined,
    employmentType: criteria['employment type'],
    seniority: criteria['seniority level'],
  };
}

// The guest pages answer a client that says what it is, so this does not pose as a browser.
const HEADERS = {
  'User-Agent': 'job-hunt-workbench/0.1 (personal job search tool)',
  Accept: 'text/html',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** The guest endpoint serves 10 cards per request. */
const PAGE_SIZE = 10;
const PAGES = 3;

export const linkedinGuest: Adapter = {
  id: 'linkedin-guest',
  label: 'LinkedIn (public pages)',
  requires: ['ENABLE_LINKEDIN_GUEST'],
  async search(q, ctx) {
    const out: JobPosting[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < PAGES; i++) {
      const res = await ctx.fetch(linkedinSearchUrl(q, i * PAGE_SIZE), { headers: HEADERS, signal: ctx.signal });
      if (res.status === 429 || res.status === 999) throw new SourceError(`LinkedIn turned this server away as automated traffic (${res.status})`, res.status);
      if (!res.ok) throw new SourceError(`LinkedIn answered ${res.status}`, res.status);
      const page = parseLinkedinCards(await res.text());
      for (const job of page) {
        if (seen.has(job.id)) continue;
        seen.add(job.id);
        out.push(job);
      }
      if (page.length < PAGE_SIZE) break;
    }
    return out;
  },
};

export async function linkedinDetail(ctx: Parameters<Adapter['search']>[1], id: string) {
  const res = await ctx.fetch(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${encodeURIComponent(id)}`, { headers: HEADERS, signal: ctx.signal });
  if (!res.ok) throw new SourceError(`LinkedIn answered ${res.status}`, res.status);
  return parseLinkedinDetail(await res.text());
}
