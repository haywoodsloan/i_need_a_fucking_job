// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrackerError, trackerApi, trackerErrorText } from './client';
import { loadTrackerState } from './TrackerProvider';

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
const sent = (call: { init: RequestInit }) => JSON.parse(call.init.body as string);

afterEach(() => vi.unstubAllGlobals());

const SUMMARY = { id: 'globex-staff-technical-writer', revision: 2, title: 'Staff Technical Writer', company: 'Globex', postingUrl: 'https://example.com/jobs/1', stage: 'drafting', stageSetBy: 'assistant', createdAt: '2026-11-24T15:00:00.000Z', updatedAt: '2026-11-24T16:00:00.000Z', fields: 3, asks: 1, drafts: 1, yours: 1 };

describe('calls to the tracker', () => {
  it("go to the page's own address as JSON, and say that the user is making the change", async () => {
    const calls = answers(json(200, { available: true, applications: [] }), json(200, { application: {} }), json(201, { application: {}, existed: false }), json(200, { application: {} }), json(200, {}), json(200, { added: [], skipped: [] }));

    await trackerApi.list();
    expect(calls[0].url).toBe('/api/applications');
    expect(calls[0].init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    expect(calls[0].init.body).toBeUndefined();

    await trackerApi.get('globex-staff-technical-writer');
    expect(calls[1].url).toBe('/api/applications/globex-staff-technical-writer');

    await trackerApi.add({ job: { title: 'Staff Technical Writer' } });
    expect(calls[2].url).toBe('/api/applications');
    expect(calls[2].init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(sent(calls[2])).toEqual({ by: 'user', application: { job: { title: 'Staff Technical Writer' } } });

    await trackerApi.change('globex-staff-technical-writer', { stage: 'ready' }, 4);
    expect(calls[3].url).toBe('/api/applications/globex-staff-technical-writer');
    expect(sent(calls[3])).toEqual({ by: 'user', revision: 4, changes: { stage: 'ready' } });

    await trackerApi.remove('globex-staff-technical-writer');
    expect(calls[4].url).toBe('/api/applications/globex-staff-technical-writer/remove');
    expect(sent(calls[4])).toEqual({ by: 'user' });

    await trackerApi.importFile({ format: 'job-hunt-applications', version: 1, applications: [] });
    expect(calls[5].url).toBe('/api/applications/import');
    expect(sent(calls[5])).toEqual({ by: 'user', file: { format: 'job-hunt-applications', version: 1, applications: [] } });
  });

  it('leave the revision out unless one is given, so that a change is not tied to what the page last read', async () => {
    const calls = answers(json(200, { application: {} }));
    await trackerApi.change('initech', { note: 'Called them.' });
    expect(sent(calls[0])).toEqual({ by: 'user', changes: { note: 'Called them.' } });
  });

  it("turn the server's refusal into an error that carries its sentence and code", async () => {
    answers(json(400, { error: 'job.postingUrl is not a web address.', code: 'invalid' }));
    const failed = await trackerApi.add({}).catch((e) => e);
    expect(failed).toBeInstanceOf(TrackerError);
    expect(failed).toMatchObject({ code: 'invalid', status: 400, message: 'job.postingUrl is not a web address.' });
    expect(trackerErrorText(failed)).toBe('job.postingUrl is not a web address.');

    // An application that changed in the meantime comes back with the refusal.
    answers(json(409, { error: 'This application changed since it was read.', code: 'changed', application: { id: 'initech', revision: 5 } }));
    expect(await trackerApi.change('initech', {}, 4).catch((e) => e)).toMatchObject({ code: 'changed', status: 409, application: { id: 'initech', revision: 5 } });
  });

  it('treat anything that is not an answer from the tracker as unreachable', async () => {
    // The request never got through.
    answers(new TypeError('Failed to fetch'));
    expect(await trackerApi.list().catch((e) => e)).toMatchObject({ code: 'unreachable', status: 0, message: 'The server could not be reached. Check that it is running, then try again.' });
    // A dev server with no backend behind it answers with the app's own page.
    answers(new Response('<!doctype html><html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    expect(await trackerApi.list().catch((e) => e)).toMatchObject({ code: 'unreachable', status: 200 });
    // A proxy whose backend is down.
    answers(new Response('', { status: 502 }));
    expect(await trackerApi.list().catch((e) => e)).toMatchObject({ code: 'unreachable', status: 502 });
    // JSON, but not from the tracker.
    answers(json(404, { error: 'Not found' }));
    expect(await trackerApi.list().catch((e) => e)).toMatchObject({ code: 'unreachable', status: 404 });
    answers(new Response('{"broken', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    expect(await trackerApi.list().catch((e) => e)).toMatchObject({ code: 'unreachable', status: 200 });
  });

  it('have one sentence for a failure that is not the tracker’s own', () => {
    expect(trackerErrorText(new Error('boom'))).toBe('Something went wrong. Try again.');
  });
});

describe('finding out whether there is a tracker', () => {
  const noWait = async () => {};

  it('reports the applications, or that the server keeps none', async () => {
    answers(json(200, { available: true, applications: [SUMMARY], unreadable: [{ file: 'broken.json', why: 'It is not valid JSON.' }] }));
    expect(await loadTrackerState()).toEqual({ status: 'on', applications: [SUMMARY], unreadable: [{ file: 'broken.json', why: 'It is not valid JSON.' }] });
    answers(json(200, { available: true, applications: [] }));
    expect(await loadTrackerState()).toEqual({ status: 'on', applications: [], unreadable: [] });
    answers(json(200, { available: false, applications: [] }));
    expect(await loadTrackerState()).toEqual({ status: 'off', why: 'server' });
  });

  it('asks again while the server is still starting, and gives up quietly', async () => {
    const calls = answers(new Response('', { status: 500 }), new TypeError('Failed to fetch'), json(200, { available: true, applications: [] }));
    expect(await loadTrackerState(3, noWait)).toEqual({ status: 'on', applications: [], unreadable: [] });
    expect(calls).toHaveLength(3);

    const again = answers(new Response('', { status: 500 }), new Response('', { status: 500 }), new Response('', { status: 500 }));
    expect(await loadTrackerState(3, noWait)).toEqual({ status: 'off', why: 'unreachable' });
    expect(again).toHaveLength(3);
  });

  it('does not keep asking a server that has no tracker routes, or one that turns this page away', async () => {
    const calls = answers(new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    expect(await loadTrackerState(3, noWait)).toEqual({ status: 'off', why: 'unreachable' });
    expect(calls).toHaveLength(1);

    const refused = answers(json(403, { error: 'Applications are kept on the computer the server runs on.', code: 'not_local' }));
    expect(await loadTrackerState(3, noWait)).toEqual({ status: 'off', why: 'unreachable' });
    expect(refused).toHaveLength(1);
  });
});

describe('whether a copy of the app looks for a tracker at all', () => {
  /** That is settled once, when the module loads, so each case loads it afresh. */
  async function load(o: { dev: boolean; serverSaysSo?: boolean }) {
    vi.resetModules();
    vi.stubEnv('DEV', o.dev);
    document.head.innerHTML = o.serverSaysSo ? '<meta name="job-hunt-applications" content="on" />' : '';
    return import('./client');
  }

  afterEach(() => {
    document.head.innerHTML = '';
  });

  it('does in local development, where the dev server passes the question on to the backend', async () => {
    expect((await load({ dev: true })).TRACKER_ENABLED).toBe(true);
  });

  it('does when the server that served the page says it keeps applications', async () => {
    expect((await load({ dev: false, serverSaysSo: true })).TRACKER_ENABLED).toBe(true);
  });

  it('does not on a static host, and not on a server that keeps none', async () => {
    expect((await load({ dev: false })).TRACKER_ENABLED).toBe(false);
  });
});
