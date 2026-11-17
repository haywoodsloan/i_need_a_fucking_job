/**
 * No test may talk to the real network.
 *
 * A test that reaches a live site is slow, fails when the site changes or is down, and can get this project's
 * address rate-limited. So the global `fetch` is replaced with one that only lets through calls to this machine
 * (tests that start a real server on 127.0.0.1 need that) and fails everything else with a message that says what
 * to do instead.
 *
 * What to do instead:
 *   - Code that takes a `fetch` (adapters, the fetch pipeline, the account service): pass a fake one, or replay a
 *     recorded answer with test/helpers/cassette.ts.
 *   - Code that calls the global `fetch` (the browser-side clients): `vi.stubGlobal('fetch', fake)`. The stub is
 *     removed after each test, and this guard is back.
 *
 * This guards `fetch` only. Nothing in the tests opens sockets any other way except to 127.0.0.1.
 */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const realFetch = globalThis.fetch;

type FetchInput = Parameters<typeof fetch>[0];

const addressOf = (input: FetchInput): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

function hostOf(input: FetchInput): string | undefined {
  try {
    return new URL(addressOf(input)).hostname;
  } catch {
    return undefined; // a relative address: there is nothing on the network to reach
  }
}

export class NetworkInTestError extends Error {
  constructor(target: string) {
    super(
      `A test tried to reach the network: ${target}\n` +
        'Tests never call live sites. Pass a fake fetch, replay a recorded answer (test/helpers/cassette.ts), or stub the global fetch. See docs/testing.md.',
    );
    this.name = 'NetworkInTestError';
  }
}

globalThis.fetch = function guardedFetch(input: FetchInput, init?: RequestInit): Promise<Response> {
  const host = hostOf(input);
  if (host !== undefined && LOCAL_HOSTS.has(host)) return realFetch(input, init);
  return Promise.reject(new NetworkInTestError(addressOf(input)));
} as typeof fetch;
