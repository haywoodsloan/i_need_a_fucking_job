/**
 * Fans a search out to every selected source, then merges the results into
 * one de-duplicated list. Runs on the backend (all sources) or in the
 * browser (browser-safe sources only, when no backend is configured).
 */
import { BOARDS, boardsForPublisher } from './boards';
import { COMPANIES, companyById, isCustomCompany, type CompanyDef } from './catalog';
import { amazon, ashby, greenhouse, lever, smartrecruiters, workday } from './adapters/ats';
import { BlockedError, type Adapter } from './adapters/common';
import { remoteok, remotive, usajobs } from './adapters/feeds';
import { jsearch, serpapi } from './adapters/googleJobs';
import { linkedinGuest } from './adapters/linkedin';
import type { AdapterContext, JobPosting, JobQuery, SearchResponse, SearchSettings, SourceStatus } from './types';

export interface AggregateOptions {
  /** 'server' may use keyed/CORS-less sources; 'browser' only browser-safe ones. */
  runtime: 'server' | 'browser';
  /** Server-only extra adapters (e.g. the Playwright Indeed adapter). */
  extra?: Record<string, Adapter>;
  /** Server-only: resolve a free-typed company to an ATS board. */
  discover?: (name: string) => Promise<Pick<CompanyDef, 'platform' | 'board' | 'workday'> | undefined>;
  timeoutMs?: number;
}

