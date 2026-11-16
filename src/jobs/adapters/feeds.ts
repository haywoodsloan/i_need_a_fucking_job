import type { JobPosting } from '../types';
import { decodeHtml, getJson, guessWorkplace, htmlToText, iso, matchesQuery, type Adapter } from './common';

// ---------------------------------------------------------------- USAJOBS
// Official API: https://developer.usajobs.gov — free key, sent with the
// requester's email as User-Agent. Server only (the key must stay secret).

interface UsaItem {
  MatchedObjectId: string;
  MatchedObjectDescriptor: {
    PositionTitle: string;
    PositionURI: string;
    ApplyURI?: string[];
    PositionLocationDisplay?: string;
    OrganizationName?: string;
    DepartmentName?: string;
    PositionRemuneration?: { MinimumRange?: string; MaximumRange?: string; RateIntervalCode?: string; Description?: string }[];
    PublicationStartDate?: string;
    PositionSchedule?: { Name?: string }[];
    QualificationSummary?: string;
    UserArea?: { Details?: { JobSummary?: string; MajorDuties?: string[]; TeleworkEligible?: boolean; RemoteIndicator?: boolean } };
  };
}

const USA_PERIOD: Record<string, 'hour' | 'year' | 'day' | 'week' | 'month'> = { PA: 'year', PH: 'hour', PD: 'day', PW: 'week', PM: 'month' };

export function normalizeUsajobs(it: UsaItem): JobPosting {
  const d = it.MatchedObjectDescriptor;
  const pay = d.PositionRemuneration?.[0];
  const details = d.UserArea?.Details;
  const text = [details?.JobSummary, ...(details?.MajorDuties ?? []).map((x) => `• ${x}`), d.QualificationSummary && `Qualifications\n${d.QualificationSummary}`]
    .filter(Boolean)
    .join('\n\n');
  return {
    id: `usajobs:${it.MatchedObjectId}`,
    title: d.PositionTitle,
    company: d.OrganizationName ?? d.DepartmentName ?? 'U.S. Federal Government',
    location: d.PositionLocationDisplay,
    workplace: details?.RemoteIndicator ? 'remote' : details?.TeleworkEligible ? 'hybrid' : guessWorkplace(d.PositionLocationDisplay),
    employmentType: d.PositionSchedule?.[0]?.Name,
    postedAt: iso(d.PublicationStartDate),
    salary: pay
      ? { min: pay.MinimumRange ? +pay.MinimumRange : undefined, max: pay.MaximumRange ? +pay.MaximumRange : undefined, currency: 'USD', period: USA_PERIOD[pay.RateIntervalCode ?? ''] }
      : undefined,
    descriptionText: text || undefined,
    listings: [{ sourceId: 'usajobs', via: 'USAJOBS', url: d.PositionURI, applyUrl: d.ApplyURI?.[0] ?? d.PositionURI }],
  };
}

export const usajobs: Adapter<{ organization?: string } | void> = {
  id: 'usajobs',
  label: 'USAJOBS',
  requires: ['USAJOBS_API_KEY', 'USAJOBS_USER_AGENT'],
  async search(q, ctx, opts) {
    const p = new URLSearchParams({ Keyword: q.role, ResultsPerPage: '50' });
    const remoteOnly = q.workplace?.length === 1 && q.workplace[0] === 'remote';
    if (remoteOnly) p.set('RemoteIndicator', 'True');
    else if (q.location) {
      p.set('LocationName', q.location);
      if (q.distanceMiles) p.set('Radius', String(q.distanceMiles));
    }
    if (q.postedWithinDays) p.set('DatePosted', String(Math.min(60, q.postedWithinDays)));
    if (opts && opts.organization) p.set('Organization', opts.organization);
    const data = await getJson<{ SearchResult: { SearchResultItems: UsaItem[] } }>(ctx, `https://data.usajobs.gov/api/search?${p}`, {
      headers: { 'Authorization-Key': ctx.env.USAJOBS_API_KEY!, 'User-Agent': ctx.env.USAJOBS_USER_AGENT!, Host: 'data.usajobs.gov' },
    });
    return data.SearchResult.SearchResultItems.map(normalizeUsajobs);
  },
};

// ---------------------------------------------------------------- Remotive

interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name: string;
  company_logo?: string;
  job_type?: string;
  publication_date?: string;
  candidate_required_location?: string;
  salary?: string;
  description?: string;
}

export function normalizeRemotive(j: RemotiveJob): JobPosting {
  return {
    id: `remotive:${j.id}`,
    title: j.title,
    company: j.company_name,
    companyLogo: j.company_logo,
    location: j.candidate_required_location ? `Remote (${j.candidate_required_location})` : 'Remote',
    workplace: 'remote',
    employmentType: j.job_type?.replace(/_/g, ' '),
    postedAt: iso(j.publication_date),
    salary: j.salary ? { text: j.salary } : undefined,
    descriptionHtml: j.description,
    descriptionText: j.description ? htmlToText(j.description) : undefined,
    listings: [{ sourceId: 'remotive', via: 'Remotive', url: j.url, applyUrl: j.url }],
  };
}

export const remotive: Adapter = {
  id: 'remotive',
  label: 'Remotive',
  browserSafe: true,
  async search(q, ctx) {
    if (q.workplace?.length && !q.workplace.includes('remote')) return [];
    const data = await getJson<{ jobs: RemotiveJob[] }>(ctx, `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(q.role)}&limit=50`);
    return data.jobs.map(normalizeRemotive).filter((j) => matchesQuery(j, { ...q, location: undefined }));
  },
};

// ---------------------------------------------------------------- Remote OK

interface RemoteOkJob {
  id?: string;
  slug?: string;
  position?: string;
  company?: string;
  company_logo?: string;
  location?: string;
  date?: string;
  salary_min?: number;
  salary_max?: number;
  description?: string;
  url?: string;
  apply_url?: string;
  tags?: string[];
}

export function normalizeRemoteOk(j: RemoteOkJob): JobPosting | undefined {
  if (!j.id || !j.position) return undefined; // first array element is a legal notice
  const html = j.description ? decodeHtml(j.description) : undefined;
  const url = j.url ?? `https://remoteok.com/remote-jobs/${j.slug ?? j.id}`;
  return {
    id: `remoteok:${j.id}`,
    title: j.position,
    company: j.company ?? 'Unknown',
    companyLogo: j.company_logo || undefined,
    location: j.location ? `Remote (${j.location})` : 'Remote',
    workplace: 'remote',
    postedAt: iso(j.date),
    salary: j.salary_min || j.salary_max ? { min: j.salary_min || undefined, max: j.salary_max || undefined, currency: 'USD', period: 'year' } : undefined,
    descriptionHtml: html,
    descriptionText: html ? htmlToText(html) : undefined,
    listings: [{ sourceId: 'remoteok', via: 'Remote OK', url, applyUrl: j.apply_url ?? url }],
  };
}

export const remoteok: Adapter = {
  id: 'remoteok',
  label: 'Remote OK',
  async search(q, ctx) {
    if (q.workplace?.length && !q.workplace.includes('remote')) return [];
    const data = await getJson<RemoteOkJob[]>(ctx, 'https://remoteok.com/api', { headers: { 'User-Agent': 'job-hunt-workbench/0.1' } });
    return data
      .map(normalizeRemoteOk)
      .filter((j): j is JobPosting => !!j)
      .filter((j) => matchesQuery(j, { ...q, location: undefined }));
  },
};
