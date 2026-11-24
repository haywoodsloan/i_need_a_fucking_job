/**
 * One entry per job source: how to run its search, and what a live recording of it should ask for.
 *
 * Two things use this table, so they cannot drift apart:
 *   - test/sources/contract.test.ts replays each source's cassette and checks what comes out.
 *   - server/src/record-fixtures.ts runs the same searches against the live services to make the cassettes.
 *
 * Adding a source means adding it here, recording (or writing) its cassette, and nothing else: the contract test
 * picks it up from the table.
 */
import { amazon, ashby, greenhouse, lever, smartrecruiters, smartrecruitersDetail, workday, workdayDetail, type BoardOpts } from '../../src/jobs/adapters/ats';
import { remoteok, remotive, usajobs } from '../../src/jobs/adapters/feeds';
import { jsearchOpenWebNinja, jsearchRapidApi, serpapi } from '../../src/jobs/adapters/googleJobs';
import { linkedinDetail, linkedinGuest } from '../../src/jobs/adapters/linkedin';
import { companyById, type WorkdayBoard } from '../../src/jobs/catalog';
import type { AdapterContext, JobPosting, JobQuery } from '../../src/jobs/types';

export interface SourcePlan {
  /** The cassette's file name in test/fixtures/sources/, without ".json". */
  name: string;
  /** The `sourceId` every listing from this source carries. */
  sourceId: string;
  /** Settings the live service needs (API keys, opt-in flags). A replay uses the placeholders stored in the cassette. */
  needs?: string[];
  /** Options for a live recording: which real board to ask. A cassette stores the options it was made with. */
  liveOptions?: () => unknown;
  search(query: JobQuery, ctx: AdapterContext, options: unknown): Promise<JobPosting[]>;
  /** For sources whose search gives only a summary: loads one posting's full description. */
  detail?(job: JobPosting, ctx: AdapterContext, options: unknown): Promise<{ descriptionText?: string }>;
  /** Where the list of postings sits in the service's JSON answer, so the recorder can cut a large answer down. */
  listPath?: string[];
  /** For sources that answer with a web page: cuts a recorded page down. */
  trimPage?(html: string, url: string): string;
  /**
   * How the source narrows its results by title: 'all' = every word of the role is in every title (whole-board
   * feeds that are filtered here), 'any' = at least one is (services that run their own search). Left out for
   * sources whose results are shown as the service ranked them.
   */
  titleFilter?: 'all' | 'any';
}

/** The search every cassette is made with, so the fixtures read alike. */
export const LIVE_QUERY: JobQuery = { role: 'software engineer', location: 'Austin, TX', distanceMiles: 25 };

const board = (id: string): BoardOpts => {
  const c = companyById(id);
  if (!c?.board) throw new Error(`The catalog has no board for "${id}"`);
  return { board: c.board, company: c.name };
};

const workdayBoard = (id: string): { board: WorkdayBoard; company: string } => {
  const c = companyById(id);
  if (!c?.workday) throw new Error(`The catalog has no Workday site for "${id}"`);
  return { board: c.workday, company: c.name };
};

/** The last part of a posting id: "smartrecruiters:<board>:<id>" → "<id>". */
const nativeId = (job: JobPosting) => job.id.split(':').slice(2).join(':') || job.id.split(':').slice(1).join(':');

