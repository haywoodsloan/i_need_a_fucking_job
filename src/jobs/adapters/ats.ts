/**
 * Applicant-tracking-system adapters. Each ATS serves the same public job
 * feed for every company that uses it, so one adapter covers all of them.
 */
import type { WorkdayBoard } from '../catalog';
import type { JobPosting, JobQuery } from '../types';
import { decodeHtml, getJson, guessWorkplace, htmlToText, iso, matchesQuery, normalizePeriod, type Adapter } from './common';

export interface BoardOpts {
  board: string;
  /** Display name to use when the feed doesn't include one. */
  company: string;
}

// ------------------------------------------------------------- Greenhouse

interface GhJob {
  id: number;
  title: string;
  updated_at?: string;
  first_published?: string;
  location?: { name?: string };
  absolute_url: string;
  content?: string;
  company_name?: string;
}

export function normalizeGreenhouse(j: GhJob, o: BoardOpts): JobPosting {
  const html = j.content ? decodeHtml(j.content) : undefined;
  return {
    id: `greenhouse:${o.board}:${j.id}`,
    title: j.title.trim(),
    company: j.company_name ?? o.company,
    location: j.location?.name,
    workplace: guessWorkplace(j.location?.name, j.title),
    postedAt: iso(j.first_published ?? j.updated_at),
    descriptionHtml: html,
    descriptionText: html ? htmlToText(html) : undefined,
    listings: [{ sourceId: 'greenhouse', via: `${o.company} careers (Greenhouse)`, url: j.absolute_url, applyUrl: j.absolute_url }],
  };
}

export const greenhouse: Adapter<BoardOpts> = {
  id: 'greenhouse',
  label: 'Greenhouse',
  browserSafe: true,
  async search(q, ctx, o) {
    const data = await getJson<{ jobs: GhJob[] }>(ctx, `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(o.board)}/jobs?content=true`);
    return data.jobs.map((j) => normalizeGreenhouse(j, o)).filter((j) => matchesQuery(j, q));
  },
};

// ------------------------------------------------------------------ Lever

interface LeverJob {
  id: string;
  text: string;
  categories?: { location?: string; commitment?: string; team?: string; allLocations?: string[] };
  workplaceType?: 'remote' | 'hybrid' | 'onsite' | 'unspecified';
  hostedUrl: string;
  applyUrl?: string;
  createdAt?: number;
  description?: string;
  descriptionPlain?: string;
  lists?: { text: string; content: string }[];
  additional?: string;
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
}

export function normalizeLever(j: LeverJob, o: BoardOpts): JobPosting {
  const html = [j.description ?? '', ...(j.lists ?? []).map((l) => `<h3>${l.text}</h3><ul>${l.content}</ul>`), j.additional ?? ''].join('');
  const wp = j.workplaceType && j.workplaceType !== 'unspecified' ? j.workplaceType : guessWorkplace(j.categories?.location);
  return {
    id: `lever:${o.board}:${j.id}`,
    title: j.text,
    company: o.company,
    location: j.categories?.allLocations?.join(' · ') || j.categories?.location,
    workplace: wp,
    employmentType: j.categories?.commitment,
    postedAt: iso(j.createdAt),
    salary: j.salaryRange
      ? { min: j.salaryRange.min, max: j.salaryRange.max, currency: j.salaryRange.currency, period: normalizePeriod(j.salaryRange.interval?.replace('per-', '')) }
      : undefined,
    descriptionHtml: html || undefined,
    descriptionText: html ? htmlToText(html) : j.descriptionPlain,
    listings: [{ sourceId: 'lever', via: `${o.company} careers (Lever)`, url: j.hostedUrl, applyUrl: j.applyUrl ?? j.hostedUrl }],
  };
}

export const lever: Adapter<BoardOpts> = {
  id: 'lever',
  label: 'Lever',
  browserSafe: true,
  async search(q, ctx, o) {
    const data = await getJson<LeverJob[]>(ctx, `https://api.lever.co/v0/postings/${encodeURIComponent(o.board)}?mode=json`);
    return data.map((j) => normalizeLever(j, o)).filter((j) => matchesQuery(j, q));
  },
};

// ------------------------------------------------------------------ Ashby

interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  secondaryLocations?: { location: string }[];
  isRemote?: boolean;
  workplaceType?: 'Remote' | 'Hybrid' | 'OnSite' | string;
  employmentType?: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
  publishedAt?: string;
  jobUrl: string;
  applyUrl?: string;
  isListed?: boolean;
  compensation?: { compensationTierSummary?: string; scrapeableCompensationSalarySummary?: string };
}

