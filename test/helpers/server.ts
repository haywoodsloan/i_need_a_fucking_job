/**
 * Starts the search server's request handling (server/src/app.ts) on a real socket on this machine, with
 * everything outside it faked: recorded answers instead of job sites, a clock the test moves by hand, and no
 * waiting between requests.
 */
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, type AppParts } from '../../server/src/app';
import { createFetcher, type FetcherOptions } from '../../server/src/fetcher';
import type { FetchLike } from '../../src/jobs/types';

export interface TestServerOptions extends Partial<Omit<AppParts, 'fetch' | 'now'>> {
  /** The network the fetch pipeline sees: a replay, or any fake. */
  network: FetchLike;
  fetcher?: Partial<FetcherOptions>;
}

export interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  /** The body read as JSON. Throws when it is not. */
  json<T = Record<string, unknown>>(): T;
}

export interface TestServer {
  url: string;
  /** Moves the server's clock forward. */
  advance(ms: number): void;
  /** What the server would have printed as errors. */
  errors: unknown[];
  get(path: string, headers?: Record<string, string>): Promise<Reply>;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<Reply>;
  send(method: string, path: string, body?: string, headers?: Record<string, string>): Promise<Reply>;
  close(): Promise<void>;
}

export async function startTestServer(o: TestServerOptions): Promise<TestServer> {
  let clock = Date.UTC(2026, 10, 17, 12, 0, 0);
  const now = () => clock;
  const errors: unknown[] = [];
  const { network, fetcher: fetcherOptions, ...parts } = o;
  // The real pipeline, so caching, pacing and bot-check reporting are part of what is tested. It never sleeps.
  const fetch = createFetcher({ fetch: network, now, sleep: async () => {}, retries: 0, ...fetcherOptions });
  const server = createServer(createApp({ env: {}, logError: (e) => errors.push(e), ...parts, fetch, now }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  // node:http and not fetch: a browser's fetch would refuse to send some of the headers these tests need (Origin).
  const send = (method: string, path: string, body?: string, headers: Record<string, string> = {}) =>
    new Promise<Reply>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } : {}), ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) });
        });
      });
      req.on('error', reject);
      req.end(body);
    });

  return {
    url: `http://127.0.0.1:${port}`,
    advance: (ms) => void (clock += ms),
    errors,
    send,
    get: (path, headers) => send('GET', path, undefined, headers),
    post: (path, body, headers) => send('POST', path, typeof body === 'string' ? body : JSON.stringify(body), headers),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}
