/**
 * The routes of the application tracker. Every one answers JSON, is never cached, and never carries CORS headers.
 *
 *   GET  /api/applications               the list: a summary of each application
 *   POST /api/applications               { by?, application }           adds one
 *   GET  /api/applications/export        all of them, whole, as one file
 *   POST /api/applications/import        { by?, file }, or the file     adds the ones in a file that are not here yet
 *   GET  /api/applications/<id>          one application, whole
 *   POST /api/applications/<id>          { by?, revision?, changes }    changes it (src/apply/model.ts says how)
 *   POST /api/applications/<id>/remove   { by: "user" }                 moves it out of the list
 *
 * The tracker has no sign-in: it belongs to the computer the server runs on, like a file in a folder there. So a
 * request is answered only when it comes from that computer itself:
 *
 *   - the connection comes from this computer, and no proxy says it passed the request on for someone else,
 *   - it was sent to "localhost" (or 127.0.0.1, or [::1]) by name, so a page elsewhere cannot reach it through a
 *     name of its own that points here,
 *   - and when a browser sent it, the page it came from is the app's own: the same address the request went to.
 *
 * `by` says who is making a change: "user" for the person, on the app's own page, and "assistant" for everything
 * else. Left out, it is "assistant". Only a request from a page can say "user". This keeps an honest caller from
 * marking its text as the user's by mistake. It is not a lock: any program on this computer could send what the
 * page sends, the same way it could edit the files.
 */
import type { AddReply, ApplicationReply, ApplicationsReply, ImportReply, TrackerErrorCode, TrackerErrorReply } from '../../../src/apply/api';
import { ApplicationError, LIMITS, changeApplication, fileEntries, isId, newApplication, postingKey, summarize, toFile, type Actor, type Application } from '../../../src/apply/model';
import type { ApplicationStore, Records } from './records';

export interface TrackerRequest {
  method: string;
  /** The path alone, such as "/api/applications/export". */
  path: string;
  /** Header names in lower case. */
  headers: Record<string, string | undefined>;
  /** The parsed JSON body of a POST. */
  body?: unknown;
  /** The network address at the other end of the connection. */
  address: string | undefined;
}

/** A request without what it carries: everything that decides whether it is answered at all. */
export type TrackerHead = Omit<TrackerRequest, 'body'>;

export interface TrackerReply {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export interface TrackerHttpOptions {
  store: ApplicationStore;
  now?: () => Date;
  logError?: (message: string, e: unknown) => void;
}

const REPLY_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export const BASE = '/api/applications';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
/** What a proxy adds when it passes a request on for someone else. */
const PASSED_ON = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'via', 'x-real-ip', 'fly-client-ip', 'cf-connecting-ip', 'true-client-ip'];

class TrackerError extends Error {
  constructor(
    public code: TrackerErrorCode,
    public status: number,
    message: string,
    public extra: Partial<TrackerErrorReply> = {},
  ) {
    super(message);
  }
}

const badRequest = (message: string) => new TrackerError('bad_request', 400, message);
const notFound = () => new TrackerError('not_found', 404, 'There is no such application.');

/** The name a request was sent to, without the port: "localhost" from "localhost:8787". */
function hostName(host: string | undefined): string | undefined {
  try {
    return host ? new URL(`http://${host}`).hostname : undefined;
  } catch {
    return undefined;
  }
}

/** Why this request is not from the computer the server runs on, or undefined when it is. */
function notLocal(req: TrackerHead): string | undefined {
  const local = LOOPBACK.has(req.address ?? '') && !PASSED_ON.some((name) => req.headers[name] !== undefined) && LOCAL_NAMES.has(hostName(req.headers.host) ?? '');
  return local ? undefined : 'Applications are kept on the computer the server runs on, and can only be reached from that computer, at http://localhost.';
}

/** Why this request is not from the app's own page, or undefined when it is, or when no page sent it. */
function originProblem(req: TrackerHead): string | undefined {
  const { origin } = req.headers;
  const site = req.headers['sec-fetch-site'];
  if (origin !== undefined) {
    let from: string | undefined;
    try {
      from = new URL(origin).host;
    } catch {
      /* "null", or not an address at all */
    }
    if (from === undefined || from !== req.headers.host?.toLowerCase()) return `This page (${origin.slice(0, 200)}) is not the app's own page.`;
  }
  // A browser says how the page that asked relates to this server. "none" is the person opening the address themselves.
  const fine = site === undefined || site === 'same-origin' || (site === 'none' && req.method === 'GET');
  return fine ? undefined : 'This request came from another site.';
}

