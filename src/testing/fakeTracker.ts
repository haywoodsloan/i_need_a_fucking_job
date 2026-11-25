/**
 * A stand-in for the application tracker of the server, for component tests. It is not a second set of rules: it
 * runs the server's own routes (server/src/applications/http.ts) over records kept in memory, so a page under test
 * is answered exactly as the real server would answer it, down to the sentence of a refusal.
 *
 *   const tracker = fakeTracker([{ job: { title: 'Technical Writer', company: 'Example', postingUrl: 'https://…' } }]);
 *   const { user } = openApp('/applications', {}, tracker.routes);
 *   ...
 *   expect(tracker.get('example-technical-writer')?.stage).toBe('ready');
 *
 * The applications given at the start are there as if an assistant had added them, in the order given, a minute
 * apart. Every request after that moves the tracker's clock on by another minute.
 */
import { createTrackerHttp } from '../../server/src/applications/http';
import { memoryStore } from '../../server/src/applications/records';
import type { AddReply, ApplicationReply, Changes } from '../apply/api';
import { newApplication, type Application } from '../apply/model';
import type { Call, Route } from './fakeServer';

export interface FakeTrackerOptions {
  /** False for a server that keeps no applications. */
  available?: boolean;
}

export function fakeTracker(start: unknown[] = [], options: FakeTrackerOptions = {}) {
  let clock = Date.UTC(2026, 10, 24, 15, 0, 0);
  const tick = () => new Date((clock += 60_000));
  const seeded: Application[] = [];
  for (const raw of start) seeded.push(newApplication(raw, { by: 'assistant', now: tick(), taken: (id) => seeded.some((app) => app.id === id) }));
  const store = memoryStore(seeded);
  const http = createTrackerHttp({ store, now: () => new Date(clock), logError: () => {} });
  const here = window.location;

  /** A request the way an assistant's shell on the same computer sends it: no page behind it. */
  async function fromAssistant<T>(path: string, body: unknown): Promise<T> {
    tick();
    const reply = await http.handle({ method: 'POST', path, headers: { host: here.host, 'content-type': 'application/json' }, body, address: '127.0.0.1' });
    if (reply.status >= 400) throw new Error(`The fake tracker turned down POST ${path}: ${JSON.stringify(reply.body)}`);
    return reply.body as T;
  }

  /** What the page under test sent, answered by the real routes. */
  const fromPage: Route = async (call: Call) => {
    tick();
    const reply = await http.handle({
      method: call.method,
      path: call.path,
      headers: { host: here.host, origin: here.origin, 'sec-fetch-site': 'same-origin', ...(call.method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      body: call.body,
      address: '127.0.0.1',
    });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: reply.headers });
  };

  const routes: Record<string, Route> =
    options.available === false
      ? { 'GET /api/applications': () => ({ available: false, applications: [] }) }
      : { 'GET /api/applications': fromPage, 'POST /api/applications': fromPage, 'GET /api/applications/*': fromPage, 'POST /api/applications/*': fromPage };

  return {
    routes,
    store,
    /** Adds an application as an assistant does, and gives it back as the tracker keeps it. */
    add: async (application: unknown): Promise<Application> => (await fromAssistant<AddReply>('/api/applications', { application })).application,
    /** Changes an application as an assistant does, behind the page's back. */
    change: async (id: string, changes: Changes): Promise<Application> => (await fromAssistant<ApplicationReply>(`/api/applications/${id}`, { changes })).application,
    /** An application as the tracker keeps it now. */
    get: (id: string): Application | undefined => {
      const app = store.applications.get(id);
      return app && (JSON.parse(JSON.stringify(app)) as Application);
    },
    ids: () => [...store.applications.keys()].sort(),
  };
}
