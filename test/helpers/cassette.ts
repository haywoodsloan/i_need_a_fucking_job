/**
 * Recorded answers from job sources, replayed in tests ("cassettes").
 *
 * A cassette is one JSON file in test/fixtures/sources/. It holds the requests a source makes for one search and
 * what the service answered. A test replays it through the same `fetch` slot the live server fills, so the
 * source's real code runs end to end, with no network and the same result every time.
 *
 * Two kinds, told apart by `origin`:
 *   - "recorded":    captured from the live service by `npm run fixtures:record` (server/src/record-fixtures.ts),
 *                    then cut down to a few postings.
 *   - "handwritten": typed up from the shape the service documents and the adapter reads. Good for the code paths,
 *                    but it cannot notice the service changing. Replace it with a recording when you can reach
 *                    the service.
 *
 * Nothing secret goes into a cassette: request headers are never stored and API keys in addresses are blanked
 * (see `scrubUrl`). docs/testing.md has the whole procedure.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FetchLike, JobQuery } from '../../src/jobs/types';

export interface RecordedRequest {
  method: string;
  url: string;
  /** The request body, for POSTs. */
  body?: string;
}

export interface RecordedResponse {
  status: number;
  /** Only the few headers that change how an answer is read (content-type, retry-after). */
  headers?: Record<string, string>;
  /** A JSON answer, kept as JSON so the file can be read and reviewed. */
  json?: unknown;
  /** Any other answer (an HTML page), as text. */
  text?: string;
}

export interface Exchange {
  request: RecordedRequest;
  response: RecordedResponse;
}

export interface Cassette {
  /** The source this belongs to, as in the file name: "greenhouse", "workday", ... */
  source: string;
  origin: 'recorded' | 'handwritten';
  /** The day it was recorded or written, YYYY-MM-DD. */
  date: string;
  /** What the reader should know: which company, what was trimmed. */
  note?: string;
  /** The search the exchanges belong to, so the test and the recorder run the same one. */
  search: { query: JobQuery; options?: unknown; env?: Record<string, string> };
  exchanges: Exchange[];
}

export const CASSETTE_DIR = fileURLToPath(new URL('../fixtures/sources/', import.meta.url));

export function loadCassette(name: string): Cassette {
  return JSON.parse(readFileSync(`${CASSETTE_DIR}${name}.json`, 'utf8')) as Cassette;
}

const SECRET_PARAMS = ['api_key', 'apikey', 'key', 'token', 'access_token'];

/** The address with any API key in it blanked, so a key is never written to a cassette or needed to replay one. */
export function scrubUrl(url: string): string {
  const u = new URL(url);
  for (const name of SECRET_PARAMS) if (u.searchParams.has(name)) u.searchParams.set(name, 'REDACTED');
  return u.href;
}

const requestOf = (url: string, init?: RequestInit): RecordedRequest => ({
  method: (init?.method ?? 'GET').toUpperCase(),
  url: scrubUrl(url),
  ...(typeof init?.body === 'string' ? { body: init.body } : {}),
});

const sameRequest = (a: RecordedRequest, b: RecordedRequest) => a.method === b.method && a.url === b.url && (a.body ?? '') === (b.body ?? '');

const describeRequest = (r: RecordedRequest) => `${r.method} ${r.url}${r.body ? `\n      body: ${r.body}` : ''}`;

export function toResponse(r: RecordedResponse): Response {
  const isJson = r.json !== undefined;
  const body = isJson ? JSON.stringify(r.json) : (r.text ?? '');
  // A Response can only be built with a status from 200 to 599. LinkedIn's 999 is the one answer outside it.
  const inRange = r.status >= 200 && r.status <= 599;
  const res = new Response(r.status === 204 || r.status === 304 ? null : body, {
    status: inRange ? r.status : 500,
    headers: { 'content-type': isJson ? 'application/json' : 'text/html; charset=utf-8', ...r.headers },
  });
  if (!inRange) Object.defineProperties(res, { status: { value: r.status }, ok: { value: false } });
  return res;
}

export interface Replay extends FetchLike {
  /** Every request made so far, in order. */
  calls: RecordedRequest[];
  /** Recorded exchanges no request has asked for. A test can check this is empty to catch a source that stopped making a call. */
  unused(): Exchange[];
}

/**
 * A `fetch` that answers from cassettes. A request the cassettes do not hold fails the test with the request spelled
 * out: either the source now asks for something different (fix it, or record again), or the test needs a fixture.
 */
export function replay(...cassettes: Cassette[]): Replay {
  const exchanges = cassettes.flatMap((c) => c.exchanges);
  const used = new Set<Exchange>();
  const calls: RecordedRequest[] = [];
  const fetch: FetchLike = async (url, init) => {
    const request = requestOf(url, init);
    calls.push(request);
    if (init?.signal?.aborted) throw init.signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
    const hit = exchanges.find((e) => sameRequest(e.request, request));
    if (!hit) {
      throw new Error(
        `No recorded answer for this request:\n    ${describeRequest(request)}\n` +
          `  The cassette${cassettes.length > 1 ? 's hold' : ' holds'}:\n${exchanges.map((e) => `    ${describeRequest(e.request)}`).join('\n') || '    (nothing)'}\n` +
          '  If the source is meant to ask for this, add it to the fixture or record again (docs/testing.md).',
      );
    }
    used.add(hit);
    return toResponse(hit.response);
  };
  return Object.assign(fetch, { calls, unused: () => exchanges.filter((e) => !used.has(e)) });
}

const KEPT_HEADERS = ['content-type', 'retry-after'];

/** How the recorder cuts an answer down before it is stored (a whole board can be tens of megabytes). */
export interface Trim {
  json?: (json: unknown, request: RecordedRequest) => unknown;
  text?: (text: string, request: RecordedRequest) => string;
}

/** Wraps a real `fetch` and writes down every exchange. Used by the recorder, not by tests. */
export function recording(real: FetchLike, trim: Trim = {}): FetchLike & { exchanges: Exchange[] } {
  const exchanges: Exchange[] = [];
  const fetch: FetchLike = async (url, init) => {
    const res = await real(url, init);
    const request = requestOf(url, init);
    const headers: Record<string, string> = {};
    for (const name of KEPT_HEADERS) {
      const value = res.headers.get(name);
      if (value) headers[name] = value;
    }
    const text = await res.text();
    let response: RecordedResponse;
    try {
      const json: unknown = JSON.parse(text);
      response = { status: res.status, headers, json: trim.json ? trim.json(json, request) : json };
    } catch {
      response = { status: res.status, headers, text: trim.text ? trim.text(text, request) : text };
    }
    if (!exchanges.some((e) => sameRequest(e.request, request))) exchanges.push({ request, response });
    // The caller gets what was stored, so the search the recorder runs is the search a replay will run.
    return toResponse(response);
  };
  return Object.assign(fetch, { exchanges });
}
