/**
 * Calls to the application tracker of the server (server/src/applications/http.ts).
 *
 * They always go to the page's own address, never to the search server setting: the tracker belongs to the computer
 * the app's own server runs on, and answers nobody but that server's own page. Locally the dev server passes the
 * calls on (see vite.config.ts).
 *
 * Everything sent from here is marked as the user's, because only a person uses the page. What an assistant writes
 * reaches the tracker from outside the app, and is marked as the assistant's
 * (docs/decisions/0021-an-answer-is-marked-with-who-wrote-it.md).
 */
import type { AddReply, ApplicationReply, ApplicationsReply, Changes, ImportReply, TrackerErrorCode, TrackerErrorReply } from './api';
import type { Application } from './model';

/**
 * Whether this page looks for a tracker at all. The public demo on GitHub Pages has no server of its own, so it
 * never asks. A server that serves the app itself and keeps applications says so in the page
 * (server/src/static.ts). In local development the dev server passes the question on to the backend.
 */
export const TRACKER_ENABLED: boolean = import.meta.env.DEV || (typeof document !== 'undefined' && document.querySelector('meta[name="job-hunt-applications"]') !== null);

/** Every application as one file. A plain link to it downloads the file. */
export const EXPORT_PATH = '/api/applications/export';

/** A failed tracker call. `message` is a sentence that can be shown to the user as it is. */
export class TrackerError extends Error {
  constructor(
    /** `unreachable`: there was no answer from a tracker at all. */
    public code: TrackerErrorCode | 'unreachable',
    message: string,
    /** The HTTP status, or 0 when the request never got an answer. */
    public status: number,
    /** With `changed`: the application as it is now. */
    public application?: Application,
  ) {
    super(message);
    this.name = 'TrackerError';
  }
}

const UNREACHABLE = 'The server could not be reached. Check that it is running, then try again.';

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch {
    throw new TrackerError('unreachable', UNREACHABLE, 0);
  }
  // Anything that is not JSON did not come from the tracker: a dev server's fallback page, a proxy's error.
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  const data: unknown = isJson ? await res.json().catch(() => undefined) : undefined;
  if (res.ok && data !== undefined && data !== null) return data as T;
  const failure = data as Partial<TrackerErrorReply> | undefined;
  if (failure?.code && failure.error) throw new TrackerError(failure.code, failure.error, res.status, failure.application);
  throw new TrackerError('unreachable', UNREACHABLE, res.status);
}

const one = (id: string) => `/api/applications/${encodeURIComponent(id)}`;

export const trackerApi = {
  list: () => call<ApplicationsReply>('GET', '/api/applications'),
  get: (id: string) => call<ApplicationReply>('GET', one(id)),
  add: (application: unknown) => call<AddReply>('POST', '/api/applications', { by: 'user', application }),
  /**
   * With `revision`, the change is turned down when the application has changed since that revision was read. The
   * page gives it when what the user agrees to depends on what they were looking at.
   */
  change: (id: string, changes: Changes, revision?: number) => call<ApplicationReply>('POST', one(id), { by: 'user', revision, changes }),
  remove: (id: string) => call<object>('POST', `${one(id)}/remove`, { by: 'user' }),
  /** `file` is what an export gave, already read as JSON. */
  importFile: (file: unknown) => call<ImportReply>('POST', '/api/applications/import', { by: 'user', file }),
};

/** The sentence to show for a failed tracker call. */
export const trackerErrorText = (e: unknown) => (e instanceof TrackerError ? e.message : 'Something went wrong. Try again.');