export function normalizeAshby(j: AshbyJob, o: BoardOpts): JobPosting {
  const wpRaw = (j.workplaceType ?? '').toLowerCase();
  const workplace = wpRaw === 'remote' || j.isRemote ? 'remote' : wpRaw === 'hybrid' ? 'hybrid' : wpRaw === 'onsite' ? 'onsite' : guessWorkplace(j.location);
  const comp = j.compensation?.scrapeableCompensationSalarySummary ?? j.compensation?.compensationTierSummary;
  return {
    id: `ashby:${o.board}:${j.id}`,
    title: j.title,
    company: o.company,
    location: [j.location, ...(j.secondaryLocations ?? []).map((s) => s.location)].filter(Boolean).join(' · ') || undefined,
    workplace,
    employmentType: j.employmentType,
    postedAt: iso(j.publishedAt),
    salary: comp ? { text: comp } : undefined,
    descriptionHtml: j.descriptionHtml,
    descriptionText: j.descriptionPlain ?? (j.descriptionHtml ? htmlToText(j.descriptionHtml) : undefined),
    listings: [{ sourceId: 'ashby', via: `${o.company} careers (Ashby)`, url: j.jobUrl, applyUrl: j.applyUrl ?? j.jobUrl }],
  };
}

export const ashby: Adapter<BoardOpts> = {
  id: 'ashby',
  label: 'Ashby',
  browserSafe: true,
  async search(q, ctx, o) {
    const data = await getJson<{ jobs: AshbyJob[] }>(ctx, `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(o.board)}?includeCompensation=true`);
    return data.jobs.filter((j) => j.isListed !== false).map((j) => normalizeAshby(j, o)).filter((j) => matchesQuery(j, q));
  },
};

// -------------------------------------------------------- SmartRecruiters

interface SrJob {
  id: string;
  name: string;
  releasedDate?: string;
  location?: { city?: string; region?: string; country?: string; remote?: boolean; hybrid?: boolean; fullLocation?: string };
  company?: { name?: string; identifier?: string };
  typeOfEmployment?: { label?: string };
  ref?: string;
}

export function normalizeSmartRecruiters(j: SrJob, o: BoardOpts): JobPosting {
  const loc = j.location?.fullLocation ?? [j.location?.city, j.location?.region, j.location?.country?.toUpperCase()].filter(Boolean).join(', ');
  const url = `https://jobs.smartrecruiters.com/${encodeURIComponent(j.company?.identifier ?? o.board)}/${j.id}`;
  return {
    id: `smartrecruiters:${o.board}:${j.id}`,
    title: j.name,
    company: j.company?.name ?? o.company,
    location: loc || undefined,
    workplace: j.location?.remote ? 'remote' : j.location?.hybrid ? 'hybrid' : guessWorkplace(loc),
    employmentType: j.typeOfEmployment?.label,
    postedAt: iso(j.releasedDate),
    descriptionPartial: true,
    listings: [{ sourceId: 'smartrecruiters', via: `${o.company} careers (SmartRecruiters)`, url, applyUrl: url }],
  };
}

export const smartrecruiters: Adapter<BoardOpts> = {
  id: 'smartrecruiters',
  label: 'SmartRecruiters',
  browserSafe: true,
  async search(q, ctx, o) {
    const p = new URLSearchParams({ q: q.role, limit: '100' });
    if (q.location && !(q.workplace?.length === 1 && q.workplace[0] === 'remote')) p.set('city', q.location.split(',')[0].trim());
    const data = await getJson<{ content: SrJob[] }>(ctx, `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(o.board)}/postings?${p}`);
    return data.content.map((j) => normalizeSmartRecruiters(j, o)).filter((j) => matchesQuery({ ...j, location: undefined }, { ...q, location: undefined }));
  },
};

export async function smartrecruitersDetail(ctx: Parameters<Adapter['search']>[1], board: string, id: string) {
  const d = await getJson<{ jobAd?: { sections?: Record<string, { title?: string; text?: string }> } }>(
    ctx,
    `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(board)}/postings/${encodeURIComponent(id)}`,
  );
  const html = Object.values(d.jobAd?.sections ?? {})
    .filter((s) => s.text)
    .map((s) => `${s.title ? `<h3>${s.title}</h3>` : ''}${s.text}`)
    .join('');
  return { descriptionHtml: html, descriptionText: htmlToText(html) };
}

// ---------------------------------------------------------------- Workday

interface WdListJob {
  title: string;
  externalPath: string;
  locationsText?: string;
  postedOn?: string;
  remoteType?: string;
  bulletFields?: string[];
}

