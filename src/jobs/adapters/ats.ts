/**
 * Applicant-tracking-system adapters. Each ATS serves the same public job
 * feed for every company that uses it, so one adapter covers all of them.
 */
import type { WorkdayBoard } from '../catalog';
import type { JobPosting, JobQuery } from '../types';
import { decodeHtml, getJson, guessWorkplace, htmlToText, iso, matchesQuery, normalizePeriod, parsePlace, SourceError, US_STATES, type Adapter, type Place } from './common';

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
    // Big boards carry thousands of postings (SpaceX: 2,700, 30 MB). Match on the light fields first, and only
    // convert the descriptions of the postings that are kept.
    return data.jobs.filter((j) => matchesQuery(normalizeGreenhouse({ ...j, content: undefined }, o), q)).map((j) => normalizeGreenhouse(j, o));
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
  // workplaceType wins over isRemote: some boards (OpenAI) set isRemote on their hybrid roles.
  const workplace =
    wpRaw === 'remote' ? 'remote' : wpRaw === 'hybrid' ? 'hybrid' : wpRaw === 'onsite' ? 'onsite' : j.isRemote ? 'remote' : guessWorkplace(j.location);
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
    const base = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(o.board)}/postings`;
    const p = new URLSearchParams({ q: q.role, limit: '100' });
    const place = q.location && !(q.workplace?.length === 1 && q.workplace[0] === 'remote') ? parsePlace(q.location) : undefined;
    if (place) p.set('city', place.city);
    const data = await getJson<{ content?: SrJob[] }>(ctx, `${base}?${p}`);
    const content = data.content ?? [];
    if (!content.length) {
      // An unknown company id answers 200 with zero postings, exactly like "no matches". Tell the two apart.
      const any = await getJson<{ totalFound?: number }>(ctx, `${base}?limit=1`);
      if (!any.totalFound) throw new SourceError(`SmartRecruiters has no public postings for "${o.board}" (wrong board id, or the company moved)`);
    }
    return content.map((j) => normalizeSmartRecruiters(j, o)).filter((j) => matchesQuery({ ...j, location: undefined }, { ...q, location: undefined }));
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

/** `matchedLocation` names the place the search was filtered to, so "3 Locations" can say which one matters. */
export function normalizeWorkday(j: WdListJob, b: WorkdayBoard, company: string, now = Date.now(), matchedLocation?: string): JobPosting {
  const url = workdayPublicUrl(b, j.externalPath);
  const several = j.locationsText?.match(/^(\d+) Locations$/i);
  return {
    id: `workday:${b.tenant}:${j.externalPath}`,
    title: j.title,
    company,
    location: several && matchedLocation ? `${matchedLocation} +${+several[1] - 1} more` : j.locationsText,
    workplace: guessWorkplace(j.remoteType, j.locationsText, j.title),
    postedAt: workdayPostedToIso(j.postedOn, now),
    descriptionPartial: true,
    listings: [{ sourceId: 'workday', via: `${company} careers (Workday)`, url, applyUrl: url }],
  };
}

interface WdFacet {
  facetParameter?: string;
  descriptor?: string;
  id?: string;
  values?: WdFacet[];
}

interface WdSearch {
  total?: number;
  jobPostings?: WdListJob[];
  facets?: WdFacet[];
}

export interface WdFacetLeaf {
  param: string;
  id: string;
  descriptor: string;
}

/** Flattens Workday's nested filter tree (e.g. locationMainGroup > locations) into selectable values. */
export function workdayFacetLeaves(facets: WdFacet[] | undefined, out: WdFacetLeaf[] = []): WdFacetLeaf[] {
  for (const f of facets ?? []) {
    for (const v of f.values ?? []) {
      if (v.facetParameter) workdayFacetLeaves([v], out);
      else if (v.id && f.facetParameter) out.push({ param: f.facetParameter, id: v.id, descriptor: v.descriptor ?? '' });
    }
  }
  return out;
}

export interface WdFacetPick {
  param: string;
  ids: string[];
  names: string[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isLocationParam = (param: string) => /location/i.test(param);
/** Every tenant has a plain `locations` filter; fall back to whichever location-like filter matched. */
const preferLocations = (hits: WdFacetLeaf[]): WdFacetLeaf[] => {
  const param = hits.some((l) => l.param === 'locations') ? 'locations' : hits[0].param;
  return hits.filter((l) => l.param === param);
};
const toPick = (hits: WdFacetLeaf[]): WdFacetPick => ({ param: hits[0].param, ids: hits.map((l) => l.id), names: hits.map((l) => l.descriptor) });

function statesMentioned(descriptor: string): Set<string> {
  const d = descriptor.replace(/\./g, '');
  const found = new Set<string>();
  for (const [code, name] of Object.entries(US_STATES)) {
    if (new RegExp(`(^|[^A-Za-z])${code}([^A-Za-z]|$)`).test(d) || new RegExp(`(^|[^a-z])${escapeRe(name.toLowerCase())}([^a-z]|$)`).test(d.toLowerCase())) found.add(code);
  }
  return found;
}

/**
 * Finds the tenant's own location filter values for a city. Tenants name places differently ("US - Austin, TX",
 * "US, TX, Austin", "Texas - Austin", plain "Austin"), so this matches the city as a whole word and uses the state,
 * when the tenant writes one, to keep "Arlington, VA" apart from "Arlington, TX".
 */
export function pickWorkdayLocations(leaves: WdFacetLeaf[], place: Place): WdFacetPick | undefined {
  const city = new RegExp(`(^|[^a-z])${escapeRe(place.city.toLowerCase())}([^a-z]|$)`);
  const cand = leaves.filter((l) => isLocationParam(l.param) && city.test(l.descriptor.toLowerCase()));
  if (!cand.length) return undefined;
  let hits = preferLocations(cand);
  if (place.stateCode) {
    const code = place.stateCode;
    const states = hits.map((l) => statesMentioned(l.descriptor));
    const inState = hits.filter((_, i) => states[i].has(code));
    hits = inState.length ? inState : hits.filter((_, i) => states[i].size === 0);
  }
  return hits.length ? toPick(hits) : undefined;
}

/** Remote roles are tagged either with a "remote type" filter or with locations named "... Remote" / "Virtual ...". */
export function pickWorkdayRemote(leaves: WdFacetLeaf[]): WdFacetPick | undefined {
  const remote = /(^|[^a-z])(remote|virtual|telework)([^a-z]|$)/i;
  const byType = leaves.filter((l) => /remote/i.test(l.param) && remote.test(l.descriptor) && !/hybrid/i.test(l.descriptor));
  if (byType.length) return toPick(byType.filter((l) => l.param === byType[0].param));
  const byLocation = leaves.filter((l) => isLocationParam(l.param) && remote.test(l.descriptor));
  return byLocation.length ? toPick(preferLocations(byLocation)) : undefined;
}

const WD_PAGE = 20; // Workday answers 400 to anything larger
const WD_MAX_PAGES = 3;

export const workday: Adapter<{ board: WorkdayBoard; company: string }> = {
  id: 'workday',
  label: 'Workday',
  // Workday's JSON endpoints don't send CORS headers: server only.
  async search(q, ctx, { board, company }) {
    const url = `https://${board.host}/wday/cxs/${board.tenant}/${board.site}/jobs`;
    const page = (appliedFacets: Record<string, string[]>, searchText: string, offset = 0) =>
      getJson<WdSearch>(ctx, url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ appliedFacets, limit: WD_PAGE, offset, searchText }),
      });
    const remoteOnly = q.workplace?.length === 1 && q.workplace[0] === 'remote';
    const place = !remoteOnly && q.location ? parsePlace(q.location) : undefined;

    // The first answer lists the tenant's filters for this role. Narrow to the place with those, which is exact,
    // rather than adding the city to the search text, which also matches postings that merely mention it.
    let facets: Record<string, string[]> = {};
    let text = q.role;
    let matched: string | undefined;
    let first = await page(facets, text);
    if (place || remoteOnly) {
      const leaves = workdayFacetLeaves(first.facets);
      const pick = place ? pickWorkdayLocations(leaves, place) : pickWorkdayRemote(leaves);
      if (pick) {
        facets = { [pick.param]: pick.ids };
        matched = pick.names.length === 1 ? pick.names[0] : undefined;
      } else if (place && leaves.some((l) => isLocationParam(l.param))) {
        return []; // the tenant lists where this role is open, and the place isn't one of them
      } else {
        text = `${q.role} ${place?.city ?? 'remote'}`;
      }
      first = await page(facets, text);
    }
    // Only the first page reports the total.
    const total = first.total ?? 0;
    const offsets = Array.from({ length: WD_MAX_PAGES - 1 }, (_, i) => (i + 1) * WD_PAGE).filter((o) => o < total);
    const rest = await Promise.all(offsets.map((o) => page(facets, text, o)));
    return [first, ...rest]
      .flatMap((r) => r.jobPostings ?? [])
      .filter((j) => j.title && j.externalPath)
      .map((j) => normalizeWorkday(j, board, company, Date.now(), matched))
      .filter((j) => matchesQuery(j, { ...q, location: undefined }, { title: 'any' }));
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
  /** Every place the role is open, each one a JSON string. */
  locations?: string[];
  posted_date?: string;
  job_path: string;
  description?: string;
  basic_qualifications?: string;
  preferred_qualifications?: string;
}