type Route = { name: 'list' | 'add' | 'export' | 'import' } | { name: 'get' | 'change' | 'remove'; id: string };

/** The route a request is for. `undefined`: there is no such address. `false`: there is, but not with this method. */
function routeOf(method: string, path: string): Route | undefined | false {
  const pick = (routes: Partial<Record<string, Route>>) => routes[method] ?? false;
  if (path === BASE) return pick({ GET: { name: 'list' }, POST: { name: 'add' } });
  if (path === `${BASE}/export`) return pick({ GET: { name: 'export' } });
  if (path === `${BASE}/import`) return pick({ POST: { name: 'import' } });
  const [id, action, ...more] = path.startsWith(`${BASE}/`) ? path.slice(BASE.length + 1).split('/') : [];
  if (!isId(id) || more.length) return undefined;
  if (action === undefined) return pick({ GET: { name: 'get', id }, POST: { name: 'change', id } });
  if (action === 'remove') return pick({ POST: { name: 'remove', id } });
  return undefined;
}

/**
 * The route a request is for, once it has passed every check that needs nothing of what it carries: there is such
 * an address, it takes this method, the request comes from this computer and from the app's own page, and what it
 * carries is JSON. Throws the refusal otherwise.
 */
function admit(req: TrackerHead): Route {
  const route = routeOf(req.method, req.path);
  if (route === undefined) throw notFound();
  if (route === false) throw new TrackerError('bad_request', 405, 'That method is not allowed here.');
  const away = notLocal(req);
  if (away) throw new TrackerError('not_local', 403, away);
  const origin = originProblem(req);
  if (origin) throw new TrackerError('bad_origin', 403, origin);
  // A page on another site cannot send JSON here without asking first, and that question gets no answer.
  if (req.method === 'POST' && !/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) throw badRequest('Send JSON.');
  return route;
}

/** A few words that name an entry of a file, for the list of what was not imported. */
function entryName(raw: unknown, i: number): string {
  const job = (raw as { job?: { title?: unknown; company?: unknown } } | null)?.job;
  const words = [job?.company, job?.title].filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim().slice(0, 80));
  return words.length ? words.join(', ') : `Entry ${i + 1}`;
}

