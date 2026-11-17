/**
 * A stand-in for the app's server in component tests. It replaces the browser's `fetch`, which is the only way the
 * pages reach the server, so the pages and the client code under them run for real.
 *
 *   const server = fakeServer({
 *     'POST /api/search': () => ({ jobs: [], sources: [] }),          // a value is sent as JSON with status 200
 *     'GET /api/job': () => refusal(500, 'server_error', 'It broke'),   // or return a Response
 *   });
 *   ...
 *   expect(server.sent('POST /api/search')[0].body).toEqual({ ... });
 *
 * A request the test gave no answer for fails the test when it ends. Routes can be replaced while a test runs
 * (`server.routes['GET /api/health'] = ...`) to change what the server says next.
 *
 * The real server's side of these routes is tested in test/server/ and test/integration/. If a reply shape changes
 * there, the types in src/account/api.ts and src/jobs/types.ts change with it, and the fakes built on this stop
 * compiling.
 */
import { expect, onTestFinished, vi } from 'vitest';
import type { ErrorCode, ErrorReply } from '../account/api';

export interface Call {
  method: string;
  /** Path without the query, e.g. "/api/job". */
  path: string;
  query: Record<string, string>;
  /** The JSON body, already read. */
  body: unknown;
  /** The address the page asked: the server's origin when it named one, its own otherwise. */
  origin: string;
}

export type Route = (call: Call) => unknown;

export function fakeServer(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const unexpected: string[] = [];

  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.origin);
    const method = (init?.method ?? 'GET').toUpperCase();
    const call: Call = {
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      origin: url.origin,
    };
    calls.push(call);
    const route = routes[`${method} ${url.pathname}`];
    if (!route) {
      unexpected.push(`${method} ${url.pathname}`);
      return new Response('Not found', { status: 404 });
    }
    const answer = await route(call);
    return answer instanceof Response ? answer : Response.json(answer);
  });

  onTestFinished(() => {
    expect(unexpected, 'requests the test gave the fake server no answer for').toEqual([]);
  });

  return {
    routes,
    calls,
    /** The calls made to one route, e.g. `sent('POST /api/search')`. */
    sent: (route: string) => calls.filter((c) => `${c.method} ${c.path}` === route),
  };
}

/** A failed reply in the shape every account route uses. */
export function refusal(status: number, code: ErrorCode, error: string, extra: Partial<ErrorReply> = {}): Response {
  return Response.json({ error, code, ...extra }, { status });
}

/** An answer that only arrives when the test says so, to look at the page while it waits. */
export function held<T>() {
  let release!: (value: T) => void;
  const answer = new Promise<T>((resolve) => (release = resolve));
  return { answer, release };
}