interface AmazonPlace {
  normalizedLocation?: string;
  type?: string;
}

/** `preferCity` is the searched city: a Seattle role that is also open in Austin should read as an Austin job. */
export function normalizeAmazon(j: AmazonJob, preferCity?: string): JobPosting {
  const html = [j.description, j.basic_qualifications && `<h3>Basic qualifications</h3>${j.basic_qualifications}`, j.preferred_qualifications && `<h3>Preferred qualifications</h3>${j.preferred_qualifications}`]
    .filter(Boolean)
    .join('');
  const url = `https://www.amazon.jobs${j.job_path}`;
  const places = (j.locations ?? []).flatMap((s): AmazonPlace[] => {
    try {
      return [JSON.parse(s) as AmazonPlace];
    } catch {
      return [];
    }
  });
  const names = [...new Set([j.normalized_location ?? j.location, ...places.map((p) => p.normalizedLocation)].filter((n): n is string => !!n))];
  if (preferCity) names.sort((a, b) => +b.startsWith(preferCity) - +a.startsWith(preferCity));
  const types = new Set(places.map((p) => (p.type ?? '').toUpperCase()).filter(Boolean));
  const allRemote = types.size > 0 && [...types].every((t) => t === 'VIRTUAL' || t === 'REMOTE');
  return {
    id: `amazon:${j.id_icims ?? j.id ?? j.job_path}`,
    title: j.title,
    company: j.company_name ?? 'Amazon',
    location: names.join(' · ') || undefined,
    workplace: allRemote ? 'remote' : (guessWorkplace(names.join(' '), j.title) ?? (types.has('ONSITE') ? 'onsite' : undefined)),
    postedAt: iso(j.posted_date),
    descriptionHtml: html || undefined,
    descriptionText: html ? htmlToText(html) : undefined,
    listings: [{ sourceId: 'amazon', via: 'Amazon Jobs', url, applyUrl: url }],
  };
}

export function amazonSearchUrl(q: JobQuery): { url: string; place?: Place } {
  const p = new URLSearchParams({ base_query: q.role, result_limit: '100', sort: 'recent' });
  const remoteOnly = q.workplace?.length === 1 && q.workplace[0] === 'remote';
  const place = !remoteOnly && q.location ? parsePlace(q.location) : undefined;
  // `loc_query` alone is ignored (the site pairs it with coordinates). These filters do narrow the search, and they
  // are case-sensitive: "austin" finds nothing, "Austin" does.
  if (place) {
    p.append('normalized_city_name[]', place.city);
    if (place.stateName) p.append('normalized_state_name[]', place.stateName);
  }
  return { url: `https://www.amazon.jobs/en/search.json?${p}`, place };
}

export const amazon: Adapter = {
  id: 'amazon',
  label: 'Amazon Jobs',
  async search(q, ctx) {
    const { url, place } = amazonSearchUrl(q);
    const data = await getJson<{ jobs?: AmazonJob[] }>(ctx, url);
    return (data.jobs ?? []).map((j) => normalizeAmazon(j, place?.city)).filter((j) => matchesQuery(j, { ...q, location: undefined }, { title: 'any' }));
  },
};

export type { JobQuery };
