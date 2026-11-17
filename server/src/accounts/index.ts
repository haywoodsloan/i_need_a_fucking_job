/**
 * Puts accounts together for the server: reads the settings, opens the database, and answers the account routes.
 *
 * Accounts are off until the server has its password secret (AUTH_PEPPER). `npm run admin -- setup <email>` creates
 * one. With accounts off, none of this code or its dependencies is loaded, and the search server runs as before.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { FetchLike } from '../../../src/jobs/types';
import { MIGRATIONS } from '../db/migrations';
import { migrate, openDb, type Db, type LockHolder } from '../db/db';
import { deriveKey, sameBytes, type KdfParams } from './crypto';
import { runAdminCommand, type AdminCommand } from './admin-commands';
import { createAccountHttp } from './http';
import { makeBreachCheck } from './policy';
import { createAccountService, type AccountService } from './service';

type Env = Record<string, string | undefined>;

export interface AccountsConfig {
  peppers: Map<number, Buffer>;
  pepperVersion: number;
  /** Where the signed-in app is served from. The first one is used in invite and reset links. */
  origins: string[];
  secureCookies: boolean;
  /** Folder holding the local database. */
  dataDir: string;
  breachCheck: boolean;
  /** How many proxies stand between the internet and this server. 0 means none: a connection's own address is the client's. */
  trustedProxies: number;
  port: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const DEFAULT_DATA_DIR = fileURLToPath(new URL('../../.data', import.meta.url));

/** "1:BASE64" or just "BASE64" (version 1). The secret is 32 random bytes. */
function parsePepper(entry: string, name: string): [number, Buffer] {
  const m = /^(?:(\d+):)?([A-Za-z0-9+/=_-]+)$/.exec(entry.trim());
  const bytes = m ? Buffer.from(m[2], 'base64') : undefined;
  if (!m || bytes?.length !== 32) throw new ConfigError(`${name} must be 32 random bytes in base64, optionally with a version in front ("2:..."). Run "npm run admin -- setup" to create one.`);
  return [m[1] ? Number(m[1]) : 1, bytes];
}

function parseOrigins(env: Env, port: number): string[] {
  const list = (env.APP_ORIGIN || `http://localhost:5173,http://localhost:${port}`).split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw new ConfigError('APP_ORIGIN has no address in it.');
  return list.map((entry) => {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new ConfigError(`APP_ORIGIN has an entry that is not an address: "${entry}"`);
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
      throw new ConfigError(`APP_ORIGIN "${entry}" must be https. Plain http is only accepted for localhost, because the sign-in cookie would travel unprotected.`);
    }
    return url.origin;
  });
}

/** The account settings, or undefined when accounts are switched off (no AUTH_PEPPER). */
export function readAccountsConfig(env: Env): AccountsConfig | undefined {
  if (!env.AUTH_PEPPER) return undefined;
  const [pepperVersion, current] = parsePepper(env.AUTH_PEPPER, 'AUTH_PEPPER');
  const peppers = new Map([[pepperVersion, current]]);
  for (const entry of (env.AUTH_PEPPER_OLD ?? '').split(',').filter((s) => s.trim())) {
    const [version, bytes] = parsePepper(entry, 'AUTH_PEPPER_OLD');
    if (!peppers.has(version)) peppers.set(version, bytes);
  }
  const port = Number(env.PORT ?? 8787);
  const origins = parseOrigins(env, port);
  if (!/^\d{0,2}$/.test(env.TRUST_PROXY ?? '')) throw new ConfigError('TRUST_PROXY must be the number of proxies in front of this server (leave it out when there are none).');
  return {
    peppers,
    pepperVersion,
    origins,
    secureCookies: origins.every((o) => o.startsWith('https:')),
    dataDir: env.ACCOUNTS_DATA_DIR || DEFAULT_DATA_DIR,
    breachCheck: env.PASSWORD_BREACH_CHECK !== '0',
    trustedProxies: Number(env.TRUST_PROXY ?? 0),
    port,
  };
}

export const databaseDir = (config: AccountsConfig) => `${config.dataDir}/pg`;

/**
 * The address attempts are counted against. Behind proxies it is read from X-Forwarded-For, where each proxy adds
 * the address it was called from: the entry our outermost proxy added is `trustedProxies` places from the end.
 * Everything before that entry was sent by the caller and proves nothing, so it is never used.
 */
export function clientAddress(socketAddress: string | undefined, forwardedFor: string | string[] | undefined, trustedProxies: number): string {
  const direct = socketAddress ?? 'unknown';
  if (trustedProxies < 1) return direct;
  const chain = [forwardedFor ?? []].flat().join(',').split(',').map((s) => s.trim()).filter(Boolean);
  // A shorter list than expected means the request did not come through the proxies at all.
  return chain.length >= trustedProxies ? chain[chain.length - trustedProxies] : direct;
}

