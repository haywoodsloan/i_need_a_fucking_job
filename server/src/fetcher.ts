/**
 * How the server reaches job sources.
 *
 * Every request goes through two tiers, cheapest first:
 *   1. cache   a fresh copy of the same request, with no network at all
 *   2. http    a plain request, spaced out per site, retried with backoff when the site is briefly unavailable
 *
 * A site that turns the request away as automated traffic (a bot check, a CAPTCHA page) ends it there with
 * BlockedError, and the search reports that source as blocked. Nothing in this file solves or dodges a bot check.
 */
import { BlockedError } from '../../src/jobs/adapters/common';
import type { FetchLike } from '../../src/jobs/types';

export interface Pace {
  /** Requests in flight to one site at a time. */
  concurrency: number;
  /** Minimum time between request starts to one site. */
  gapMs: number;
}

export interface FetcherOptions {
  /** The network. Tests pass a fake. */
  fetch?: FetchLike;
  /** How long a successful answer is reused. 0 turns the cache off. */
  cacheMs?: number;
  cacheMaxBytes?: number;
  /** Extra attempts after a network error or a 502/503/504. */
  retries?: number;
  timeoutMs?: number;
  pace?: Pace;
  /** Per-site overrides, keyed by the last two labels of the hostname ("linkedin.com"). */
  paceFor?: Record<string, Partial<Pace>>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface FetcherStats {
  requests: number;
  cacheHits: number;
  retries: number;
  blocked: number;
  cacheEntries: number;
  cacheMb: number;
}

export type Fetcher = FetchLike & { stats(): FetcherStats };

const DEFAULT_PACE: Pace = { concurrency: 6, gapMs: 50 };
/** LinkedIn's public pages are the one source that is a website, not an API: go one request at a time. */
const DEFAULT_PACE_FOR: Record<string, Partial<Pace>> = { 'linkedin.com': { concurrency: 1, gapMs: 800 } };
const RETRY_STATUS = new Set([502, 503, 504]);
const MAX_RETRY_AFTER_MS = 5000;
const CHALLENGE = /just a moment\.\.\.|cf-chl|challenge-platform|attention required! \| cloudflare|captcha|datadome|incapsula|verify (that )?you are (a )?human|unusual traffic/i;

/** "boards-api.greenhouse.io" and "boeing.wd1.myworkdayjobs.com" pace as greenhouse.io and myworkdayjobs.com. */
export const siteOf = (url: string) => new URL(url).hostname.split('.').slice(-2).join('.');

/** Throws BlockedError when the response is a bot check rather than an answer. */
export async function refuseBotCheck(url: string, res: Response): Promise<void> {
  const host = new URL(url).hostname;
  if (res.status === 999 || res.headers.get('cf-mitigated') === 'challenge') throw new BlockedError(host, res.status);
  if (![403, 429, 503].includes(res.status) || !/html/i.test(res.headers.get('content-type') ?? '')) return;
  const page = (await res.clone().text()).slice(0, 20_000);
  if (CHALLENGE.test(page)) throw new BlockedError(host, res.status);
}

function retryAfterMs(res: Response, now: number): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const ms = /^\d+$/.test(h.trim()) ? +h * 1000 : Date.parse(h) - now;
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

class Gate {
  private active = 0;
  private next = 0;
  private waiting: (() => void)[] = [];
  constructor(
    private pace: Pace,
    private now: () => number,
    private sleep: (ms: number) => Promise<void>,
  ) {}

  async enter(): Promise<void> {
    if (this.active < this.pace.concurrency) this.active++;
    else await new Promise<void>((go) => this.waiting.push(go)); // whoever leaves hands its slot over
    const at = Math.max(this.now(), this.next);
    this.next = at + this.pace.gapMs;
    if (at > this.now()) await this.sleep(at - this.now());
  }