export function createTrackerHttp(o: TrackerHttpOptions) {
  const { store } = o;
  const now = o.now ?? (() => new Date());
  const logError = o.logError ?? ((message: string, e: unknown) => console.error(message, e));

  /** Who is making the change. */
  function actor(req: TrackerRequest, body: Record<string, unknown>): Actor {
    if (body.by === undefined) return 'assistant';
    if (body.by !== 'user' && body.by !== 'assistant') throw badRequest('"by" is "user" or "assistant".');
    // Only the app's own page speaks for the user, and a browser always says which page a POST came from.
    if (body.by === 'user' && req.headers.origin === undefined) {
      throw new TrackerError('refused', 403, 'Only the app\'s own page saves as the user. Leave "by" out, or send "assistant".');
    }
    return body.by;
  }

  const samePosting = (records: Records, app: Application) => records.all().find((other) => postingKey(other.job.postingUrl) === postingKey(app.job.postingUrl));

  const full = (records: Records) => records.all().length + records.unreadable().length >= LIMITS.applications;

  async function run(route: Route, req: TrackerRequest, body: Record<string, unknown>): Promise<{ status?: number; body: unknown }> {
    switch (route.name) {
      case 'list':
        return store.transaction((records) => {
          const applications = records
            .all()
            .map(summarize)
            .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
          return { body: { available: true, applications, unreadable: records.unreadable() } satisfies ApplicationsReply };
        });

      case 'export':
        return store.transaction((records) => ({ body: toFile(records.all(), now()) }));

      case 'get':
        return store.transaction((records) => {
          const application = records.get(route.id);
          if (!application) throw notFound();
          return { body: { application } satisfies ApplicationReply };
        });

      case 'add': {
        const by = actor(req, body);
        return store.transaction((records) => {
          const application = newApplication(body.application, { by, now: now(), taken: (id) => records.taken(id) });
          // Saving a posting twice gives back the application that is there, so a second press adds nothing.
          const same = samePosting(records, application);
          if (same) return { body: { application: same, existed: true } satisfies AddReply };
          if (records.taken(application.id)) throw new TrackerError('exists', 409, `There is already an application with the id "${application.id}".`);
          if (full(records)) throw new TrackerError('full', 409, `The tracker holds ${LIMITS.applications} applications and takes no more.`);
          records.put(application);
          return { status: 201, body: { application, existed: false } satisfies AddReply };
        });
      }

      case 'change': {
        const by = actor(req, body);
        const { revision } = body;
        if (revision !== undefined && !Number.isInteger(revision)) throw badRequest('"revision" is the number the application had when you read it.');
        return store.transaction((records) => {
          const before = records.get(route.id);
          if (!before) throw notFound();
          if (revision !== undefined && revision !== before.revision) {
            throw new TrackerError('changed', 409, 'This application changed since it was read. Look at it as it is now, then make the change again.', { application: before });
          }
          const application = changeApplication(before, body.changes, { by, now: now() });
          if (application !== before) records.put(application);
          return { body: { application } satisfies ApplicationReply };
        });
      }

      case 'remove': {
        if (actor(req, body) !== 'user') {
          throw new TrackerError('refused', 403, "Only the user removes an application, on the app's own page. An assistant sets its stage to withdrawn or closed instead.");
        }
        return store.transaction((records) => {
          if (!records.get(route.id)) throw notFound();
          records.remove(route.id);
          return { body: {} };
        });
      }

      case 'import': {
        const by = actor(req, body);
        // The file may be sent as it is, which is what a command line does with a file on disk, or wrapped as { by, file }.
        const entries = fileEntries(body.format !== undefined ? body : body.file);
        return store.transaction((records) => {
          const reply: ImportReply = { added: [], skipped: [] };
          entries.forEach((raw, i) => {
            try {
              const given = (raw as { id?: unknown } | null)?.id;
              if (isId(given) && records.taken(given)) throw new ApplicationError('invalid', `An application with the id "${given}" is already here.`);
              const application = newApplication(raw, { by, now: now(), taken: (id) => records.taken(id), imported: true });
              const same = samePosting(records, application);
              if (same) throw new ApplicationError('invalid', `This posting is already tracked, as "${same.id}".`);
              if (full(records)) throw new ApplicationError('invalid', `The tracker holds ${LIMITS.applications} applications and takes no more.`);
              records.put(application);
              reply.added.push(application.id);
            } catch (e) {
              if (!(e instanceof ApplicationError)) throw e;
              reply.skipped.push({ what: entryName(raw, i), why: e.message });
            }
          });
          return { body: reply };
        });
      }
    }
  }

  const reply = (status: number, body: unknown): TrackerReply => ({ status, body, headers: { ...REPLY_HEADERS } });

  /** The answer to a request that was turned down, or that failed. */
  function failed(req: TrackerHead, e: unknown): TrackerReply {
    const refusal = e instanceof ApplicationError ? new TrackerError(e.code, e.code === 'refused' ? 403 : 400, e.message) : e;
    if (refusal instanceof TrackerError) return reply(refusal.status, { error: refusal.message, code: refusal.code, ...refusal.extra } satisfies TrackerErrorReply);
    // Never the request itself: it holds someone's answers.
    logError(`applications: ${req.method} ${req.path} failed:`, e);
    return reply(500, { error: 'Something went wrong on the server.', code: 'server_error' } satisfies TrackerErrorReply);
  }

  /**
   * The answer for a request that is turned down whatever it carries, or undefined for one that may go on. The
   * server asks this before it reads a request's body, so that whoever is not answered cannot make it keep or read
   * anything.
   */
  function refusal(req: TrackerHead): TrackerReply | undefined {
    try {
      admit(req);
      return undefined;
    } catch (e) {
      return failed(req, e);
    }
  }

  async function handle(req: TrackerRequest): Promise<TrackerReply> {
    try {
      const route = admit(req);
      let body: Record<string, unknown> = {};
      if (req.method === 'POST') {
        if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) throw badRequest('Send a JSON object.');
        body = req.body as Record<string, unknown>;
      }
      const outcome = await run(route, req, body);
      return reply(outcome.status ?? 200, outcome.body);
    } catch (e) {
      return failed(req, e);
    }
  }

  return { handle, refusal };
}