/** The secret the admin command line shows the running server. Both sides work it out from the password secret. */
export const adminToken = (config: AccountsConfig) => deriveKey(config.peppers.get(config.pepperVersion)!, 'job-hunt/v1/admin-channel');

export interface OpenAccountsOptions {
  holder?: LockHolder;
  /** For tests: an in-memory database, a fake clock, a fake breach list, cheaper hashing. */
  db?: Db;
  now?: () => Date;
  fetch?: FetchLike;
  kdf?: KdfParams;
}

/** Opens the database, brings its tables up to date and returns the account operations. */
export async function openAccounts(config: AccountsConfig, o: OpenAccountsOptions = {}): Promise<{ service: AccountService; db: Db }> {
  const db = o.db ?? (await openDb({ dir: databaseDir(config), holder: o.holder }));
  try {
    await migrate(db, MIGRATIONS);
  } catch (e) {
    await db.close();
    throw e;
  }
  const fetch: FetchLike = o.fetch ?? ((url, init) => globalThis.fetch(url, init));
  // A new password is accepted when the breach list cannot be asked. Say so in the server's log, at most hourly.
  let warnedAt = 0;
  const onUnavailable = (why: string) => {
    if (Date.now() - warnedAt < 3_600_000) return;
    warnedAt = Date.now();
    console.warn(`accounts: the list of breached passwords was not checked for a new password (${why}). The password was accepted without that check.`);
  };
  const service = createAccountService({
    db,
    peppers: config.peppers,
    pepperVersion: config.pepperVersion,
    kdf: o.kdf,
    breached: config.breachCheck ? makeBreachCheck(fetch, { onUnavailable }) : undefined,
    now: o.now,
  });
  return { service, db };
}

const MAX_BODY = 16 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const OWNED = /^\/api\/(auth|account|vault|admin)(\/|$)/;

export type Accounts = Awaited<ReturnType<typeof startAccounts>>;

/** Accounts as the HTTP server uses them. */
export async function startAccounts(config: AccountsConfig, o: OpenAccountsOptions = {}) {
  const { service, db } = await openAccounts(config, { holder: { pid: process.pid, role: 'server', port: config.port }, ...o });
  const http = createAccountHttp({ service, origins: config.origins, secureCookies: config.secureCookies });
  const token = adminToken(config);

  const addressOf = (req: IncomingMessage) => clientAddress(req.socket.remoteAddress, req.headers['x-forwarded-for'], config.trustedProxies);

  async function readJson(req: IncomingMessage): Promise<unknown> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw new RangeError('too large');
      chunks.push(chunk as Buffer);
    }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  }

  /**
   * `npm run admin` commands reach a running local server here, because only one process may have the local
   * database open. It answers only on the loopback interface, only to a caller that knows a secret derived from
   * AUTH_PEPPER, and never to a browser (browsers always say which page a POST came from).
   */
  async function adminChannel(req: IncomingMessage, body: unknown): Promise<{ status: number; body: unknown }> {
    const h = req.headers;
    const given = /^Bearer ([0-9a-f]{64})$/.exec(h.authorization ?? '')?.[1];
    const fromHere = LOOPBACK.has(req.socket.remoteAddress ?? '') && !h.origin && !h['x-forwarded-for'] && !h.forwarded && !h['fly-client-ip'];
    if (req.method !== 'POST' || !fromHere || !given || !sameBytes(Buffer.from(given, 'hex'), token)) return { status: 404, body: { error: 'Not found.', code: 'not_found' } };
    try {
      return { status: 200, body: { ok: true, lines: await runAdminCommand(service, config, body as AdminCommand) } };
    } catch (e) {
      return { status: 200, body: { ok: false, error: (e as Error).message } };
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const send = (status: number, body: unknown, headers: Record<string, string | string[]> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
      res.end(JSON.stringify(body));
    };
    let body: unknown;
    if (req.method === 'POST') {
      try {
        body = await readJson(req);
      } catch (e) {
        return send(e instanceof RangeError ? 413 : 400, { error: e instanceof RangeError ? 'That request is too large.' : 'That request is not valid JSON.', code: 'bad_request' });
      }
    }
    if (url.pathname === '/api/admin/run') {
      const result = await adminChannel(req, body);
      return send(result.status, result.body);
    }
    const reply = await http.handle({
      method: req.method ?? 'GET',
      path: url.pathname,
      headers: req.headers as Record<string, string | undefined>,
      body,
      address: addressOf(req),
    });
    send(reply.status, reply.body, { ...reply.headers, ...(reply.cookies.length ? { 'Set-Cookie': reply.cookies } : {}) });
  }

  return {
    /** Whether a path belongs to accounts. Such requests must not get the search API's CORS headers. */
    owns: (path: string) => OWNED.test(path),
    handle,
    close: () => db.close(),
    service,
    http,
    config,
  };
}
