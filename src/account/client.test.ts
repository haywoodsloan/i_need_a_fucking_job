import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadAccountState } from './AccountProvider';
import { AccountApiError, accountApi, describeDevice } from './client';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

/** Replaces fetch with canned answers, one per call, and records what was asked. */
function answers(...replies: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = replies.shift();
    if (!next) throw new Error('no answer prepared');
    if (next instanceof Error) throw next;
    return next;
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('calls to the account routes', () => {
  it("go to the page's own address as JSON, with the cookie left to the browser", async () => {
    const calls = answers(json(200, { user: { email: 'a@example.com', role: 'user' } }), json(200, { available: true, user: null }));
    await accountApi.signIn('a@example.com', 'a long enough password');
    expect(calls[0].url).toBe('/api/auth/sign-in');
    expect(calls[0].init).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ email: 'a@example.com', password: 'a long enough password' });

    await accountApi.session();
    expect(calls[1].url).toBe('/api/auth/session');
    expect(calls[1].init.method).toBe('GET');
    expect(calls[1].init.body).toBeUndefined();
  });

  it("turn the server's refusal into an error that carries its sentence and code", async () => {
    answers(json(400, { error: 'Use at least 14 characters. A few unrelated words work well.', code: 'weak_password', problem: 'too_short' }));
    const failed = await accountApi.acceptInvite('code', 'short').catch((e) => e);
    expect(failed).toBeInstanceOf(AccountApiError);
    expect(failed).toMatchObject({ code: 'weak_password', status: 400, problem: 'too_short', message: 'Use at least 14 characters. A few unrelated words work well.' });

    answers(json(429, { error: 'Too many attempts. Try again in 5 minutes.', code: 'rate_limited', retryAfter: 300 }));
    expect(await accountApi.signIn('a@example.com', 'x').catch((e) => e)).toMatchObject({ code: 'rate_limited', retryAfter: 300 });
  });

  it('treat anything that is not an answer from the account server as unreachable', async () => {
    // The request never got through.
    answers(new TypeError('Failed to fetch'));
    expect(await accountApi.session().catch((e) => e)).toMatchObject({ code: 'unreachable', status: 0 });
    // A dev server with no backend behind it answers with the app's own page.
    answers(new Response('<!doctype html><html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    expect(await accountApi.session().catch((e) => e)).toMatchObject({ code: 'unreachable', status: 200 });
    // A proxy whose backend is down.
    answers(new Response('', { status: 500, headers: { 'Content-Type': 'text/plain' } }));
    expect(await accountApi.session().catch((e) => e)).toMatchObject({ code: 'unreachable', status: 500 });
    // JSON, but not from the account server.
    answers(json(404, { error: 'Not found' }));
    expect(await accountApi.session().catch((e) => e)).toMatchObject({ code: 'unreachable', status: 404 });
    answers(new Response('{"broken', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    expect(await accountApi.session().catch((e) => e)).toMatchObject({ code: 'unreachable', status: 200 });
  });
});

describe('finding out who is signed in', () => {
  const noWait = async () => {};

  it('reports the signed-in user, nobody, or accounts switched off', async () => {
    answers(json(200, { available: true, user: { email: 'a@example.com', role: 'admin' }, vault: { unlocked: true, until: '2026-11-17T13:00:00.000Z' } }));
    expect(await loadAccountState()).toEqual({ status: 'signed-in', user: { email: 'a@example.com', role: 'admin' }, vault: { unlocked: true, until: '2026-11-17T13:00:00.000Z' } });
    answers(json(200, { available: true, user: null }));
    expect(await loadAccountState()).toEqual({ status: 'signed-out' });
    answers(json(200, { available: false, user: null }));
    expect(await loadAccountState()).toEqual({ status: 'off', why: 'server' });
  });

  it('asks again while the server is still starting, and gives up quietly', async () => {
    const calls = answers(new Response('', { status: 500 }), new TypeError('Failed to fetch'), json(200, { available: true, user: null }));
    expect(await loadAccountState(3, noWait)).toEqual({ status: 'signed-out' });
    expect(calls).toHaveLength(3);

    const again = answers(new Response('', { status: 500 }), new Response('', { status: 500 }), new Response('', { status: 500 }));
    expect(await loadAccountState(3, noWait)).toEqual({ status: 'off', why: 'unreachable' });
    expect(again).toHaveLength(3);
  });

  it('does not keep asking a server that has no account routes', async () => {
    const calls = answers(new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    expect(await loadAccountState(3, noWait)).toEqual({ status: 'off', why: 'unreachable' });
    expect(calls).toHaveLength(1);
  });
});

describe('naming a browser from its User-Agent', () => {
  it.each([
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0', 'Edge on Windows'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', 'Chrome on Windows'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15', 'Safari on Mac'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0', 'Firefox on Linux'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1', 'Safari on iPhone'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1', 'Chrome on iPhone'],
    ['Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36', 'Chrome on Android'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0', 'Opera on Windows'],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'Chrome on Chromebook'],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36', 'Chrome on Linux'],
    ['curl/8.5.0', 'Unknown device'],
    ['', 'Unknown device'],
  ])('%s', (userAgent, expected) => {
    expect(describeDevice(userAgent)).toBe(expected);
  });
});