/** Workday shows "Posted 3 Days Ago" / "Posted Today" / "Posted 30+ Days Ago". */
export function workdayPostedToIso(s?: string, now = Date.now()): string | undefined {
  if (!s) return undefined;
  if (/today/i.test(s)) return new Date(now).toISOString();
  if (/yesterday/i.test(s)) return new Date(now - 8.64e7).toISOString();
  const m = s.match(/(\d+)\+?\s*days?/i);
  return m ? new Date(now - +m[1] * 8.64e7).toISOString() : undefined;
}

export function workdayPublicUrl(b: WorkdayBoard, externalPath: string) {
  return `https://${b.host}/en-US/${b.site}${externalPath}`;
}

export function normalizeWorkday(j: WdListJob, b: WorkdayBoard, company: string, now = Date.now()): JobPosting {
  const url = workdayPublicUrl(b, j.externalPath);
  return {
    id: `workday:${b.tenant}:${j.externalPath}`,
    title: j.title,
    company,
    location: j.locationsText,
    workplace: guessWorkplace(j.remoteType, j.locationsText, j.title),
    postedAt: workdayPostedToIso(j.postedOn, now),
    descriptionPartial: true,
    listings: [{ sourceId: 'workday', via: `${company} careers (Workday)`, url, applyUrl: url }],
  };
}

export const workday: Adapter<{ board: WorkdayBoard; company: string }> = {
  id: 'workday',
  label: 'Workday',
  // Workday's JSON endpoints don't send CORS headers: server only.
  async search(q, ctx, { board, company }) {
    const remoteOnly = q.workplace?.length === 1 && q.workplace[0] === 'remote';
    const searchText = [q.role, remoteOnly ? 'remote' : q.location?.split(',')[0]].filter(Boolean).join(' ');
    const data = await getJson<{ jobPostings?: WdListJob[] }>(ctx, `https://${board.host}/wday/cxs/${board.tenant}/${board.site}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText }),
    });
    return (data.jobPostings ?? []).filter((j) => j.title && j.externalPath).map((j) => normalizeWorkday(j, board, company));
  },
};

export async function workdayDetail(ctx: Parameters<Adapter['search']>[1], board: WorkdayBoard, externalPath: string) {
  const d = await getJson<{ jobPostingInfo?: { jobDescription?: string; timeType?: string; remoteType?: string } }>(
    ctx,
    `https://${board.host}/wday/cxs/${board.tenant}/${board.site}${externalPath}`,
    { headers: { Accept: 'application/json' } },
  );
  const html = d.jobPostingInfo?.jobDescription ?? '';
  return { descriptionHtml: html, descriptionText: htmlToText(html), employmentType: d.jobPostingInfo?.timeType };
}

// ----------------------------------------------------------------- Amazon

interface AmazonJob {
  id_icims?: string;
  id?: string;
  title: string;
  company_name?: string;
  normalized_location?: string;
  location?: string;
  posted_date?: string;
  job_path: string;
  description?: string;
  basic_qualifications?: string;
  preferred_qualifications?: string;
}

export function normalizeAmazon(j: AmazonJob): JobPosting {
  const html = [j.description, j.basic_qualifications && `<h3>Basic qualifications</h3>${j.basic_qualifications}`, j.preferred_qualifications && `<h3>Preferred qualifications</h3>${j.preferred_qualifications}`]
    .filter(Boolean)
    .join('');
  const url = `https://www.amazon.jobs${j.job_path}`;
  return {
    id: `amazon:${j.id_icims ?? j.id ?? j.job_path}`,
    title: j.title,
    company: j.company_name ?? 'Amazon',
    location: j.normalized_location ?? j.location,
    workplace: guessWorkplace(j.normalized_location, j.title),
    postedAt: iso(j.posted_date),
    descriptionHtml: html || undefined,
    descriptionText: html ? htmlToText(html) : undefined,
    listings: [{ sourceId: 'amazon', via: 'Amazon Jobs', url, applyUrl: url }],
  };
}

export const amazon: Adapter = {
  id: 'amazon',
  label: 'Amazon Jobs',
  async search(q, ctx) {
    const p = new URLSearchParams({ base_query: q.role, result_limit: '50', sort: 'recent' });
    if (q.location && !(q.workplace?.length === 1 && q.workplace[0] === 'remote')) p.set('loc_query', q.location);
    if (q.distanceMiles) p.set('radius', `${Math.round(q.distanceMiles * 1.609)}km`);
    const data = await getJson<{ jobs: AmazonJob[] }>(ctx, `https://www.amazon.jobs/en/search.json?${p}`);
    return data.jobs.map(normalizeAmazon);
  },
};

export type { JobQuery };
