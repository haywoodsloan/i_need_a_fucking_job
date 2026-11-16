/**
 * Job search backend.
 *
 *   GET  /api/health           which sources this server can run
 *   POST /api/search           { query: JobQuery, settings: SearchSettings } → SearchResponse
 *   GET  /api/job?id=<job id>  full description for snippet-only results
 *
 * Secrets live only in this process's environment (see server/.env.example).
 * Nothing about the user's resume is ever sent here.
 */
import './env';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { aggregate, googleJobsAdapter } from '../../src/jobs/aggregate';
import type { AdapterContext, JobQuery, SearchSettings } from '../../src/jobs/types';
import { jobDetail } from './detail';
import { makeDiscover } from './discover';
import { closeBrowser, indeedBrowser } from './indeed';

const env = process.env as Record<string, string | undefined>;
const PORT = Number(env.PORT ?? 8787);
const ORIGINS = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const CACHE_MS = Number(env.CACHE_SECONDS ?? 600) * 1000;
const RATE = { windowMs: 5 * 60_000, max: Number(env.RATE_LIMIT_PER_5MIN ?? 40) };

const ctx: AdapterContext = { fetch: globalThis.fetch.bind(globalThis), env };
const discover = makeDiscover(ctx.fetch);

const cache = new Map<string, { at: number; body: string }>();
const hits = new Map<string, number[]>();

function cors(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  if (!origin) return;
  if (!ORIGINS.length || ORIGINS.includes(origin) || ORIGINS.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  const s = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(s);
}

function limited(req: IncomingMessage): boolean {
  const ip = (req.headers['fly-client-ip'] as string) ?? (req.headers['x-forwarded-for'] as string)?.split(',')[0] ?? req.socket.remoteAddress ?? '?';
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < RATE.windowMs);
  list.push(now);
  hits.set(ip, list);
  return list.length > RATE.max;
}

async function readBody(req: IncomingMessage, max = 20_000): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new Error('Request body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function validQuery(q: unknown): q is JobQuery {
  const o = q as JobQuery;
  return !!o && typeof o.role === 'string' && o.role.trim().length > 0 && o.role.length < 200;
}

function validSettings(s: unknown): s is SearchSettings {
  const o = s as SearchSettings;
  return !!o && Array.isArray(o.boards) && Array.isArray(o.companies) && Array.isArray(o.industries) && o.companies.length <= 60;
}

const server = createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  const url = new URL(req.url ?? '/', 'http://x');
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
      });
    }
    if (url.pathname === '/api/search' && req.method === 'POST') {
      if (limited(req)) return send(res, 429, { error: 'Too many searches, try again in a few minutes' });
      const { query, settings } = JSON.parse(await readBody(req));
      if (!validQuery(query) || !validSettings(settings)) return send(res, 400, { error: 'Invalid search' });
      const key = JSON.stringify({ query, settings });
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_MS) return send(res, 200, hit.body);
      const result = await aggregate(query, settings, ctx, { runtime: 'server', extra: { 'indeed-browser': indeedBrowser }, discover });
      const body = JSON.stringify(result);
      if (result.sources.some((s) => s.ok)) cache.set(key, { at: Date.now(), body });
      if (cache.size > 500) cache.delete(cache.keys().next().value!);
      return send(res, 200, body);
    }
    if (url.pathname === '/api/job' && req.method === 'GET') {
      const id = url.searchParams.get('id');
      if (!id) return send(res, 400, { error: 'Missing id' });
      return send(res, 200, await jobDetail(id, ctx));
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: (e as Error).message });
  }
});

server.listen(PORT, () => {
  console.log(`job search backend on :${PORT}`);
  if (!ORIGINS.length) console.warn('ALLOWED_ORIGINS is not set: accepting requests from any origin');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await closeBrowser().catch(() => {});
    process.exit(0);
  });
}
