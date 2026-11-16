/**
 * Indeed result parsing. The page is fetched by a headless browser on the
 * server (server/src/indeed.ts) because Indeed blocks plain HTTP clients;
 * this file only turns the page's embedded JSON into JobPostings so it can be
 * tested without a browser.
 */
import type { JobPosting, JobQuery } from '../types';
import { decodeHtml, guessWorkplace, htmlToText, iso, normalizePeriod } from './common';

export function indeedSearchUrl(q: JobQuery, start = 0): string {
  const p = new URLSearchParams({ q: q.role, start: String(start) });
  const remoteOnly = q.workplace?.length === 1 && q.workplace[0] === 'remote';
  if (q.location && !remoteOnly) p.set('l', q.location);
  if (q.distanceMiles && q.location && !remoteOnly) p.set('radius', String(q.distanceMiles));
  if (q.postedWithinDays) p.set('fromage', String(q.postedWithinDays));
  if (remoteOnly) p.set('sc', '0kf:attr(DSQF7);');
  else if (q.workplace?.length === 1 && q.workplace[0] === 'hybrid') p.set('sc', '0kf:attr(PAXZC);');
  return `https://www.indeed.com/jobs?${p}`;
}

interface IndeedCard {
  jobkey: string;
  displayTitle?: string;
  title?: string;
  company?: string;
  formattedLocation?: string;
  pubDate?: number;
  snippet?: string;
  remoteLocation?: boolean;
  extractedSalary?: { min?: number; max?: number; type?: string };
  salarySnippet?: { text?: string };
  jobTypes?: string[];
}

/** Pulls `window.mosaic.providerData["mosaic-provider-jobcards"]` out of the page. */
export function parseIndeedPage(html: string): JobPosting[] {
  const marker = 'window.mosaic.providerData["mosaic-provider-jobcards"]=';
  const i = html.indexOf(marker);
  if (i < 0) return [];
  const json = readJsonObject(html, i + marker.length);
  if (!json) return [];
  const data = JSON.parse(json);
  const results: IndeedCard[] = data?.metaData?.mosaicProviderJobCardsModel?.results ?? [];
  return results.map((r) => {
    const url = `https://www.indeed.com/viewjob?jk=${r.jobkey}`;
    const snippet = r.snippet ? decodeHtml(r.snippet) : undefined;
    return {
      id: `indeed:${r.jobkey}`,
      title: r.displayTitle ?? r.title ?? 'Untitled',
      company: r.company ?? 'Unknown',
      location: r.formattedLocation,
      workplace: r.remoteLocation ? 'remote' : guessWorkplace(r.formattedLocation),
      employmentType: r.jobTypes?.[0],
      postedAt: iso(r.pubDate),
      salary: r.extractedSalary
        ? { min: r.extractedSalary.min, max: r.extractedSalary.max, currency: 'USD', period: normalizePeriod(r.extractedSalary.type), text: r.salarySnippet?.text }
        : r.salarySnippet?.text
          ? { text: r.salarySnippet.text }
          : undefined,
      descriptionText: snippet ? htmlToText(snippet) : undefined,
      descriptionPartial: true,
      listings: [{ sourceId: 'indeed-browser', via: 'Indeed', url, applyUrl: url }],
    } satisfies JobPosting;
  });
}

/** Reads one balanced JSON object starting at `from` (string-aware). */
export function readJsonObject(s: string, from: number): string | undefined {
  const start = s.indexOf('{', from);
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return s.slice(start, i + 1);
  }
  return undefined;
}

export function isBotWall(html: string): boolean {
  return /Just a moment\.\.\.|cf-challenge|Additional Verification Required|hcaptcha|Security Check - Indeed/i.test(html);
}