  leave(): void {
    const go = this.waiting.shift();
    if (go) go();
    else this.active--;
  }
}

interface Entry {
  at: number;
  status: number;
  statusText: string;
  type: string | null;
  body: ArrayBuffer;
}

/** Statuses that must not carry a body, even an empty one. */
const BODILESS = new Set([204, 205, 304]);

export function createFetcher(o: FetcherOptions = {}): Fetcher {
  const net: FetchLike = o.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cacheMs = o.cacheMs ?? 600_000;
  const cacheMax = o.cacheMaxBytes ?? 128 * 1048576;
  const retries = o.retries ?? 2;
  const timeoutMs = o.timeoutMs ?? 30_000;
  const paceFor = { ...DEFAULT_PACE_FOR, ...o.paceFor };
  const stats = { requests: 0, cacheHits: 0, retries: 0, blocked: 0 };

  const gates = new Map<string, Gate>();
  const gateFor = (url: string) => {
    const site = siteOf(url);
    let g = gates.get(site);
    if (!g) gates.set(site, (g = new Gate({ ...DEFAULT_PACE, ...o.pace, ...paceFor[site] }, now, sleep)));
    return g;
  };

  const cache = new Map<string, Entry>();
  let cacheBytes = 0;
  const drop = (key: string) => {
    const e = cache.get(key);
    if (e) cacheBytes -= e.body.byteLength;
    cache.delete(key);
  };
  /** Every request this server makes is a read, so a POST with the same body is as reusable as a GET. */
  const keyOf = (url: string, init?: RequestInit) => {
    if (!cacheMs || (init?.body != null && typeof init.body !== 'string')) return undefined;
    return `${(init?.method ?? 'GET').toUpperCase()} ${url}\n${init?.body ?? ''}`;
  };
  const toResponse = (e: Entry) =>
    new Response(BODILESS.has(e.status) ? null : e.body, { status: e.status, statusText: e.statusText, headers: e.type ? { 'content-type': e.type } : undefined });
  const remember = async (key: string, res: Response): Promise<Entry> => {
    const e: Entry = { at: now(), status: res.status, statusText: res.statusText, type: res.headers.get('content-type'), body: await res.arrayBuffer() };
    if (e.body.byteLength > cacheMax / 2) return e; // too big to keep, still usable for this answer
    drop(key);
    cache.set(key, e);
    cacheBytes += e.body.byteLength;
    for (const [k, old] of cache) {
      if (cacheBytes <= cacheMax && now() - old.at < cacheMs) break; // oldest first: stop at the first one worth keeping
      drop(k);
    }
    return e;
  };

  const http = async (url: string, init?: RequestInit): Promise<Response> => {
    const gate = gateFor(url);
    await gate.enter();
    try {
      for (let attempt = 0; ; attempt++) {
        const timeout = AbortSignal.timeout(timeoutMs);
        let res: Response;
        stats.requests++;
        try {
          res = await net(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
        } catch (e) {
          // A dropped connection is worth another try. A timeout or a cancelled search is not.
          const gaveUp = (e as Error).name === 'AbortError' || (e as Error).name === 'TimeoutError';
          if (gaveUp || attempt >= retries) throw e;
          stats.retries++;
          await sleep(400 * 2 ** attempt);
          continue;
        }
        await refuseBotCheck(url, res);
        const wait = retryAfterMs(res, now());
        // 429 means "slow down": only come back when the site says when, and soon. 502-504 are passing faults.
        const again = res.status === 429 ? wait !== undefined && wait <= MAX_RETRY_AFTER_MS : RETRY_STATUS.has(res.status) && (wait ?? 0) <= MAX_RETRY_AFTER_MS;
        if (!again || attempt >= retries) return res;
        stats.retries++;
        await res.body?.cancel().catch(() => {});
        await sleep(wait ?? 400 * 2 ** attempt);
      }
    } finally {
      gate.leave();
    }
  };

  const run: FetchLike = async (url, init) => {
    const key = keyOf(url, init);
    const hit = key ? cache.get(key) : undefined;
    if (hit && now() - hit.at < cacheMs) {
      stats.cacheHits++;
      return toResponse(hit);
    }
    try {
      const res = await http(url, init);
      return key && res.ok ? toResponse(await remember(key, res)) : res;
    } catch (e) {
      if (e instanceof BlockedError) stats.blocked++;
      throw e;
    }
  };

  return Object.assign(run, {
    stats: (): FetcherStats => ({ ...stats, cacheEntries: cache.size, cacheMb: Math.round((cacheBytes / 1048576) * 10) / 10 }),
  });
}