interface Task {
  sourceId: string;
  label: string;
  run: () => Promise<JobPosting[]>;
  skipped?: string;
  /** Keep only results whose listings map to these board ids. */
  boardFilter?: Set<string>;
  /** Keep only results from this employer. */
  employer?: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function missing(a: Adapter, ctx: AdapterContext): string | undefined {
  const need = (a.requires ?? []).filter((k) => !ctx.env[k]);
  return need.length ? `needs ${need.join(', ')} on the server` : undefined;
}

export function googleJobsAdapter(ctx: AdapterContext): Adapter | undefined {
  if (ctx.env.JSEARCH_API_KEY) return jsearch;
  if (ctx.env.SERPAPI_KEY) return serpapi;
  return undefined;
}

function companyTask(c: Pick<CompanyDef, 'name' | 'platform' | 'board' | 'workday'>, q: JobQuery, ctx: AdapterContext, o: AggregateOptions): Task {
  const label = `${c.name} (${c.platform})`;
  const sid = `company:${norm(c.name)}`;
  const onServer = o.runtime === 'server';
  const serverOnly = (why = 'runs on the backend') => ({ sourceId: sid, label, run: async () => [], skipped: why });
  const opts = { board: c.board ?? '', company: c.name };
  switch (c.platform) {
    case 'greenhouse':
      return { sourceId: sid, label, run: () => greenhouse.search(q, ctx, opts) };
    case 'lever':
      return { sourceId: sid, label, run: () => lever.search(q, ctx, opts) };
    case 'ashby':
      return { sourceId: sid, label, run: () => ashby.search(q, ctx, opts) };
    case 'smartrecruiters':
      return { sourceId: sid, label, run: () => smartrecruiters.search(q, ctx, opts) };
    case 'workday':
      return onServer ? { sourceId: sid, label, run: () => workday.search(q, ctx, { board: c.workday!, company: c.name }) } : serverOnly();
    case 'amazon':
      return onServer ? { sourceId: sid, label, run: () => amazon.search(q, ctx) } : serverOnly();
    case 'usajobs':
      if (!onServer) return serverOnly();
      return { sourceId: sid, label, run: () => usajobs.search(q, ctx, { organization: c.board }), skipped: missing(usajobs, ctx) };
    case 'google-jobs':
    default: {
      const g = onServer ? googleJobsAdapter(ctx) : undefined;
      if (!g) return serverOnly(onServer ? 'needs JSEARCH_API_KEY or SERPAPI_KEY on the server' : undefined);
      return { sourceId: sid, label: `${c.name} (Google for Jobs)`, employer: c.name, run: () => g.search({ ...q, role: `${q.role} ${c.name}` }, ctx) };
    }
  }
}

export function planSearch(q: JobQuery, s: SearchSettings, ctx: AdapterContext, o: AggregateOptions): Task[] {
  const tasks: Task[] = [];
  const onServer = o.runtime === 'server';
  const boards = new Set(s.boards);

  // 1. Google for Jobs covers most boards in one call.
  const viaGoogle = BOARDS.filter((b) => boards.has(b.id) && b.routes.includes('google-jobs')).map((b) => b.id);
  if (viaGoogle.length) {
    const g = onServer ? googleJobsAdapter(ctx) : undefined;
    tasks.push({
      sourceId: 'google-jobs',
      label: g?.label ?? 'Google for Jobs',
      run: () => g!.search(q, ctx),
      skipped: !onServer ? 'runs on the backend' : g ? undefined : 'needs JSEARCH_API_KEY or SERPAPI_KEY on the server',
      boardFilter: new Set(viaGoogle),
    });
  }

  // 2. Direct board routes.
  if (boards.has('usajobs')) {
    tasks.push({ sourceId: 'usajobs', label: 'USAJOBS', run: () => usajobs.search(q, ctx), skipped: onServer ? missing(usajobs, ctx) : 'runs on the backend' });
  }
  if (boards.has('remote-boards')) {
    tasks.push({ sourceId: 'remotive', label: 'Remotive', run: () => remotive.search(q, ctx) });
    tasks.push({ sourceId: 'remoteok', label: 'Remote OK', run: () => remoteok.search(q, ctx), skipped: onServer ? undefined : 'runs on the backend' });
  }

  // 3. Scraping routes, only when the user and the server both allow them.
  if (s.allowScraping && onServer) {
    if (boards.has('linkedin')) {
      tasks.push({ sourceId: 'linkedin-guest', label: linkedinGuest.label, run: () => linkedinGuest.search(q, ctx), skipped: missing(linkedinGuest, ctx) });
    }
    const indeed = o.extra?.['indeed-browser'];
    if (boards.has('indeed') && indeed) {
      tasks.push({ sourceId: indeed.id, label: indeed.label, run: () => indeed.search(q, ctx), skipped: missing(indeed, ctx) });
    }
  }

  // 4. Experimental: specific companies and whole industries.
  const companyIds = new Set(s.companies.filter((id) => !isCustomCompany(id)));
  for (const ind of s.industries) COMPANIES.filter((c) => c.industries.includes(ind)).forEach((c) => companyIds.add(c.id));
  for (const id of companyIds) {
    const c = companyById(id);
    if (c) tasks.push(companyTask(c, q, ctx, o));
  }
  for (const id of s.companies.filter(isCustomCompany)) {
    const name = id.slice('custom:'.length);
    if (!onServer || !o.discover) {
      tasks.push({ sourceId: `company:${norm(name)}`, label: name, run: async () => [], skipped: 'company lookup runs on the backend' });
      continue;
    }
    const discover = o.discover;
    const sid = `company:${norm(name)}`;
    tasks.push({
      sourceId: sid,
      label: name,
      run: async () => {
        const found = await discover(name);
        const t = companyTask({ name, platform: found?.platform ?? 'google-jobs', board: found?.board, workday: found?.workday }, q, ctx, o);
        if (t.skipped) throw new Error(t.skipped);
        const jobs = await t.run();
        return t.employer ? jobs.filter((j) => norm(j.company).includes(norm(name))) : jobs;
      },
    });
  }
  return tasks;
}

/** Identity used to merge the same job seen on several sources. */
export function dedupeKey(j: JobPosting): string {
  const city = (j.location ?? '').split(/[,·(]/)[0];
  return [norm(j.company).replace(/(inc|llc|corp|corporation|ltd)$/, ''), norm(j.title), norm(city)].join('|');
}

export function mergeJobs(lists: JobPosting[][]): JobPosting[] {
  const byKey = new Map<string, JobPosting>();
  for (const job of lists.flat()) {
    const k = dedupeKey(job);
    const prev = byKey.get(k);
    if (!prev) {
      byKey.set(k, { ...job, listings: [...job.listings] });
      continue;
    }
    const seen = new Set(prev.listings.map((l) => l.via.toLowerCase()));
    for (const l of job.listings) if (!seen.has(l.via.toLowerCase())) prev.listings.push(l);
    const prevLen = (prev.descriptionText ?? '').length;
    if ((job.descriptionText ?? '').length > prevLen) {
      prev.descriptionText = job.descriptionText;
      prev.descriptionHtml = job.descriptionHtml;
      prev.descriptionPartial = job.descriptionPartial;
    }
    prev.salary ??= job.salary;
    prev.workplace ??= job.workplace;
    prev.postedAt ??= job.postedAt;
    prev.companyLogo ??= job.companyLogo;
    prev.employmentType ??= job.employmentType;
  }
  return [...byKey.values()].sort((a, b) => (b.postedAt ?? '').localeCompare(a.postedAt ?? ''));
}

function keepForBoards(job: JobPosting, boards: Set<string>): boolean {
  return job.listings.some((l) => boardsForPublisher(l.via).some((b) => boards.has(b)));
}

export async function aggregate(q: JobQuery, s: SearchSettings, ctx: AdapterContext, o: AggregateOptions): Promise<SearchResponse> {
  const tasks = planSearch(q, s, ctx, o);
  const timeout = o.timeoutMs ?? 25_000;
  const results = await Promise.all(
    tasks.map(async (t): Promise<{ status: SourceStatus; jobs: JobPosting[] }> => {
      const base = { sourceId: t.sourceId, label: t.label };
      if (t.skipped) return { status: { ...base, ok: false, count: 0, ms: 0, skipped: t.skipped }, jobs: [] };
      const t0 = Date.now();
      try {
        let jobs = await Promise.race([
          t.run(),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${timeout / 1000}s`)), timeout)),
        ]);
        if (t.boardFilter) jobs = jobs.filter((j) => keepForBoards(j, t.boardFilter!));
        if (t.employer) jobs = jobs.filter((j) => norm(j.company).includes(norm(t.employer!)));
        return { status: { ...base, ok: true, count: jobs.length, ms: Date.now() - t0 }, jobs };
      } catch (e) {
        const blocked = e instanceof BlockedError ? { blocked: true } : {};
        return { status: { ...base, ok: false, count: 0, ms: Date.now() - t0, error: (e as Error).message, ...blocked }, jobs: [] };
      }
    }),
  );
  return { jobs: mergeJobs(results.map((r) => r.jobs)), sources: results.map((r) => r.status) };
}
