/**
 * What the search server does with a request. index.ts is the process around it: it reads the environment, starts
 * the fetch pipeline and accounts, and listens on a port.
 *
 *   GET  /api/health           which sources this server can run
 *   POST /api/search           { query: JobQuery, settings: SearchSettings } → SearchResponse
 *   GET  /api/job?id=<job id>  full description for snippet-only results
 *   /api/auth, /api/account    sign-in and accounts, when this server is set up for them (see docs/accounts.md)
 *   everything else            the built app itself, when the server was started with --serve-app (see static.ts)
 *
 * Everything it needs is handed in, so the tests can run it with a fake clock and recorded answers instead of the
 * live job sites (test/integration/search-server.test.ts).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { aggregate, googleJobsAdapter, type AggregateOptions } from '../../src/jobs/aggregate';
import type { Adapter } from '../../src/jobs/adapters/common';
import type { AdapterContext, JobPosting, JobQuery, SearchSettings } from '../../src/jobs/types';
import { jobDetail } from './detail';
import { makeDiscover } from './discover';
import type { Fetcher } from './fetcher';
import { requestUrl } from './static';

type Env = Record<string, string | undefined>;

export interface AppParts {
  env: Env;
  /** The fetch pipeline every request to a job source goes through (see docs/fetch-tiers.md). */
  fetch: Fetcher;
  /** Sign-in and accounts, when this server has them switched on. */
  accounts?: { owns(path: string): boolean; handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> };
  /** The built app, when this server serves it as well. */
  builtApp?: { handle(req: IncomingMessage, res: ServerResponse, path: string): boolean };
  /** Server-only extra sources, by id (the older Indeed browser route). */
  extra?: Record<string, Adapter>;
  /** Finds the hiring system behind a typed company name. */
  discover?: AggregateOptions['discover'];
  /** Loads the full description of one posting. */
  detail?: (id: string, ctx: AdapterContext) => Promise<Partial<JobPosting>>;
  now?: () => number;
  logError?: (e: unknown) => void;
}

/** A request that is wrong in a way the caller can fix. Its message is shown to the caller. */
class BadRequest extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

const MAX_BODY_BYTES = 20_000;
const RATE_WINDOW_MS = 5 * 60_000;
/** How many addresses and searches are remembered at once. The oldest is dropped when a new one would not fit. */
const MAX_TRACKED_ADDRESSES = 5000;
const MAX_CACHED_SEARCHES = 500;

/** The origins named in ALLOWED_ORIGINS. Empty means any origin may call the search routes. */
export const allowedOrigins = (env: Env): string[] => (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function validQuery(q: unknown): q is JobQuery {
  const o = q as JobQuery;
  return !!o && typeof o.role === 'string' && o.role.trim().length > 0 && o.role.length < 200;
}

function validSettings(s: unknown): s is SearchSettings {
  const o = s as SearchSettings;
  return !!o && Array.isArray(o.boards) && Array.isArray(o.companies) && Array.isArray(o.industries) && o.companies.length <= 60;
}

async function readBody(req: IncomingMessage, max = MAX_BODY_BYTES): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new BadRequest('Request body too large', 413);
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: unknown) {
  const s = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(s);
}

export function createApp(parts: AppParts): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { env, accounts, builtApp } = parts;
  const fetcher = parts.fetch;
  const now = parts.now ?? Date.now;
  const logError = parts.logError ?? ((e: unknown) => console.error(e));
  const ctx: AdapterContext = { fetch: fetcher, env };
  const discover = parts.discover ?? makeDiscover(fetcher);
  const detail = parts.detail ?? jobDetail;

  const origins = allowedOrigins(env);
  const cacheMs = Number(env.CACHE_SECONDS ?? 600) * 1000;
  const rateMax = Number(env.RATE_LIMIT_PER_5MIN ?? 40);

  const cache = new Map<string, { at: number; body: string }>();
  const hits = new Map<string, number[]>();

  function cors(req: IncomingMessage, res: ServerResponse) {
    const origin = req.headers.origin;
    if (!origin) return;
    if (!origins.length || origins.includes(origin) || origins.includes('*')) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
  }

  function limited(req: IncomingMessage): boolean {
    const ip = (req.headers['fly-client-ip'] as string) ?? (req.headers['x-forwarded-for'] as string)?.split(',')[0] ?? req.socket.remoteAddress ?? '?';
    const t = now();
    const list = (hits.get(ip) ?? []).filter((at) => t - at < RATE_WINDOW_MS);
    list.push(t);
    hits.delete(ip); // so the address counts as the newest one
    hits.set(ip, list);
    if (hits.size > MAX_TRACKED_ADDRESSES) hits.delete(hits.keys().next().value!);
    return list.length > rateMax;
  }

  async function search(req: IncomingMessage, res: ServerResponse) {
    if (limited(req)) return send(res, 429, { error: 'Too many searches, try again in a few minutes' });
    let asked: { query?: unknown; settings?: unknown } | null;
    const text = await readBody(req);
    try {
      asked = JSON.parse(text);
    } catch {
      throw new BadRequest('Invalid search');
    }
    const { query, settings } = asked ?? {};
    if (!validQuery(query) || !validSettings(settings)) throw new BadRequest('Invalid search');
    const key = JSON.stringify({ query, settings });
    const hit = cache.get(key);
    if (hit && now() - hit.at < cacheMs) return send(res, 200, hit.body);
    const result = await aggregate(query, settings, ctx, { runtime: 'server', extra: parts.extra, discover });
    const body = JSON.stringify(result);
    // An answer where every source failed is not worth keeping: the next search should try again.
    if (result.sources.some((s) => s.ok)) cache.set(key, { at: now(), body });
    if (cache.size > MAX_CACHED_SEARCHES) cache.delete(cache.keys().next().value!);
    return send(res, 200, body);
  }

  return async (req, res) => {
    let url: URL;
    try {
      url = requestUrl(req.url);
    } catch {
      return send(res, 400, { error: 'Bad request' });
    }
    // Account routes come first: they are for the app's own pages and must not get the CORS headers below.
    if (accounts?.owns(url.pathname)) {
      return accounts.handle(req, res, url).catch((e) => {
        logError(e);
        if (!res.headersSent) send(res, 500, { error: 'Something went wrong on the server.' });
      });
    }
    if (url.pathname === '/api/auth/session') return send(res, 200, { available: false, user: null });
    if (builtApp && !url.pathname.startsWith('/api/') && builtApp.handle(req, res, url.pathname)) return;
    cors(req, res);
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();
    try {
      if (url.pathname === '/api/health') {
        return send(res, 200, {
          ok: true,
          sources: {
            googleJobs: googleJobsAdapter(ctx)?.label ?? null,
            usajobs: !!(env.USAJOBS_API_KEY && env.USAJOBS_USER_AGENT),
            linkedinGuest: !!env.ENABLE_LINKEDIN_GUEST,
            playwright: !!env.ENABLE_PLAYWRIGHT,
          },
          tiers: fetcher.tiers,
          fetch: fetcher.stats(),
          accounts: !!accounts,
        });
      }
      if (url.pathname === '/api/search' && req.method === 'POST') return await search(req, res);
      if (url.pathname === '/api/job' && req.method === 'GET') {
        const id = url.searchParams.get('id');
        if (!id) return send(res, 400, { error: 'Missing id' });
        return send(res, 200, await detail(id, ctx));
      }
      send(res, 404, { error: 'Not found' });
    } catch (e) {
      if (e instanceof BadRequest) return send(res, e.status, { error: e.message });
      logError(e);
      send(res, 500, { error: (e as Error).message });
    }
  };
}