export const SOURCES: SourcePlan[] = [
  {
    name: 'greenhouse',
    sourceId: 'greenhouse',
    liveOptions: () => board('airbnb'),
    search: (q, ctx, o) => greenhouse.search(q, ctx, o as BoardOpts),
    listPath: ['jobs'],
    titleFilter: 'all',
  },
  {
    name: 'lever',
    sourceId: 'lever',
    liveOptions: () => board('palantir'),
    search: (q, ctx, o) => lever.search(q, ctx, o as BoardOpts),
    listPath: [],
    titleFilter: 'all',
  },
  {
    name: 'ashby',
    sourceId: 'ashby',
    liveOptions: () => board('openai'),
    search: (q, ctx, o) => ashby.search(q, ctx, o as BoardOpts),
    listPath: ['jobs'],
    titleFilter: 'all',
  },
  {
    name: 'smartrecruiters',
    sourceId: 'smartrecruiters',
    liveOptions: () => board('servicenow'),
    search: (q, ctx, o) => smartrecruiters.search(q, ctx, o as BoardOpts),
    detail: (job, ctx, o) => smartrecruitersDetail(ctx, (o as BoardOpts).board, nativeId(job)),
    listPath: ['content'],
    titleFilter: 'any',
  },
  {
    name: 'workday',
    sourceId: 'workday',
    liveOptions: () => workdayBoard('boeing'),
    search: (q, ctx, o) => workday.search(q, ctx, o as { board: WorkdayBoard; company: string }),
    detail: (job, ctx, o) => workdayDetail(ctx, (o as { board: WorkdayBoard }).board, nativeId(job)),
    listPath: ['jobPostings'],
    titleFilter: 'any',
  },
  {
    name: 'amazon',
    sourceId: 'amazon',
    search: (q, ctx) => amazon.search(q, ctx),
    listPath: ['jobs'],
    titleFilter: 'any',
  },
  {
    name: 'remotive',
    sourceId: 'remotive',
    search: (q, ctx) => remotive.search(q, ctx),
    listPath: ['jobs'],
    titleFilter: 'all',
  },
  {
    name: 'remoteok',
    sourceId: 'remoteok',
    search: (q, ctx) => remoteok.search(q, ctx),
    listPath: [],
    titleFilter: 'all',
  },
  {
    name: 'usajobs',
    sourceId: 'usajobs',
    needs: ['USAJOBS_API_KEY', 'USAJOBS_USER_AGENT'],
    search: (q, ctx) => usajobs.search(q, ctx),
    listPath: ['SearchResult', 'SearchResultItems'],
  },
  // JSearch has two doors with the same answers: its maker's own site, and RapidAPI. One cassette each.
  {
    name: 'openwebninja',
    sourceId: 'google-jobs',
    needs: ['OPENWEBNINJA_API_KEY'],
    search: (q, ctx) => jsearchOpenWebNinja.search(q, ctx),
    listPath: ['data', 'jobs'],
  },
  {
    name: 'jsearch',
    sourceId: 'google-jobs',
    needs: ['JSEARCH_API_KEY'],
    search: (q, ctx) => jsearchRapidApi.search(q, ctx),
    listPath: ['data', 'jobs'],
  },
  {
    name: 'serpapi',
    sourceId: 'google-jobs',
    needs: ['SERPAPI_KEY'],
    search: (q, ctx) => serpapi.search(q, ctx),
    listPath: ['jobs_results'],
  },
  {
    name: 'linkedin',
    sourceId: 'linkedin-guest',
    needs: ['ENABLE_LINKEDIN_GUEST'],
    search: (q, ctx) => linkedinGuest.search(q, ctx),
    detail: (job, ctx) => linkedinDetail(ctx, job.id.split(':')[1]),
    // Scripts, styles and drawings are not part of the answer. A results page is a list of cards: three are enough.
    trimPage: (html, url) => {
      const page = html.replace(/<(script|style|svg|code)[\s\S]*?<\/\1>/gi, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
      return url.includes('/seeMoreJobPostings/') ? page.split(/(?=<li[\s>])/).slice(0, 4).join('') : page;
    },
  },
];

export const sourceByName = (name: string) => SOURCES.find((s) => s.name === name);

const WORKPLACES = new Set(['remote', 'hybrid', 'onsite']);
const PERIODS = new Set(['hour', 'day', 'week', 'month', 'year']);

const isWebAddress = (s: unknown) => typeof s === 'string' && /^https?:\/\/[^\s/]+/.test(s);

/**
 * Everything wrong with a posting, as sentences. Empty means it is fit to show: this is what the rest of the app
 * (the merge, the results list, the detail pane) relies on from every source.
 */
export function postingProblems(job: JobPosting, sourceId: string): string[] {
  const out: string[] = [];
  const bad = (what: string) => out.push(`${job.id || '(no id)'}: ${what}`);
  if (typeof job.id !== 'string' || !/^[a-z-]+:.+/.test(job.id)) bad('the id is not "<source>:<native id>"');
  if (typeof job.title !== 'string' || !job.title.trim()) bad('no title');
  if (typeof job.company !== 'string' || !job.company.trim()) bad('no company');
  if (job.location !== undefined && (typeof job.location !== 'string' || !job.location.trim())) bad('the location is empty rather than left out');
  if (job.workplace !== undefined && !WORKPLACES.has(job.workplace)) bad(`unknown workplace "${job.workplace}"`);
  if (job.postedAt !== undefined && (Number.isNaN(Date.parse(job.postedAt)) || new Date(job.postedAt).toISOString() !== job.postedAt)) bad(`postedAt "${job.postedAt}" is not an ISO date`);
  if (job.companyLogo !== undefined && !isWebAddress(job.companyLogo)) bad('the logo is not a web address');
  if (job.descriptionHtml !== undefined && typeof job.descriptionHtml !== 'string') bad('descriptionHtml is not text');
  if (job.descriptionText !== undefined && typeof job.descriptionText !== 'string') bad('descriptionText is not text');
  if (job.descriptionHtml && !job.descriptionText) bad('has descriptionHtml but no descriptionText to search and compare');
  if (!job.descriptionHtml && !job.descriptionText && !job.descriptionPartial) bad('has no description and does not say that one can be loaded');
  if (job.salary) {
    const { min, max, period, text } = job.salary;
    for (const [name, n] of [['min', min], ['max', max]] as const) if (n !== undefined && !(Number.isFinite(n) && n >= 0)) bad(`salary ${name} is not a number`);
    if (min !== undefined && max !== undefined && min > max) bad('salary min is above max');
    if (period !== undefined && !PERIODS.has(period)) bad(`unknown salary period "${period}"`);
    if (min === undefined && max === undefined && !text) bad('the salary holds nothing');
  }
  if (!Array.isArray(job.listings) || job.listings.length === 0) bad('no listing, so nowhere to open the posting');
  for (const l of job.listings ?? []) {
    if (l.sourceId !== sourceId) bad(`a listing is marked as from "${l.sourceId}", not "${sourceId}"`);
    if (typeof l.via !== 'string' || !l.via.trim()) bad('a listing does not name its board');
    if (!isWebAddress(l.url)) bad(`a listing's address is not a web address: ${l.url}`);
    if (l.applyUrl !== undefined && !isWebAddress(l.applyUrl)) bad(`a listing's apply address is not a web address: ${l.applyUrl}`);
  }
  return out;
}
