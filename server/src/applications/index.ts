/**
 * Puts the application tracker together for the server: decides whether this server keeps applications at all,
 * opens the folder they are kept in, and answers the tracker's routes. docs/applications.md describes the tracker.
 *
 * The tracker has no sign-in. Whoever can reach it can read and change every application, so it is only switched
 * on where nobody but the computer's own user can reach the server
 * (docs/decisions/0020-applications-are-kept-by-the-server-on-its-own-computer.md):
 *
 *   - the server answers this computer only (HOST is not set, see listen.ts),
 *   - nothing says a proxy passes other people's requests on to it (TRUST_PROXY), and it is not marked as a hosted
 *     copy (NODE_ENV=production),
 *   - and APPLICATIONS=0 was not set to switch it off.
 *
 * http.ts checks every single request on top of that.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, createTrackerHttp } from './http';
import type { ApplicationStore } from './records';
import { fileStore } from './store';

type Env = Record<string, string | undefined>;

export const DEFAULT_APPLICATIONS_DIR = fileURLToPath(new URL('../../.data/applications', import.meta.url));

export type ApplicationsConfig = { on: true; dir: string } | { on: false; why: string };

/** Whether this server keeps applications, and where. `local` is whether it answers this computer only. */
export function readApplicationsConfig(env: Env, local: boolean): ApplicationsConfig {
  if (/^(?:0|off|false|no)$/i.test((env.APPLICATIONS ?? '').trim())) return { on: false, why: 'APPLICATIONS=0 switches them off' };
  if (!local) return { on: false, why: 'HOST lets other computers reach this server, and applications have no sign-in' };
  if (Number(env.TRUST_PROXY ?? 0) > 0) return { on: false, why: 'TRUST_PROXY says a proxy passes requests on to this server, and applications have no sign-in' };
  if (env.NODE_ENV === 'production') return { on: false, why: 'NODE_ENV=production marks this as a hosted copy, and applications have no sign-in' };
  return { on: true, dir: env.APPLICATIONS_DIR ? resolve(env.APPLICATIONS_DIR) : DEFAULT_APPLICATIONS_DIR };
}

/** A change to one application is small. A file of them, with every posting's text in it, is not. */
const MAX_BODY = 4 * 1024 * 1024;
const MAX_IMPORT = 32 * 1024 * 1024;
const OWNED = new RegExp(`^${BASE}(/|$)`);

export interface StartApplicationsOptions {
  /** For tests: a clock, and records kept somewhere else than in files. */
  now?: () => Date;
  store?: ApplicationStore;
  logError?: (message: string, e: unknown) => void;
}

export type Applications = ReturnType<typeof startApplications>;

/** The tracker as the HTTP server uses it. */
export function startApplications(config: { dir: string }, o: StartApplicationsOptions = {}) {
  const store = o.store ?? fileStore(config.dir, { now: o.now });
  const http = createTrackerHttp({ store, now: o.now, logError: o.logError });

  async function readJson(req: IncomingMessage, max: number): Promise<unknown> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      // Past the limit, the rest is still read, and thrown away: the sender then gets an answer that says what was
      // wrong, where stopping in the middle would only break the connection.
      if (size <= max) chunks.push(chunk as Buffer);
    }
    if (size > max) throw new RangeError('too large');
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
      // The export is also a file someone may open and read, so it is laid out for that.
      res.end(url.pathname === `${BASE}/export` ? JSON.stringify(body, null, 2) : JSON.stringify(body));
    };
    const head = { method: req.method ?? 'GET', path: url.pathname, headers: req.headers as Record<string, string | undefined>, address: req.socket.remoteAddress };
    // Whoever is not answered is told so before anything they sent is kept or read as JSON. A page of another site
    // can send any amount of text here, and it must cost this server nothing.
    const no = http.refusal(head);
    if (no) return send(no.status, no.body, no.headers);
    let body: unknown;
    if (req.method === 'POST') {
      try {
        body = await readJson(req, url.pathname === `${BASE}/import` ? MAX_IMPORT : MAX_BODY);
      } catch (e) {
        return send(e instanceof RangeError ? 413 : 400, { error: e instanceof RangeError ? 'That request is too large.' : 'That request is not valid JSON.', code: 'bad_request' });
      }
    }
    const reply = await http.handle({ ...head, body });
    send(reply.status, reply.body, reply.headers);
  }

  return {
    /** Whether a path belongs to the tracker. Such requests must not get the search API's CORS headers. */
    owns: (path: string) => OWNED.test(path),
    handle,
    http,
  };
}
